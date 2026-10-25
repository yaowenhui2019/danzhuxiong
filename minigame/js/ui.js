const { COLOR, SEAT_COLOR } = require('./config')

const TAU = Math.PI * 2

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

function wrap(ctx, text, maxWidth) {
  const lines = []
  let cur = ''
  for (const ch of String(text || '')) {
    if (ch === '\n') { lines.push(cur); cur = ''; continue }
    const test = cur + ch
    if (ctx.measureText(test).width > maxWidth && cur) {
      lines.push(cur)
      cur = ch
    } else {
      cur = test
    }
  }
  if (cur) lines.push(cur)
  return lines
}

/**
 * 全部界面用 canvas 手绘。
 *
 * 布局分三块：顶部阶段条 / 中部圆桌 / 底部操作区。
 * 座位坐标在 layout() 里一次算好，绘制和点击命中共用同一份，避免两套坐标对不上。
 */
class UI {
  constructor(canvas, ctx, W, H, safeTop) {
    this.canvas = canvas
    this.ctx = ctx
    this.W = W
    this.H = H
    this.safeTop = safeTop || 20
    this.layout()
  }

  layout() {
    const { W, H } = this
    // 5 个 AI 摆在椭圆弧上（左侧 1 号 → 右侧 5 号），自己在下方正中
    const cx = W / 2
    const cy = H * 0.40
    const rx = Math.min(W * 0.37, 150)
    const ry = Math.min(H * 0.155, 110)
    this.seats = {}
    for (let i = 0; i < 5; i++) {
      const t = i / 4
      const ang = Math.PI * (1.14 + t * 0.72)          // 约 205° → 335°
      this.seats[i + 1] = {
        x: cx + rx * Math.cos(ang),
        y: cy + ry * Math.sin(ang),
        r: this.seatRadius(),
      }
    }
    this.seats[0] = { x: cx, y: H * 0.585, r: this.seatRadius() * 1.1 }

    this.mic = { x: cx, y: H - this.safeTop - 92, r: Math.min(W * 0.13, 50) }
    this.typeBtn = { x: cx, y: this.mic.y + this.mic.r + 26, w: 108, h: 34 }
  }

  seatRadius() {
    return Math.max(22, Math.min(this.W * 0.075, 30))
  }

  // ---------------- 命中测试 ----------------

  seatAt(x, y) {
    let best = null
    let bestD = 1e9
    Object.keys(this.seats).forEach((k) => {
      const s = this.seats[k]
      const d = Math.hypot(x - s.x, y - s.y)
      if (d < s.r * 1.45 && d < bestD) { best = Number(k); bestD = d }
    })
    return best
  }

  hitMic(x, y) {
    return Math.hypot(x - this.mic.x, y - this.mic.y) <= this.mic.r * 1.15
  }

  hitType(x, y) {
    const b = this.typeBtn
    return Math.abs(x - b.x) <= b.w / 2 && Math.abs(y - b.y) <= b.h / 2
  }

  hitButton(x, y, btn) {
    return btn && Math.abs(x - btn.x) <= btn.w / 2 && Math.abs(y - btn.y) <= btn.h / 2
  }

  // ---------------- 基础绘制 ----------------

  bg() {
    const g = this.ctx.createLinearGradient(0, 0, 0, this.H)
    g.addColorStop(0, COLOR.bg1)
    g.addColorStop(1, COLOR.bg0)
    this.ctx.fillStyle = g
    this.ctx.fillRect(0, 0, this.W, this.H)

    // 圆桌：一个很淡的椭圆 + 描边
    const { ctx, W, H } = this
    ctx.save()
    ctx.beginPath()
    ctx.ellipse(W / 2, H * 0.405, Math.min(W * 0.44, 176), Math.min(H * 0.24, 170), 0, 0, TAU)
    ctx.fillStyle = COLOR.table
    ctx.globalAlpha = 0.55
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.strokeStyle = COLOR.tableEdge
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.restore()
  }

  text(str, x, y, size, color, align, weight) {
    const { ctx } = this
    ctx.font = `${weight || 'normal'} ${size}px sans-serif`
    ctx.fillStyle = color
    ctx.textAlign = align || 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(str, x, y)
  }

  button(x, y, w, h, label, opts) {
    const { ctx } = this
    const o = opts || {}
    roundRect(ctx, x - w / 2, y - h / 2, w, h, h / 2)
    ctx.fillStyle = o.fill || COLOR.accent
    ctx.globalAlpha = o.disabled ? 0.35 : 1
    ctx.fill()
    ctx.globalAlpha = 1
    if (o.stroke) {
      ctx.strokeStyle = o.stroke
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
    this.text(label, x, y + 1, o.size || 16, o.color || '#0A0E1A', 'center', 'bold')
  }

  // ---------------- 首页 ----------------

  drawHome(v) {
    const { ctx, W, H } = this
    this.bg()

    // 六张小牌做装饰
    ctx.save()
    ctx.globalAlpha = 0.18
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * TAU - Math.PI / 2
      const x = W / 2 + Math.cos(ang) * Math.min(W * 0.3, 120)
      const y = H * 0.32 + Math.sin(ang) * Math.min(W * 0.3, 120)
      ctx.beginPath()
      ctx.arc(x, y, 18, 0, TAU)
      ctx.fillStyle = SEAT_COLOR[i]
      ctx.fill()
    }
    ctx.restore()

    this.text('凑 一 桌', W / 2, H * 0.17, 42, COLOR.text, 'center', 'bold')
    this.text('凑不齐人？手机里给你摆一桌', W / 2, H * 0.225, 15, COLOR.sub)
    this.text('6 人局 · 你是 1 个，AI 是 5 个 · 约 5 分钟', W / 2, H * 0.265, 13, COLOR.sub)

    const btn = { x: W / 2, y: H * 0.5, w: Math.min(W * 0.62, 230), h: 58 }
    this.homeBtn = btn
    this.button(btn.x, btn.y, btn.w, btn.h, '开 局', { size: 20 })

    if (v.lastResult) {
      this.text('上一局：' + v.lastResult, W / 2, H * 0.5 + 58, 13, COLOR.sub)
    }

    // 左下角环境提示
    this.text('按住说话 · 也可打字', W / 2, H - this.safeTop - 34, 12, COLOR.sub)
    if (v.llmOff) {
      this.text('未接入大模型，AI 用本地人格模板说话', W / 2, H - this.safeTop - 14, 11, COLOR.accentDim)
    }
  }

  // ---------------- 圆桌 ----------------

  drawTable(v) {
    const { ctx, W, H } = this
    this.bg()
    const st = v.state
    if (!st) {
      this.text('发牌中…', W / 2, H * 0.45, 16, COLOR.sub)
      return
    }

    this.drawTopBar(v)

    const alive = st.players.filter((p) => p.alive).length
    st.players.forEach((p) => this.drawSeat(p, v))

    // 气泡：统一显示在圆桌中心，不遮挡任何座位
    if (v.bubble && v.bubble.text) {
      this.drawBubble(v.bubble, W / 2, H * 0.405)
    }

    this.drawBottom(v)

    if (v.toast) {
      const tw = Math.min(W * 0.86, ctx.measureText(v.toast).width + 48)
      roundRect(ctx, W / 2 - tw / 2, H * 0.72, tw, 40, 20)
      ctx.fillStyle = 'rgba(0,0,0,0.78)'
      ctx.fill()
      this.text(v.toast, W / 2, H * 0.72 + 20, 14, COLOR.text)
    }

    // 观战模式提示
    if (!st.you.alive && st.phase !== 'over') {
      this.text('你已出局，AI 继续对局', W / 2, H * 0.30, 13, COLOR.danger)
    }
    if (alive <= 0) return
  }

  drawTopBar(v) {
    const { W } = this
    const st = v.state
    const y = this.safeTop + 22

    const phaseName = {
      night_wolf: '天黑了',
      night_seer: '天黑了',
      day_speak: '白天 · 发言',
      day_vote: '白天 · 投票',
      over: '本局结束',
      init: '入座',
    }[st.phase] || st.phase

    this.text(`第 ${st.day} 天  ·  ${phaseName}`, W / 2, y, 15, COLOR.text, 'center', 'bold')

    // 你的身份胶囊
    const roleColor = st.you.role === 'wolf' ? COLOR.danger
      : st.you.role === 'seer' ? COLOR.good : COLOR.sub
    const label = `你：${st.you.role_name}`
    const { ctx } = this
    ctx.font = 'bold 12px sans-serif'
    const w = ctx.measureText(label).width + 22
    roundRect(ctx, W - w - 14, y - 11, w, 22, 11)
    ctx.fillStyle = 'rgba(0,0,0,0.35)'
    ctx.fill()
    ctx.strokeStyle = roleColor
    ctx.lineWidth = 1
    ctx.stroke()
    this.text(label, W - w / 2 - 14, y, 12, roleColor, 'center', 'bold')

    const alive = st.players.filter((p) => p.alive).length
    this.text(`存活 ${alive}/6`, 16, y, 12, COLOR.sub, 'left')
  }

  drawSeat(p, v) {
    const { ctx } = this
    const s = this.seats[p.id]
    if (!s) return
    const isSpeaking = v.speakingId === p.id
    const color = SEAT_COLOR[p.id] || COLOR.sub

    ctx.save()
    if (!p.alive) ctx.globalAlpha = 0.32

    // 高亮光晕
    if (isSpeaking) {
      const g = ctx.createRadialGradient(s.x, s.y, s.r * 0.4, s.x, s.y, s.r * 1.9)
      g.addColorStop(0, 'rgba(245,166,35,0.45)')
      g.addColorStop(1, 'rgba(245,166,35,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(s.x, s.y, s.r * 1.9, 0, TAU)
      ctx.fill()
    }

    // 头像
    ctx.beginPath()
    ctx.arc(s.x, s.y, s.r, 0, TAU)
    ctx.fillStyle = p.alive ? color : COLOR.dead
    ctx.fill()
    if (isSpeaking) {
      ctx.lineWidth = 3
      ctx.strokeStyle = COLOR.accent
      ctx.stroke()
    } else if (p.is_you) {
      ctx.lineWidth = 2
      ctx.strokeStyle = COLOR.accent
      ctx.globalAlpha = 0.6
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    const ch = (p.name || '?').slice(p.is_you ? 0 : 0, 1)
    this.text(ch, s.x, s.y + 1, Math.round(s.r * 0.86),
      p.alive ? '#0A0E1A' : COLOR.sub, 'center', 'bold')

    // 座位号 + 名字
    this.text(`${p.id}号 ${p.name}`, s.x, s.y + s.r + 13, 11,
      p.alive ? COLOR.sub : COLOR.dead)

    // 死者打叉
    if (!p.alive) {
      ctx.strokeStyle = COLOR.danger
      ctx.lineWidth = 2.5
      ctx.globalAlpha = 0.75
      const d = s.r * 0.72
      ctx.beginPath()
      ctx.moveTo(s.x - d, s.y - d)
      ctx.lineTo(s.x + d, s.y + d)
      ctx.moveTo(s.x + d, s.y - d)
      ctx.lineTo(s.x - d, s.y + d)
      ctx.stroke()
    }

    // 可选目标：画一圈虚线圈，告诉玩家这里能点
    if (v.selectable && v.selectable.indexOf(p.id) >= 0) {
      ctx.globalAlpha = 0.9
      ctx.beginPath()
      ctx.arc(s.x, s.y, s.r + 6, 0, TAU)
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = COLOR.accent
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.setLineDash([])
    }
    ctx.restore()
  }

  drawBubble(b, cx, cy) {
    const { ctx, W } = this
    const maxW = Math.min(W * 0.78, 300)
    const pad = 12
    const size = 15
    ctx.font = `${size}px sans-serif`
    const lines = wrap(ctx, b.text, maxW - pad * 2)
    const lh = size + 7
    const w = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2)
    const h = lines.length * lh + pad * 2
    const x = cx - w / 2
    const y = cy - h / 2

    roundRect(ctx, x, y, w, h, 12)
    ctx.fillStyle = 'rgba(10,14,26,0.92)'
    ctx.fill()
    ctx.strokeStyle = b.color || COLOR.tableEdge
    ctx.lineWidth = 1.5
    ctx.stroke()

    lines.forEach((l, i) => {
      this.text(l, cx, y + pad + lh * i + lh / 2, size, COLOR.text)
    })
  }

  drawBottom(v) {
    const { ctx, W } = this
    const st = v.state
    const m = this.mic

    // 观战 / 非本人回合：不显示麦克风
    const canSpeak = v.prompt && v.prompt.type === 'speak' && !v.busy
    const canPick = v.prompt && v.prompt.type === 'pick_target' && !v.busy

    if (v.recording) {
      // 录音态：放大 + 波形 + 倒计时环
      const sec = v.recordSec || 0
      ctx.beginPath()
      ctx.arc(m.x, m.y, m.r + 10, 0, TAU)
      ctx.fillStyle = 'rgba(245,166,35,0.16)'
      ctx.fill()

      // 倒计时环，60 秒上限
      ctx.beginPath()
      ctx.arc(m.x, m.y, m.r + 10, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, sec / 60))
      ctx.strokeStyle = COLOR.accent
      ctx.lineWidth = 4
      ctx.stroke()

      ctx.beginPath()
      ctx.arc(m.x, m.y, m.r, 0, TAU)
      ctx.fillStyle = COLOR.accent
      ctx.fill()

      // 波形
      for (let i = 0; i < 5; i++) {
        const hgt = 10 + Math.abs(Math.sin(sec * 6 + i * 1.2)) * (m.r * 0.9)
        ctx.fillStyle = '#0A0E1A'
        roundRect(ctx, m.x - 22 + i * 11, m.y - hgt / 2, 5, hgt, 2.5)
        ctx.fill()
      }

      this.text(`${sec.toFixed(1)}s  松手提交`, W / 2, m.y + m.r + 44, 13, COLOR.accent)
      return
    }

    ctx.beginPath()
    ctx.arc(m.x, m.y, m.r, 0, TAU)
    ctx.fillStyle = canSpeak ? COLOR.accent : '#242C42'
    ctx.fill()
    ctx.strokeStyle = canSpeak ? COLOR.accent : COLOR.tableEdge
    ctx.lineWidth = 2

    // 麦克风图标（简笔）
    const iconColor = canSpeak ? '#0A0E1A' : COLOR.sub
    ctx.fillStyle = iconColor
    roundRect(ctx, m.x - 6, m.y - 17, 12, 20, 6)
    ctx.fill()
    ctx.strokeStyle = iconColor
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(m.x, m.y - 3, 13, 0.15 * Math.PI, 0.85 * Math.PI)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(m.x, m.y + 10)
    ctx.lineTo(m.x, m.y + 16)
    ctx.stroke()

    if (canSpeak) {
      this.text('按住说话', W / 2, m.y + m.r + 40, 14, COLOR.accent, 'center', 'bold')
      const b = this.typeBtn
      this.button(b.x, b.y, b.w, b.h, '打字发言', { fill: 'transparent', stroke: COLOR.tableEdge, color: COLOR.sub, size: 13 })
    } else if (canPick) {
      this.text(v.prompt.title, W / 2, m.y - 6, 15, COLOR.text, 'center', 'bold')
      this.text(v.prompt.hint, W / 2, m.y + 18, 12, COLOR.sub)
    } else if (v.busy) {
      this.text('AI 正在思考…', W / 2, m.y + 6, 14, COLOR.sub)
    } else if (v.prompt) {
      this.text(v.prompt.title || '', W / 2, m.y + 6, 14, COLOR.text)
    } else if (st.you.alive) {
      this.text('听牌中…', W / 2, m.y + 6, 13, COLOR.sub)
    }
  }

  // ---------------- 战报 ----------------

  drawOver(v) {
    const { ctx, W, H } = this
    this.bg()
    const st = v.state
    if (!st) return

    const won = v.youWon
    this.text(won ? '你 赢 了' : '你 输 了', W / 2, this.safeTop + 46, 30,
      won ? COLOR.accent : COLOR.danger, 'center', 'bold')
    this.text(
      st.winner === 'good' ? '好人阵营获胜' : '狼人阵营获胜',
      W / 2, this.safeTop + 82, 14, COLOR.sub)

    // 6 张身份牌
    const cols = 3
    const gap = 10
    const cw = (W - gap * (cols + 1)) / cols
    const chh = cw * 1.12
    const top = this.safeTop + 108
    st.players.forEach((p, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      const x = gap + col * (cw + gap)
      const y = top + row * (chh + gap)
      this.drawCard(p, x, y, cw, chh, i * 90, v.cardProgress)
    })

    const listBottom = top + 2 * (chh + gap)

    // 战报页在播复盘语音时，把台词也显示出来（否则只听到声音)
    let cursor = listBottom + 12
    if (v.bubble && v.bubble.text) {
      const lines = wrap(ctx, v.bubble.text, W * 0.86)
      lines.slice(0, 3).forEach((l, i) => {
        this.text(l, W / 2, cursor + 8 + i * 17, 13, COLOR.text)
      })
      cursor += 8 + Math.min(3, lines.length) * 17 + 8
    }

    if (v.review) {
      const lines = wrap(ctx, v.review, W * 0.84)
      this.text('AI 教练点评', W / 2, cursor + 8, 12, COLOR.accent)
      lines.slice(0, 3).forEach((l, i) => {
        this.text(l, W / 2, cursor + 26 + i * 18, 13, COLOR.text)
      })
    }

    const btn = { x: W / 2, y: H - this.safeTop - 56, w: Math.min(W * 0.56, 200), h: 48 }
    this.overBtn = btn
    this.button(btn.x, btn.y, btn.w, btn.h, '再来一局', { size: 17 })
  }

  drawCard(p, x, y, w, h, delay, progress) {
    const { ctx } = this
    const t = Math.max(0, Math.min(1, ((progress || 0) - delay) / 260))
    // 未到时间只画牌背
    const color = p.role_name === '狼人' ? COLOR.danger
      : p.role_name === '预言家' ? COLOR.good : COLOR.sub

    roundRect(ctx, x, y, w, h, 10)
    ctx.fillStyle = t > 0.5 ? 'rgba(20,26,44,0.95)' : '#161D30'
    ctx.fill()
    ctx.strokeStyle = t > 0.5 ? color : COLOR.tableEdge
    ctx.lineWidth = t > 0.5 ? 2 : 1
    ctx.stroke()

    if (t > 0.5) {
      ctx.globalAlpha = (t - 0.5) * 2
      this.text(p.role_name || '?', x + w / 2, y + h * 0.42, Math.round(w * 0.19), color, 'center', 'bold')
      this.text(`${p.id}号 ${p.name}`, x + w / 2, y + h * 0.70, 11, COLOR.text)
      ctx.globalAlpha = 1
    } else {
      // 牌背：一个淡淡的对角线
      ctx.strokeStyle = '#242C42'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x + 8, y + 8)
      ctx.lineTo(x + w - 8, y + h - 8)
      ctx.stroke()
    }

    if (p.is_you) {
      this.text('你', x + w - 12, y + 12, 10, COLOR.accent, 'center', 'bold')
    }
    if (!p.alive) {
      ctx.globalAlpha = 0.8
      this.text('出局', x + 16, y + 12, 10, COLOR.danger)
      ctx.globalAlpha = 1
    }
  }
}

module.exports = { UI, roundRect, wrap }
