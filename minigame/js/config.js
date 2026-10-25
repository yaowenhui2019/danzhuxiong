// 后端地址：开发者工具用 127.0.0.1，真机调试改成 Mac 的局域网 IP（后端启动时会打印）
module.exports = {
  BASE_URL: 'http://127.0.0.1:8000',

  // 视觉基调：暗色夜场（深蓝黑 + 暖橙高亮）
  COLOR: {
    bg0: '#0A0E1A',
    bg1: '#151C31',
    table: '#1B2338',
    tableEdge: '#2A3450',
    text: '#E9EDF6',
    sub: '#7C87A0',
    accent: '#F5A623',
    accentDim: '#8A5E14',
    danger: '#D9534F',
    good: '#4A90D9',
    dead: '#3A4155',
  },

  // 座位头像底色，按 id 区分
  SEAT_COLOR: ['#F5A623', '#4A90D9', '#7B68EE', '#3FA96A', '#C75B8A', '#5AA9A3'],
}
