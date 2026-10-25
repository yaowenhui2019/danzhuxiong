"""
灵矽（linx）虚拟设备客户端 —— A1 方案：只借它的耳朵

灵矽平台没有独立的 ASR HTTP 接口，语音能力只存在于设备 WebSocket 会话内。
本模块在后端伪造一台设备连上去，把用户录音按 PCM 帧喂进去，只为拿回 `stt` 文本。

协议要点（来源：linx.qiniu.com/docs/xrobot → /platform/websocket）：
- 端点 `wss://xrobo-io.qiniuapi.com/v1/ws/`
- Header 需 Authorization / Device-Id / Client-Id / Protocol-Version
- 上行 PCM 16k / 16bit / LE / 单声道，每帧 20ms（320 samples = 640 bytes）
- 下行 TTS 只给 Opus，而我们要给 `InnerAudioContext` 喂 mp3，
  因此 TTS 仍然走本地 edge-tts（见 voice.py）。A2 需要「第三方业务系统接入」
  + 公网回调地址，代价远超收益，本次不做。

设计取舍：
- 单连接复用 + 串行锁。单人局并发是 1，建连（TCP+TLS+握手）约 300ms，
  比每次重连划算；断线后自动重建一次。
- 转码用 ffmpeg 子进程而不是 PyAV：小游戏上传的是 mp3/wav/silk，
  ffmpeg 一行命令搞定，且不占常驻内存。
- 没有任何凭证时 `available()` 返回 False，上层自动落到本地 whisper。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import time
import uuid

import httpx

log = logging.getLogger("linx")

WS_URL = os.getenv("LINX_WS_URL", "wss://xrobo-io.qiniuapi.com/v1/ws/")
API_BASE = os.getenv("LINX_API_BASE", "https://xrobo-io.qiniuapi.com").rstrip("/")
TOKEN = os.getenv("LINX_TOKEN", "").strip()
AGENT_ID = os.getenv("LINX_AGENT_ID", "").strip()
DEVICE_MAC = os.getenv("LINX_DEVICE_MAC", "F2:F1:A8:6A:C4:6B").strip()
CLIENT_ID = os.getenv("LINX_CLIENT_ID", "").strip() or str(uuid.uuid4())

PROTOCOL_VERSION = "1"
SAMPLE_RATE = 16000
FRAME_MS = 20
FRAME_SAMPLES = SAMPLE_RATE // 1000 * FRAME_MS      # 320
FRAME_BYTES = FRAME_SAMPLES * 2                     # 640

# 单次识别上限：超过就截断，避免把一小时的录音灌进去
MAX_AUDIO_SECONDS = 60.0
# 握手 / 识别超时
CONNECT_TIMEOUT = 8.0
ASR_TIMEOUT = 20.0


def available() -> bool:
    """是否配置了灵矽凭证。False 时上层直接走本地 whisper。"""
    return bool(TOKEN)


# ---------------- 音频转码 ----------------

def _ffmpeg_pcm(path: str) -> bytes:
    """任意音频 → PCM 16k/16bit/mono/LE。ffmpeg 缺失时抛 RuntimeError。"""
    exe = shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError("ffmpeg 不在 PATH 中，无法转码给灵矽")
    cmd = [
        exe, "-v", "error", "-i", path,
        "-t", str(MAX_AUDIO_SECONDS),
        "-f", "s16le", "-acodec", "pcm_s16le",
        "-ac", "1", "-ar", str(SAMPLE_RATE),
        "-",
    ]
    p = subprocess.run(cmd, capture_output=True, timeout=MAX_AUDIO_SECONDS + 10)
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg 转码失败: {p.stderr.decode('utf-8', 'ignore')[:200]}")
    return p.stdout


def _frames(pcm: bytes):
    """按 640 字节切帧，末帧补零到整帧（协议要求定长帧）。"""
    for i in range(0, len(pcm), FRAME_BYTES):
        chunk = pcm[i:i + FRAME_BYTES]
        if len(chunk) < FRAME_BYTES:
            chunk = chunk + b"\x00" * (FRAME_BYTES - len(chunk))
        yield chunk


def _extract(payload: dict) -> tuple[str | None, str | None]:
    """从服务端下行报文里抠出 (type, text)。宽容解析，兼容字段变动。"""
    if not isinstance(payload, dict):
        return None, None
    typ = payload.get("type") or payload.get("event")
    if typ == "stt":
        return typ, (payload.get("text") or "").strip()
    return typ, None


class LinxASR:
    """灵矽设备协议 ASR。整个进程共用一个连接。"""

    name = "linx"

    def __init__(self) -> None:
        self._ws = None
        self._session_id: str | None = None
        self._lock = asyncio.Lock()
        self._hello_features = {"mcp": False}

    # ---------- 连接管理 ----------

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {TOKEN}",
            "Device-Id": DEVICE_MAC,
            "Client-Id": CLIENT_ID,
            "Protocol-Version": PROTOCOL_VERSION,
        }

    async def _connect(self) -> None:
        from websockets.asyncio.client import connect

        ws = await asyncio.wait_for(
            connect(WS_URL, additional_headers=self._headers(), max_size=8 * 1024 * 1024),
            timeout=CONNECT_TIMEOUT,
        )
        # 服务端先发 hello，我们回一个 hello，再等服务端确认会话
        first = json.loads(await asyncio.wait_for(ws.recv(), timeout=CONNECT_TIMEOUT))
        self._session_id = first.get("session_id") or first.get("sessionId")

        await ws.send(json.dumps({
            "type": "hello",
            "version": 1,
            "features": self._hello_features,
            "transport": "websocket",
            "audio_params": {
                "format": "pcm",
                "sample_rate": SAMPLE_RATE,
                "channels": 1,
                "bit_depth": 16,
                "endianness": "little",
                "frame_duration": FRAME_MS,
                "frame_size": FRAME_SAMPLES,
                "sample_format": "signed_int16",
                "play_buffer_duration": 1000,
            },
        }))

        # 服务端可能回 hello / 或直接回 ready，两种都接受
        for _ in range(3):
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=CONNECT_TIMEOUT)
            except asyncio.TimeoutError:
                break
            if isinstance(msg, (bytes, bytearray)):
                continue
            data = json.loads(msg)
            if data.get("session_id"):
                self._session_id = data["session_id"]
            if data.get("type") in ("hello", "ready", "session"):
                break

        if not self._session_id:
            raise RuntimeError("灵矽握手未返回 session_id")

        self._ws = ws

    async def _ensure(self) -> None:
        if self._ws is not None:
            return
        await self._connect()

    async def close(self) -> None:
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None
            self._session_id = None

    # ---------- 识别 ----------

    async def transcribe(self, path: str) -> str:
        pcm = await asyncio.get_running_loop().run_in_executor(None, _ffmpeg_pcm, path)
        if not pcm:
            return ""

        async with self._lock:                      # 单连接串行
            for attempt in (0, 1):                  # 断线重连一次
                try:
                    await self._ensure()
                    return await self._recognize(pcm)
                except Exception as e:
                    await self.close()
                    if attempt == 1:
                        raise
                    log.warning("灵矽 ASR 失败，重连重试: %s", e)
        return ""

    async def _recognize(self, pcm: bytes) -> str:
        ws = self._ws
        assert ws is not None
        started = time.time()

        await ws.send(json.dumps({
            "session_id": self._session_id,
            "type": "listen",
            "state": "start",
            "mode": "manual",
        }))

        # 按帧节流发送，模拟真实设备的上行节奏；一次性灌完会触发服务端 VAD 误判
        for frame in _frames(pcm):
            await ws.send(frame)
            await asyncio.sleep(FRAME_MS / 1000)

        await ws.send(json.dumps({
            "session_id": self._session_id,
            "type": "listen",
            "state": "stop",
        }))

        text_parts: list[str] = []
        deadline = started + ASR_TIMEOUT
        while time.time() < deadline:
            remain = max(0.1, deadline - time.time())
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=remain)
            except asyncio.TimeoutError:
                break
            if isinstance(msg, (bytes, bytearray)):
                continue                            # 下行 TTS 的 opus 帧，丢弃
            typ, text = _extract(json.loads(msg))
            if typ == "stt" and text:
                text_parts.append(text)
                # 服务端识别到句末会再发一条空 text 的 stt；等到就收工
            elif typ == "stt" and text_parts:
                break
            elif typ in ("close", "error"):
                break

        log.info("linx asr cost=%.0fms len=%d", (time.time() - started) * 1000, len(pcm))
        return "".join(text_parts).strip()


# ---------------- 设备注册（首次部署用） ----------------

async def preregister(mac: str | None = None, agent_id: str | None = None) -> dict:
    """把一台虚构设备注册到灵矽平台。只在首次部署跑一次，成功后 mac 会被平台记住。"""
    if not TOKEN:
        raise RuntimeError("未配置 LINX_TOKEN")
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            f"{API_BASE}/xiaozhi/device/preregister",
            headers={"Authorization": f"Bearer {TOKEN}"},
            json={
                "agent_id": agent_id or AGENT_ID,
                "mac_addresses": [mac or DEVICE_MAC],
            },
        )
        r.raise_for_status()
        return r.json()
