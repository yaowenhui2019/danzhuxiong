"""
AI 玩家的大脑

优先走 OpenAI 兼容接口（七牛 LLM 网关 / DeepSeek / 任意兼容服务），
没配 key 或调用失败时退化为本地模板大脑，保证 demo 永远有人说话。

模板大脑不是"随便说一句"——按 5 个座位各自的性格派发口癖，
否则离线演示会变成 5 个复读机，这是这一层唯一的价值点。
"""
from __future__ import annotations

import asyncio
import logging
import os
import random

import httpx

log = logging.getLogger("ai")

LLM_BASE_URL = os.getenv("LLM_BASE_URL", "").rstrip("/")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_MODEL = os.getenv("LLM_MODEL", "deepseek-v3")

HAS_LLM = bool(LLM_BASE_URL and LLM_API_KEY)

_TIMEOUT = float(os.getenv("LLM_TIMEOUT", "25"))


async def chat(system: str, user: str, temperature: float = 0.95,
               max_tokens: int = 180, retries: int = 1) -> str:
    """调一次 chat/completions。失败抛异常，由 engine 兜底到模板。"""
    if not HAS_LLM:
        return ""
    url = f"{LLM_BASE_URL}/chat/completions"
    payload = {
        "model": LLM_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    headers = {"Authorization": f"Bearer {LLM_API_KEY}"}

    last_err: Exception | None = None
    for attempt in range(retries + 1):
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                r = await client.post(url, json=payload, headers=headers)
                r.raise_for_status()
                return (r.json()["choices"][0]["message"]["content"] or "").strip()
        except Exception as e:          # 超时 / 5xx / 空 choices
            last_err = e
            if attempt < retries:
                await asyncio.sleep(0.4)
    log.warning("LLM 调用失败，落模板：%s", last_err)
    raise RuntimeError(f"LLM 调用失败: {last_err}")


# ---------------- 离线兜底大脑 ----------------
#
# 按座位音色派发，保证「逻辑流 / 情绪流 / 和事佬 / 阴阳怪气 / 话少刀狠」五条线
# 即使没有 LLM 也能听出差别。

_LINES: dict[str, dict[str, list[str]]] = {
    # 老张 · 逻辑流
    "p1": {
        "accuse": [
            "我盘一下。{t} 号是最后一个表态的，前面一句话不说，等风向明了才跟票，这不是好人打法。",
            "{t} 号刚才说他没动机，可他从头到尾没给过一个明确判断。光活着不表态，这就是保命位。",
            "按票型推：{t} 号一直在附和大家，谁被怀疑他就跟着踩谁。太顺了，顺得不像好人。",
            "{t} 号，你回答一个具体问题——昨晚你第一个怀疑的是谁？说不出来我就投你。",
        ],
        "defend": [
            "我第一轮就给了判断，狼不会这么早站边。你们看我票型，我从没改过口。",
            "说我划水我认，但我没害人。真要投我，先想清楚明天谁给你们盘。",
            "我怀疑 {t} 号，理由说过了。你们不跟可以，但别把票散掉。",
        ],
        "vague": ["我先听一轮，现在信息不够，硬编理由反而是狼的行为。"],
    },
    # 阿May · 情绪流
    "p2": {
        "accuse": [
            "我不管，我就是觉得 {t} 号有问题！他刚才说话那个语气，太假了。",
            "{t} 号你别装了！你刚才一直在看我，是不是想刀我？我先把话说死，我投你。",
            "凭什么怀疑我啊？我要是狼我至于这么急着解释吗？倒是 {t} 号，一句话都不接。",
            "{t} 号你说话呀！每次到你就“先听听”，你听什么听？",
        ],
        "defend": [
            "我真不是狼！你们要投我可以，投完这局就结束了，你们自己看着办。",
            "我急是因为我冤！我第一轮就表态了，狼会这么刚吗？",
            "行，{t} 号你咬我，那我也咬你。我今天票就压你身上了。",
        ],
        "vague": ["我先不说了，说着说着又要被当成狼，烦死了。"],
    },
    # 大熊 · 和事佬
    "p3": {
        "accuse": [
            "大家别急，先听我说一句。{t} 号我不是针对你啊，但你刚才那段确实有点绕。",
            "咱们冷静一下。我倾向投 {t} 号，但不是因为他像狼，是因为他话太少，这局没法排除。",
            "我说个中间话：{t} 号和 {x} 号互相咬，我看 {t} 号更急一点。我先站 {t} 号。",
        ],
        "defend": [
            "你们怀疑我，我理解。但把我投出去对好人没好处，我今天真没打算跟谁对着干。",
            "别都冲我来，我们票别散。我建议大家先集火一个人，不然平票了狼最高兴。",
            "我承认我说话软，但软不是狼。真狼比我会装，你们看 {t} 号。",
        ],
        "vague": ["我先听听后面人怎么说，别急着定人。"],
    },
    # 小七 · 阴阳怪气
    "p4": {
        "accuse": [
            "哦是吗，{t} 号这波分析真精彩，精彩到我一听就知道他在保自己。",
            "有意思。{t} 号从头到尾没说一句有用的话，居然还敢质疑别人，勇气可嘉。",
            "我投 {t} 号。理由？他太努力了，努力得像在演。",
            "{t} 号，你这套说辞练过吧？下次换个剧本。",
        ],
        "defend": [
            "投我？可以啊，反正你们哪次投对过。",
            "我阴阳怪气是因为我看得清。倒是某些人，一脸正气得让人想吐。",
            "行啊 {t} 号，你咬我，那我就把票给你，公平吧？",
        ],
        "vague": ["我没什么想说的，看你们表演。"],
    },
    # 老K · 话少刀狠
    "p5": {
        "accuse": [
            "{t} 号，狼。票他。",
            "{t} 号话太多，全是废话。出他。",
            "我只看一点：{t} 号没接过任何人的质疑。出他。",
        ],
        "defend": [
            "我不是。投我你们输。",
            "我话少，但不傻。票给 {t} 号。",
        ],
        "vague": ["过。"],
    },
}

# 拿不到座位音色时的通用池
_GENERIC = {
    "accuse": [
        "我怀疑 {t} 号。他整场都在附和，没有一次主动给判断。",
        "{t} 号，你刚才说不记得谁死了？可公布死者的时候你明明有反应。",
        "我给个反推：如果我是狼，我不会在这个位置把 {t} 号推出去，太扎眼。",
    ],
    "defend": [
        "投我可以，但请想清楚：把我投出去，明天你们靠谁找狼？",
        "我第一轮就表态了，狼不会这么早站边。",
        "{t} 号说我划水，我认。但我没害人。",
    ],
    "vague": ["这局信息太少，我先站中间。"],
}

_SEER_CLAIM = [
    "我是预言家。昨晚我验了 {t} 号，是狼。今天不出他，明天就来不及了。",
    "别急，我预言家。{t} 号是狼，我拿命担保，信我的跟票。",
]


def fallback_line(role: str, persona: str, targets: list[int],
                  alive_ids: list[int], voice: str = "") -> str:
    """没有 LLM 时的兜底发言。按角色选语气、按座位选口癖。"""
    others = [i for i in targets if i in alive_ids] or alive_ids or [1]
    t = random.choice(others)
    rest = [i for i in others if i != t] or [t]
    x = random.choice(rest)

    # 预言家有一定概率直接跳身份报验人，这是最有信息量的发言
    if role == "seer" and random.random() < 0.6:
        return random.choice(_SEER_CLAIM).format(t=t)

    pool = _LINES.get(voice, _GENERIC)
    if role == "wolf":
        key = "accuse" if random.random() < 0.75 else "defend"
    else:
        key = "accuse" if random.random() < 0.65 else "defend"

    if random.random() < 0.12:
        key = "vague"

    line = random.choice(pool.get(key) or _GENERIC[key])
    return line.format(t=t, x=x)
