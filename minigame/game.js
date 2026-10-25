/**
 * 《凑一桌》原生微信小游戏入口
 *
 * 不引引擎：全部界面是 canvas 手绘（见 js/ui.js），
 * 依赖单向向下：game.js → app.js → { ui, api, audio, recorder, config }
 */
const { App } = require('./js/app')

new App()
