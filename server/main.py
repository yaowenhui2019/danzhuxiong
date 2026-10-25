"""
《凑一桌》后端 —— FastAPI 单进程

跑起来：
    python -m server.main

职责边界：路由、入参校验、异常映射、静态音频、会话表。
游戏规则一律在 engine.py，语音能力一律在 voice.py。
"""
from __future__ import annotations

import asyncio
import logging
import os
import socket
import tempfile
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import ai, engine, voice

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("api")

MAX_UPLOAD_BYTES = 8 * 1024 * 1024      # 录音上限 8MB，约 60s mp3
MAX_GAMES = 200                          # 内存里最多保留的牌局数，防泄漏


@asynccontextmanager
async def lifespan(_app: FastAPI):
    async def boot():
        # 两件事都放后台：预热慢（whisper 载模型 + 12 段 TTS），不能挡住端口就绪
        await voice.prewarm_narrator()
        voice.sweep_cache()
        await voice.warmup()

    asyncio.create_task(boot())
    log.info("启动完成 | LLM=%s | ASR=%s", ai.LLM_MODEL if ai.HAS_LLM else "模板兜底",
             voice.asr_provider())
    yield


app = FastAPI(title="凑一桌 · 语音狼人杀", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/audio", StaticFiles(directory=voice.AUDIO_DIR), name="audio")

GAMES: dict[str, engine.Game] = {}

# 演示环境可关：RATE_LIMIT_PER_MIN=0
_RATE_LIMIT = int(os.getenv("RATE_LIMIT_PER_MIN", "120"))
_hits: dict[str, list[float]] = {}


def _rate_ok(ip: str) -> bool:
    if _RATE_LIMIT <= 0:
        return True
    now = time.time()
    # 顺手清掉整分钟没动静的 IP，否则 _hits 会随访问量无限增长
    if len(_hits) > 2048:
        for k in [k for k, v in _hits.items() if not v or now - v[-1] > 120]:
            _hits.pop(k, None)
    window = [t for t in _hits.get(ip, []) if now - t < 60]
    if len(window) >= _RATE_LIMIT:
        _hits[ip] = window
        return False
    window.append(now)
    _hits[ip] = window
    return True


@app.middleware("http")
async def limit(request: Request, call_next):
    if request.url.path.startswith("/api/"):
        ip = (request.client.host if request.client else "?") or "?"
        if not _rate_ok(ip):
            return JSONResponse({"error": "请求太频繁，歇一下"}, status_code=429)
    return await call_next(request)


def _gc_games() -> None:
    """牌局只活在内存里，超量时丢最早的，避免长时间运行后无限增长。"""
    while len(GAMES) > MAX_GAMES:
        GAMES.pop(next(iter(GAMES)))


# ---------------- 基础能力 ----------------

class TTSReq(BaseModel):
    text: str = Field(min_length=1, max_length=300)
    voice: str = "narrator"


@app.post("/api/tts")
async def tts(req: TTSReq):
    name = await voice.synth(req.text, req.voice)
    if not name:
        return JSONResponse({"error": "语音合成失败"}, status_code=503)
    return {"url": f"/audio/{name}"}


@app.post("/api/asr")
async def asr(file: UploadFile = File(...)):
    suffix = os.path.splitext(file.filename or "a.mp3")[1].lower() or ".mp3"
    if suffix not in {".mp3", ".wav", ".m4a", ".aac", ".pcm", ".silk", ".ogg"}:
        suffix = ".mp3"

    raw = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(raw) > MAX_UPLOAD_BYTES:
        return JSONResponse({"error": "录音太大"}, status_code=413)
    if not raw:
        return JSONResponse({"error": "空录音"}, status_code=400)

    fd, path = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
        started = time.time()
        text = await voice.transcribe(path)
        log.info("asr cost=%.0fms chars=%d", (time.time() - started) * 1000, len(text))
        return {"text": text}
    except Exception as e:
        log.exception("asr failed")
        return JSONResponse({"error": f"识别失败：{e}"}, status_code=503)
    finally:
        # 隐私：转写完立刻删，不留用户声音
        for p in (path,):
            if os.path.exists(p):
                try:
                    os.remove(p)
                except OSError:
                    pass


@app.get("/api/health")
async def health():
    return {
        "ok": True,
        "llm": ai.HAS_LLM,
        "model": ai.LLM_MODEL if ai.HAS_LLM else "fallback",
        "asr": voice.asr_provider(),
        "games": len(GAMES),
    }


# ---------------- 游戏 ----------------

class StartReq(BaseModel):
    role: str | None = None      # 调试用：wolf / seer / villager


@app.post("/api/game/start")
async def game_start(req: StartReq):
    role = req.role if req.role in engine.ROLE_NAMES else None
    gid = uuid.uuid4().hex[:8]
    g = engine.Game.new(gid, human_role=role)
    GAMES[gid] = g
    _gc_games()
    log.info("[%s] start role=%s phase=%s", gid, g.human.role, g.phase)
    return await g.start()


class ActReq(BaseModel):
    game_id: str
    action: str
    target: int | None = None
    text: str | None = None


@app.post("/api/game/act")
async def game_act(req: ActReq):
    g = GAMES.get(req.game_id)
    if not g:
        return JSONResponse({"error": "牌局不存在或已过期"}, status_code=404)

    started = time.time()
    try:
        out = await g.act(req.action, target=req.target, text=req.text)
        log.info("[%s] action=%-10s phase=%-10s cost=%.0fms",
                 req.game_id, req.action, g.phase, (time.time() - started) * 1000)
        return out
    except engine.GameError as e:
        return JSONResponse({"error": str(e), "state": g.public_state()}, status_code=400)
    except Exception as e:
        log.exception("[%s] action=%s 崩了", req.game_id, req.action)
        return JSONResponse({"error": f"服务端异常：{e}"}, status_code=500)


# ---------------- 启动 ----------------

def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8000"))
    print(f"\n  本地:   http://127.0.0.1:{port}")
    print(f"  真机:   http://{lan_ip()}:{port}   （小游戏 config.js 填这个）")
    print(f"  LLM:    {'已接入 ' + ai.LLM_MODEL if ai.HAS_LLM else '未配置 → 使用本地兜底大脑'}")
    print(f"  ASR:    {voice.asr_provider()}")
    print(f"  TTS:    edge-tts（{len(voice.VOICES)} 个音色）\n")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")
