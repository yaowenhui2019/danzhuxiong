const { BASE_URL } = require('./config')

/**
 * 单例播放器。
 *
 * 三个必须做对的地方（都是会卡死流水线的坑）：
 * 1. 复用同一个 InnerAudioContext，每次只改 src —— 每段新建会泄漏句柄
 * 2. onEnded 和 onError 走同一个 _finish，播放失败也要让流水线往下走
 * 3. 加看门狗：某些机型文件损坏时不触发 onEnded 也不触发 onError，
 *    按文本长度估一个超时，到点强制 finish
 */
class Player {
  constructor() {
    this.ctx = wx.createInnerAudioContext()
    this.ctx.obeyMuteSwitch = false
    this.ctx.volume = 1
    this._done = null
    this._timer = null
    this.ctx.onEnded(() => this._finish('ended'))
    this.ctx.onError((e) => {
      console.warn('[audio] error', e)
      this._finish('error')
    })
  }

  _finish(reason) {
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    const cb = this._done
    this._done = null
    if (cb) cb(reason)
  }

  play(path, onEnd, estimateMs) {
    if (!path) {
      if (onEnd) onEnd('skip')
      return
    }
    this.stop()
    this._done = onEnd || null
    this.ctx.src = path.indexOf('http') === 0 ? path : BASE_URL + path

    // 看门狗：估算时长 + 4s 余量
    const wait = Math.max(4000, (estimateMs || 4000) + 4000)
    this._timer = setTimeout(() => {
      console.warn('[audio] 看门狗触发，强制推进')
      this._finish('timeout')
    }, wait)

    this.ctx.play()
  }

  stop() {
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    this._done = null
    try { this.ctx.stop() } catch (e) { /* 未播放时 stop 会报错，忽略 */ }
  }

  destroy() {
    this.stop()
    try { this.ctx.destroy() } catch (e) { /* ignore */ }
  }
}

module.exports = { Player }
