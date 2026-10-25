# 凑一桌 · 一个人的语音狼人杀

> 七牛第五届 1024 Hackathon · 产研组议题「灵矽应用：语音类游戏」
>
> **凑不齐人？手机里给你摆一桌。** 6 人局，你是 1 个，另外 5 个是有性格、有声线的 AI。你开口，它们接话。

- 产品方案：[`docs/产品方案-凑一桌-v1.md`](docs/产品方案-凑一桌-v1.md)
- 技术方案：[`docs/技术方案-v1.md`](docs/技术方案-v1.md)
- 灵矽接入：[`docs/灵矽接入方案-v1.md`](docs/灵矽接入方案-v1.md)

---

## 目录结构

```
minigame/            原生微信小游戏（不引引擎，全部 canvas 手绘）
├── game.js          入口
├── game.json        小游戏配置
├── project.config.json
└── js/
    ├── app.js       场景路由 + 播放流水线（预取一条）+ 打字兜底
    ├── ui.js        首页 / 圆桌 / 麦克风 HUD / 战报
    ├── api.js       wx.request 封装
    ├── audio.js     InnerAudioContext 单例 + 看门狗
    ├── recorder.js  RecorderManager 按住说话
    └── config.js    BASE_URL 与配色

server/              FastAPI 单进程
├── main.py          API 层：路由、校验、异常映射、限流、静态音频
├── engine.py        游戏引擎：发牌 / 阶段流转 / 发言队列 / 投票 / 胜负
├── ai.py            人格 prompt + LLM 调用 + 本地模板兜底
├── voice.py         TTS/ASR Provider 抽象 + 缓存 + 预热
└── linx.py          灵矽虚拟设备 WSS 客户端（A1：只借 ASR）
```

---

## 快速开始

```sh
# 1. 依赖
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

# 2. 启动（LLM 与灵矽都不是必需的，不配就走本地兜底）
python -m server.main

# 输出：
#   本地:   http://127.0.0.1:8000
#   真机:   http://<局域网IP>:8000
#   LLM:    未配置 → 使用本地兜底大脑
#   ASR:    whisper
#   TTS:    edge-tts（6 个音色）
```

首次启动会在后台预热 12 段上帝固定台词（约 4 秒）并加载 whisper 模型，端口不等它们。

### 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | 否 | OpenAI 兼容网关。不配则 5 个 AI 用本地人格模板说话 |
| `LINX_TOKEN` | 否 | 灵矽 apikey。配了 ASR 走灵矽设备协议，失败自动落 whisper |
| `LINX_AGENT_ID` / `LINX_DEVICE_MAC` | 否 | 虚拟设备绑定的智能体与 MAC |
| `WHISPER_MODEL` | 否 | 默认 `small`；内存紧改 `base` |
| `TTS_CACHE_TTL_HOURS` | 否 | TTS 缓存保留时长，默认 24h，`0` 表示不清 |
| `RATE_LIMIT_PER_MIN` | 否 | 默认 120，`0` 关闭限流 |
| `PORT` | 否 | 默认 8000 |

### 小游戏联调

1. 微信开发者工具导入 `minigame/` 目录，AppID 选「无 AppID / 测试号」
2. 详情 → 本地设置 → 勾选 **不校验合法域名**
3. `minigame/js/config.js` 的 `BASE_URL`：
   - 模拟器：`http://127.0.0.1:8000`
   - 真机：改成后端启动时打印的局域网 IP
4. 真机需开「调试模式」

---

## 语音链路（三级降级）

```
ASR:  灵矽设备协议 (A1)  ──失败──►  faster-whisper (B)
TTS:  edge-tts (B)  ──失败──►  该句只显文字，不播
LLM:  OpenAI 兼容网关  ──失败──►  本地人格模板
```

**为什么 TTS 不走灵矽**：灵矽下行音频只给 Opus，且没有单向合成接口，而小游戏
`InnerAudioContext` 只吃 mp3。硬接要额外解码 + 公网回调地址，收益不抵成本，
所以 A2 明确不做（论证见 `server/linx.py` 顶部与 `docs/灵矽接入方案-v1.md`）。

**为什么 ASR 要先 ffmpeg 解码**：`faster-whisper` 内部用 PyAV 解码，而 PyAV 19
移除了 `metadata_errors` 参数，直接把路径丢给它必然 `TypeError`。现在统一用
ffmpeg 解成 16k 单声道 float32 再喂模型，顺带支持了 silk/m4a。

---

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/game/start` | 开局。`{role?}` 可强制真人身份（调试/演示） |
| POST | `/api/game/act` | 动作。`{game_id, action, target?, text?}` |
| POST | `/api/asr` | 录音转文字，`multipart/form-data`，字段 `file` |
| POST | `/api/tts` | 文本转 mp3，`{text, voice}` |
| GET | `/api/health` | 自检：`{ok, llm, model, asr, games}` |
| GET | `/audio/{md5}.mp3` | 静态音频，文件名由 `md5(voice\|rate\|text)` 决定，天然去重 |

`action` 取值与合法阶段：

| action | 允许的 phase | 说明 |
|---|---|---|
| `wolf_kill` | `night_wolf` | 狼人选择击杀 |
| `seer_check` | `night_seer` | 预言家查验 |
| `next` | `day_speak` | 取下一段 AI 发言（客户端预取用） |
| `speak` | `day_speak` | 提交真人发言（语音转写结果或打字） |
| `vote` | `day_vote` | 投票 |
| `finale` | `over` | 生成战报与 AI 教练点评 |

`target` / `text` 二选一。文本容错支持「我投3号 / 杀四号 / 验一下 5 号 / 3」。

---

## 几个必须守住的约束

- **身份不下发**：`public_state()` 里除自己外 `role_name` 一律为 `null`，死讯也不带角色，只有 `phase === "over"` 才全量揭晓。
- **阶段必须校验**：`engine.act()` 用 `ALLOWED` 表卡住 action 与 phase 的组合，客户端跳不过发言直接投票。
- **真人出局不结束牌局**：转观战自动推进；投票阶段如果真人已死，服务端自己把票投完（否则客户端会永远等一个不存在的 prompt）。
- **prompt 要等音频播完才交给 UI**：否则 AI 还在说话时麦克风就亮了，点了没反应。

---

## 自测

```sh
# 引擎规则（mock TTS，纯逻辑）：三种身份各跑一局 + 边界用例
python .scratch/test_engine.py

# API 端到端（需先启动服务）
python .scratch/test_api.py

# 前端逻辑（Node + wx API shim，真实驱动 app.js 跑完整一局）
node .scratch/test_minigame.js

# 胜率分布（调投票启发式用）
python .scratch/balance.py
```

`.scratch/` 不入库，脚本随开发过程本地保留。
