/**
 * 按住说话 / 松手转文字。
 *
 * 小游戏没有 WebAudio 实时流，RecorderManager 只能整段录 —— 这是平台限制，
 * 也是我们把玩法定成回合制的原因（详见技术方案难点 1）。
 */
const MIN_DURATION = 800     // 短于 0.8s 直接丢弃，避免把呼吸声送去识别

class Recorder {
  constructor() {
    this.rm = wx.getRecorderManager()
    this.recording = false
    this.starting = false       // rm.start() 是异步的，onStart 回调前处于"启动中"
    this._wantStop = false      // 启动中就被要求停止（用户点一下就松手）
    this._onDone = null
    this._startAt = 0

    this.rm.onStart(() => {
      this.starting = false
      this.recording = true
      this._startAt = Date.now()
      if (this._wantStop) {
        this._wantStop = false
        this.rm.stop()
      }
    })

    this.rm.onStop((res) => {
      this.recording = false
      this.starting = false
      const cb = this._onDone
      this._onDone = null
      const dur = Date.now() - this._startAt

      if (!res || !res.tempFilePath) {
        if (cb) cb(null, dur, '没录到声音')
        return
      }
      if (dur < MIN_DURATION) {
        if (cb) cb(null, dur, '太短了，按住多说两句')
        return
      }
      if (cb) cb(res.tempFilePath, dur, null)
    })

    this.rm.onError((e) => {
      this.recording = false
      this.starting = false
      this._wantStop = false
      const cb = this._onDone
      this._onDone = null
      if (cb) cb(null, 0, '录音失败：' + (e.errMsg || '未知错误'))
    })
  }

  start(onDone) {
    if (this.recording || this.starting) return
    this.starting = true
    this._wantStop = false
    this._onDone = onDone
    this._startAt = Date.now()
    this.rm.start({
      duration: 60000,          // 上限 60s，和产品「30–60 秒发言」对齐
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000,
      format: 'mp3',
    })
  }

  active() {
    return this.recording || this.starting
  }

  stop() {
    if (this.starting) {        // 还没真正开始录，标记一下，onStart 时立刻停
      this._wantStop = true
      return
    }
    if (!this.recording) return
    this.rm.stop()
  }

  cancel() {
    this._onDone = null
    this.stop()
  }

  elapsed() {
    return this.recording ? (Date.now() - this._startAt) / 1000 : 0
  }
}

module.exports = { Recorder }
