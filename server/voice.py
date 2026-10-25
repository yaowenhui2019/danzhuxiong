"""
语音层 —— TTS / ASR 的 Provider 抽象

三层降级：
- **TTS**：edge-tts（本地，免费，8 个 zh-CN 音色）→ 失败则该句只显文字不播报
- **ASR**：灵矽设备协议（配了 LINX_TOKEN 才启用）→ faster-whisper（本地兜底）

为什么 TTS 不走灵矽：灵矽下行音频只给 Opus，且没有单向合成接口
（详见 linx.py 顶部注释）。客户端 `InnerAudioContext` 只吃 mp3，硬接要额外解码，
收益不抵成本，因此 A2 明确不做。

上层只用两个函数：`await synth()` / `await transcribe()`，切换实现改环境变量即可。
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import shutil
import subprocess
import threading
import time

import edge_tts

from . import linx

log = logging.getLogger("voice")

AUDIO_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "audio")
os.makedirs(AUDIO_DIR, exist_ok=True)

# 音色表：上帝 + 5 个 AI 玩家，各不相同（edge-tts 的 zh-CN 音色）
VOICES = {
    "narrator": "zh-CN-YunjianNeural",   # 低沉男声，法官
    "p1": "zh-CN-YunxiNeural",           # 青年男声 —— 老张（逻辑流）
    "p2": "zh-CN-XiaoxiaoNeural",        # 温柔女声 —— 阿May（情绪流）
    "p3": "zh-CN-YunyangNeural",         # 播音男声 —— 大熊（和事佬）
    "p4": "zh-CN-XiaoyiNeural",          # 少女声   —— 小七（阴阳怪气）
    "p5": "zh-CN-YunxiaNeural",          # 少年声   —— 老K（话少刀狠）
}

# 每个 AI 的语速，把「人格」也做进声音里
VOICE_RATES = {
    "narrator": "+0%",
    "p1": "-4%",      # 老张：稳
    "p2": "+14%",     # 阿May：急
    "p3": "-2%",      # 大熊：慢悠悠
    "p4": "+6%",      # 小七：轻佻
    "p5": "-8%",      # 老K：压着说
}

_synth_sem = asyncio.Semaphore(4)

# TTS 缓存保留时长。上帝固定台词跨局复用命中率高，但玩家台词几乎不重复，
# 不清的话 audio/ 会一直涨（每局 10+ 段 mp3）。
CACHE_TTL_HOURS = float(os.getenv("TTS_CACHE_TTL_HOURS", "24"))


def sweep_cache() -> None:
    ttl = CACHE_TTL_HOURS * 3600
    if ttl <= 0:
        return
    now = time.time()
    dropped = 0
    try:
        for fn in os.listdir(AUDIO_DIR):
            if not fn.endswith(".mp3"):
                continue
            p = os.path.join(AUDIO_DIR, fn)
            try:
                if now - os.path.getmtime(p) > ttl:
                    os.remove(p)
                    dropped += 1
            except OSError:
                continue
    except OSError:
        return
    if dropped:
        log.info("清理过期 TTS 缓存 %d 个", dropped)


# ---------------- TTS ----------------

def _cache_key(text: str, voice: str, rate: str) -> str:
    return hashlib.md5(f"{voice}|{rate}|{text}".encode("utf-8")).hexdigest()[:16]


async def _edge_synth(text: str, voice_key: str) -> str | None:
    voice = VOICES.get(voice_key, voice_key)
    rate = VOICE_RATES.get(voice_key, "+0%")
    name = f"{_cache_key(text, voice, rate)}.mp3"
    path = os.path.join(AUDIO_DIR, name)

    if os.path.exists(path) and os.path.getsize(path) > 0:
        return name

    # 文件名由内容哈希决定，并发重复命中同一文件只会浪费一次合成，不会写坏；
    # 用信号量限流即可，不需要维护 per-file 锁（那样锁字典会无限增长）。
    async with _synth_sem:
        if os.path.exists(path) and os.path.getsize(path) > 0:
            return name

        # 先写临时文件再原子改名，避免客户端拿到半截文件
        tmp = f"{path}.{os.getpid()}.{time.time_ns()}.tmp"
        last_err: Exception | None = None
        for attempt in range(3):
            try:
                comm = edge_tts.Communicate(text, voice, rate=rate)
                await comm.save(tmp)
                if os.path.getsize(tmp) > 0:
                    os.replace(tmp, path)
                    return name
                last_err = RuntimeError("空音频")
            except Exception as e:          # 网络抖动 / 音色不可用
                last_err = e
                await asyncio.sleep(0.3 * (attempt + 1))
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        log.warning("TTS 失败 key=%s text=%.20s err=%s", voice_key, text, last_err)
        return None


async def synth(text: str, voice_key: str = "narrator") -> str | None:
    """合成语音，返回文件名（拼 `/audio/` 即 URL）。失败返回 None，调用方只显文字。"""
    text = (text or "").strip()
    if not text:
        return None
    return await _edge_synth(text, voice_key)


# ---------------- ASR ----------------

_whisper = None
_whisper_lock = threading.Lock()


def _get_whisper():
    global _whisper
    with _whisper_lock:
        if _whisper is None:
            from faster_whisper import WhisperModel
            size = os.getenv("WHISPER_MODEL", "small")
            _whisper = WhisperModel(size, device="cpu", compute_type="int8")
            log.info("whisper 模型已加载: %s", size)
        return _whisper


def _decode_to_float32(path: str):
    """用 ffmpeg 把任意音频解成 16k 单声道 float32，直接喂给 whisper。

    为什么不把路径丢给 faster-whisper：它内部用 PyAV 解码，而 PyAV 19
    删掉了 `metadata_errors` 参数，faster-whisper 传了 → TypeError，整条 ASR 挂掉
    （实测报错 `open() got an unexpected keyword argument 'metadata_errors'`）。
    自己解码还顺带支持了 silk/m4a 这些 av 不认的格式。
    """
    exe = shutil.which("ffmpeg")
    if not exe:
        return path                     # 没 ffmpeg 就退回原路径，让 whisper 自己解
    cmd = [
        exe, "-v", "error", "-i", path, "-t", "120",
        "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", "16000", "-",
    ]
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=120)
    except subprocess.TimeoutExpired:
        return path
    if p.returncode != 0 or not p.stdout:
        return path
    import numpy as np
    return np.frombuffer(p.stdout, dtype=np.int16).astype("float32") / 32768.0


def _whisper_transcribe(path: str) -> str:
    model = _get_whisper()
    audio = _decode_to_float32(path)
    segments, _info = model.transcribe(
        audio,
        language="zh",
        beam_size=5,
        vad_filter=True,
        initial_prompt="以下是普通话狼人杀游戏发言。",
    )
    return "".join(s.text for s in segments).strip()


_linx_asr: linx.LinxASR | None = None


def asr_provider() -> str:
    return "linx" if linx.available() else "whisper"


async def transcribe(path: str) -> str:
    """录音转文字。灵矽优先（配了 token），失败自动落本地 whisper。"""
    global _linx_asr
    if linx.available():
        if _linx_asr is None:
            _linx_asr = linx.LinxASR()
        try:
            text = await _linx_asr.transcribe(path)
            if text:
                return text
            log.info("灵矽返回空文本，落本地 whisper")
        except Exception as e:
            log.warning("灵矽 ASR 异常，落本地 whisper: %s", e)

    return await asyncio.get_running_loop().run_in_executor(None, _whisper_transcribe, path)


async def warmup() -> None:
    """启动预热：把 whisper 模型提前载入线程池，别让第一句话等 8 秒。"""
    if linx.available():
        log.info("ASR: 灵矽（失败降级 whisper）")
        return
    log.info("ASR: 本地 whisper")
    await asyncio.get_running_loop().run_in_executor(None, _get_whisper)


# 上帝固定台词：启动时就合成好，第一局的开场白直接命中缓存。
# 这是「AI 首句开口 < 2.5s」这条指标的唯一实现方式（LLM 那段无法预生成）。
_PREWARM_LINES = [
    "天黑请闭眼。",
    "狼人请睁眼。",
    "狼人请睁眼，请选择今晚要击杀的玩家。",
    "狼人请闭眼。",
    "预言家请睁眼，请选择你要查验的玩家。",
    "预言家请闭眼。",
    "天亮了。",
    "现在开始发言。",
    "发言结束，请投票。",
    "平票，本轮无人出局。",
    "狼人全部出局，好人阵营获胜。",
    "狼人已经控场，狼人阵营获胜。",
]


async def prewarm_narrator() -> None:
    t0 = time.time()
    results = await asyncio.gather(
        *[synth(t, "narrator") for t in _PREWARM_LINES], return_exceptions=True)
    hit = sum(1 for r in results if isinstance(r, str))
    log.info("上帝台词预热完成 %d/%d，耗时 %.1fs",
             hit, len(_PREWARM_LINES), time.time() - t0)
