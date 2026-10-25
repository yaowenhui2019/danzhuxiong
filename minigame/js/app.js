const api = require('./api')
const { UI } = require('./ui')
const { Player } = require('./audio')
const { Recorder } = require('./recorder')
const { COLOR, SEAT_COLOR } = require('./config')

const SPEECH_GAP = 600     // 自己说完到 AI 接话的停顿，太短会显得抢话

/**
 * 场景路由 + 播放流水线。
 *
 * 播放流水线的核心是「预取一条」：AI 一段话约 6–8 秒，服务端生成下一段要 1.5–2 秒。
 * 在播最后一条音频的同时就把 next 请求发出去，用播放时间盖住生成时间，
 * 段间空档接近 0（技术方案 3.3）。
 */
class App {
  constructor() {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.dpr = info.pixelRatio || 2
    this.W = info.windowWidth
    this.H = info.windowHeight
    const safeTop = (info.safeArea && info.safeArea.top) || info.statusBarHeight || 20

    this.canvas = wx.createCanvas()
    this.canvas.width = this.W * this.dpr
    this.canvas.height = this.H * this.dpr
    const ctx = this.canvas.getContext('2d')
    ctx.scale(this.dpr, this.dpr)

    this.ui = new UI(this.canvas, ctx, this.W, this.H, safeTop)
    this.player = new Player()
    this.recorder = new Recorder()

    this.scene = 'home'
    this.state = null
    this.gid = null
    this.prompt = null
    this.pendingPrompt = null
    this.busy = false
    this.pre = null            // 预取中的 Promise
    this.seq = 0               // 局次，换局时让旧流程自动失效
    this.speakingId = -1
    this.bubble = null
    this.bubbleTimer = null
    this.recording = false
    this.recordSec = 0
    this.toastText = ''
    this.toastAt = 0
    this.review = ''
    this.cardProgress = 0
    this.lastResult = wx.getStorageSync('last_result') || ''
    this.llmOff = false
    this.kbActive = false
    this.kbValue = ''

    this.bindTouch()
    this.bindKeyboard()
    this.checkHealth()
    this.loop()
  }

  // ---------------- 启动自检 ----------------

  checkHealth() {
    api.health().then((h) => {
      this.llmOff = !h.llm
    }).catch(() => {
      this.toast('后端没连上：检查 config.js 的 BASE_URL')
    })
  }

  // ---------------- 主循环 ----------------

  loop() {
    const draw = () => {
      this.render()
      requestAnimationFrame(draw)
    }
    requestAnimationFrame(draw)

    // 录音计时单独跑，绘制里读值，避免每帧 Date.now 抖动
    setInterval(() => {
      this.recordSec = this.recorder.elapsed()
    }, 100)
  }

  render() {
    const v = {
      scene: this.scene,
      state: this.state,
      speakingId: this.speakingId,
      bubble: this.bubble,
      prompt: this.prompt,
      busy: this.busy,
      recording: this.recording,
      recordSec: this.recordSec,
      toast: this.toastText && Date.now() - this.toastAt < 2200 ? this.toastText : '',
      review: this.review,
      cardProgress: this.cardProgress,
      lastResult: this.lastResult,
      llmOff: this.llmOff,
      selectable: this.selectableSeats(),
      youWon: this.youWon(),
    }

    if (this.scene === 'home') this.ui.drawHome(v)
    else if (this.scene === 'over') {
      this.cardProgress += 16
      this.ui.drawOver(v)
    } else this.ui.drawTable(v)
  }

  selectableSeats() {
    if (this.busy || !this.prompt || this.prompt.type !== 'pick_target') return []
    return this.prompt.candidates || []
  }

  youWon() {
    const st = this.state
    if (!st || !st.winner) return false
    return (st.winner === 'wolf') === (st.you.role === 'wolf')
  }

  toast(msg, ms) {
    this.toastText = msg
    this.toastAt = Date.now()
    if (ms) console.log('[toast]', msg)
  }

  // ---------------- 触摸 ----------------

  bindTouch() {
    wx.onTouchStart((e) => {
      const t = e.touches[0]
      if (!t) return
      this.onDown(t.clientX, t.clientY)
    })
    wx.onTouchEnd(() => this.onUp())
    wx.onTouchCancel(() => this.onUp())
  }

  onDown(x, y) {
    if (this.scene === 'home') {
      if (this.ui.hitButton(x, y, this.ui.homeBtn)) this.startGame()
      return
    }

    if (this.scene === 'over') {
      if (this.ui.hitButton(x, y, this.ui.overBtn)) this.startGame()
      return
    }

    // 圆桌
    if (this.recorder.active()) return
    if (this.busy) return

    const p = this.prompt

    if (p && p.type === 'speak' && this.ui.hitMic(x, y)) {
      this.startRecord()
      return
    }
    if (p && p.type === 'speak' && this.ui.hitType(x, y)) {
      this.openKeyboard()
      return
    }
    if (p && p.type === 'pick_target') {
      const seat = this.ui.seatAt(x, y)
      if (seat !== null && p.candidates && p.candidates.indexOf(seat) >= 0) {
        this.pickTarget(seat)
      }
    }
  }

  onUp() {
    // 用 App 层的 recording 判断：录音器 onStart 是异步回调，
    // 用户快速点一下就松手时 recorder.recording 还没置位
    if (this.recording) this.stopRecord()
  }

  // ---------------- 录音 ----------------

  startRecord() {
    this.recording = true
    this.recordSec = 0
    try { wx.vibrateShort({ type: 'light' }) } catch (e) { /* 部分机型不支持 */ }
    this.recorder.start((path, dur, err) => {
      this.recording = false
      this.onRecordDone(path, dur, err)
    })
  }

  stopRecord() {
    this.recorder.stop()
  }

  onRecordDone(path, dur, err) {
    this.recording = false
    if (err) {
      this.toast(err)
      return
    }
    this.busy = true
    this.toast('识别中…')
    api.uploadAudio(path)
      .then((text) => {
        const t = (text || '').trim()
        if (!t) {
          this.toast('没听清，点“打字发言”直接输入')
          this.busy = false
          return null
        }
        return this.submitSpeech(t)
      })
      .catch((e) => {
        this.toast(e.message || '识别失败')
        this.busy = false
      })
  }

  // ---------------- 打字兜底 ----------------

  bindKeyboard() {
    if (!wx.onKeyboardInput) return
    wx.onKeyboardInput((res) => { this.kbValue = res.value })
    wx.onKeyboardConfirm((res) => {
      const text = (res.value || this.kbValue || '').trim()
      this.kbActive = false
      try { wx.hideKeyboard() } catch (e) { /* ignore */ }
      if (text) this.submitSpeech(text)
    })
    wx.onKeyboardComplete(() => { this.kbActive = false })
  }

  openKeyboard() {
    if (!wx.showKeyboard) {
      this.toast('当前环境不支持键盘输入')
      return
    }
    this.kbValue = ''
    this.kbActive = true
    wx.showKeyboard({
      defaultValue: '',
      maxLength: 120,
      multiple: false,
      confirmHold: false,
      confirmType: 'send',
    })
  }

  // ---------------- 交互动作 ----------------

  submitSpeech(text) {
    if (this.submitting) return Promise.resolve()
    const seq = this.seq
    const savedPrompt = this.prompt
    this.submitting = true
    this.prompt = null
    this.busy = true

    // 先把自己的话留在屏幕上，再让 AI 接
    this.setBubble({ text, speaker: 0, kind: 'speech' })

    return new Promise((resolve) => setTimeout(resolve, SPEECH_GAP))
      .then(() => api.act(this.gid, 'speak', { text }))
      .then((resp) => {
        if (seq !== this.seq) return
        return this.consume(resp)
      })
      .catch((e) => {
        if (seq !== this.seq) return
        this.toast(e.message || '提交失败')
        this.busy = false
        this.prompt = savedPrompt          // 服务端没消费这次发言，把麦还回去
        if (e.payload && e.payload.state) this.applyState(e.payload.state)
      })
      .then(() => { this.submitting = false })
  }

  pickTarget(seat) {
    const st = this.state
    if (!st) return
    const action = st.phase === 'night_wolf' ? 'wolf_kill'
      : st.phase === 'night_seer' ? 'seer_check'
        : st.phase === 'day_vote' ? 'vote' : null
    if (!action) return

    const savedPrompt = this.prompt
    this.prompt = null
    this.busy = true
    const seq = this.seq
    api.act(this.gid, action, { target: seat })
      .then((resp) => {
        if (seq !== this.seq) return
        return this.consume(resp)
      })
      .catch((e) => {
        if (seq !== this.seq) return
        this.toast(e.message || '操作失败')
        this.busy = false
        this.prompt = savedPrompt
        if (e.payload && e.payload.state) this.applyState(e.payload.state)
      })
  }

  // ---------------- 开局 / 结束 ----------------

  startGame() {
    this.seq += 1
    const seq = this.seq
    this.player.stop()
    this.pre = null
    this.bubble = null
    this.speakingId = -1
    this.prompt = null
    this.pendingPrompt = null
    this.busy = true
    this.review = ''
    this.cardProgress = 0
    this.scene = 'table'
    this.state = null

    api.start()
      .then((resp) => {
        if (seq !== this.seq) return
        this.gid = resp.state.game_id
        return this.consume(resp)
      })
      .catch((e) => {
        this.toast(e.message || '开局失败')
        this.busy = false
        this.scene = 'home'
      })
  }

  async gotoOver() {
    const seq = this.seq
    this.scene = 'over'
    this.cardProgress = 0
    this.busy = true
    this.prompt = null

    const st = this.state
    this.lastResult = `${st.you.role_name} · ${this.youWon() ? '胜' : '负'}`
    try { wx.setStorageSync('last_result', this.lastResult) } catch (e) { /* ignore */ }

    try {
      const resp = await api.act(this.gid, 'finale')
      if (seq !== this.seq) return
      this.applyState(resp.state)
      this.review = (resp.audios || [])
        .filter((a) => a.kind === 'coach')
        .map((a) => a.text)
        .join(' ')
      for (const clip of resp.audios || []) {
        if (seq !== this.seq) return
        await this.playClip(clip)
      }
    } catch (e) {
      this.toast(e.message || '复盘生成失败')
    }
    this.busy = false
  }

  // ---------------- 播放流水线 ----------------

  applyState(st) {
    if (!st) return
    this.state = st
  }

  setBubble(clip) {
    if (!clip || !clip.text) return
    const color = clip.kind === 'narrator' ? COLOR.accent
      : (SEAT_COLOR[clip.speaker] || COLOR.tableEdge)
    this.bubble = { text: clip.text, color }
  }

  playClip(clip) {
    return new Promise((resolve) => {
      const est = Math.max(1200, (String(clip.text || '').length / 4.4) * 1000)
      this.setBubble(clip)
      this.speakingId = clip.speaker >= 0 ? clip.speaker : -1

      if (!clip.url) {
        // 没有音频（TTS 失败）也要让人看清台词，按阅读时间停一下
        setTimeout(() => {
          this.speakingId = -1
          resolve()
        }, Math.min(4200, est))
        return
      }

      this.player.play(clip.url, () => {
        this.speakingId = -1
        resolve()
      }, est)
    })
  }

  maybePrefetch(resp) {
    if (resp.prompt) return
    if (!this.state || this.state.phase === 'over') return
    if (this.pre) return
    const seq = this.seq
    const p = api.act(this.gid, 'next').then((resp2) => {
      if (seq !== this.seq) throw new Error('stale')
      return resp2
    })
    p.catch(() => {})      // 防止没人 await 时变成 unhandled rejection
    this.pre = p
  }

  async consume(resp) {
    if (!resp) return
    this.applyState(resp.state)
    // 先存着，播完最后一句才交给 UI —— 否则 AI 还在说话时麦克风就亮了，
    // 用户点了也没反应（busy 期间交互被挡），体验上像卡死。
    this.pendingPrompt = resp.prompt || null
    this.prompt = null

    const clips = resp.audios || []
    for (let i = 0; i < clips.length; i++) {
      if (i === clips.length - 1) this.maybePrefetch(resp)
      this.busy = true
      await this.playClip(clips[i])
    }

    if (this.pendingPrompt) {
      this.prompt = this.pendingPrompt
      this.pendingPrompt = null
      this.busy = false
      return
    }
    if (this.state && this.state.phase === 'over') {
      await this.gotoOver()
      return
    }
    await this.continueNext()
  }

  async continueNext() {
    const seq = this.seq
    let resp = null
    try {
      this.busy = true
      resp = this.pre ? await this.pre : await api.act(this.gid, 'next')
    } catch (e) {
      if (seq === this.seq) {
        this.toast(e.message || '连接中断')
        this.busy = false
      }
      return
    } finally {
      this.pre = null
    }
    if (seq !== this.seq) return
    await this.consume(resp)
  }
}

module.exports = { App }
