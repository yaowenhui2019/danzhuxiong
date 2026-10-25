const { BASE_URL } = require('./config')

function post(path, data, timeout) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE_URL + path,
      method: 'POST',
      data,
      header: { 'content-type': 'application/json' },
      timeout: timeout || 60000,
      success(res) {
        if (res.statusCode === 200 && res.data && !res.data.error) resolve(res.data)
        else {
          const err = new Error((res.data && res.data.error) || ('HTTP ' + res.statusCode))
          err.status = res.statusCode
          err.payload = res.data
          reject(err)
        }
      },
      fail: (e) => reject(new Error('网络不通：' + (e.errMsg || ''))),
    })
  })
}

function get(path) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE_URL + path,
      method: 'GET',
      timeout: 15000,
      success(res) { resolve(res.data) },
      fail: reject,
    })
  })
}

function uploadAudio(filePath) {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: BASE_URL + '/api/asr',
      filePath,
      name: 'file',
      timeout: 60000,
      success(res) {
        try {
          const d = JSON.parse(res.data)
          if (d.text !== undefined) resolve(d.text)
          else reject(new Error(d.error || '识别失败'))
        } catch (e) { reject(new Error('识别返回异常')) }
      },
      fail: (e) => reject(new Error('上传失败：' + (e.errMsg || ''))),
    })
  })
}

module.exports = {
  start: (role) => post('/api/game/start', { role: role || null }),
  act: (gameId, action, payload) =>
    post('/api/game/act', Object.assign({ game_id: gameId, action }, payload || {})),
  tts: (text, voice) => post('/api/tts', { text, voice: voice || 'narrator' }),
  health: () => get('/api/health'),
  uploadAudio,
  BASE_URL,
}
