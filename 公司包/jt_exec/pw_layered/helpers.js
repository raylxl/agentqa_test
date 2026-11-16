/**
 * 兼容壳（2026-11-09 跨菜单泛化重构）：helpers = 框架公共层 lib/jt_common + 货量配方层 modules/huoliang
 * 现存 spec / 工厂 / diag 脚本 require('./helpers') 零改动；新菜单请 require 自己的 modules/<菜单>.js + lib/jt_common
 */
module.exports = { ...require('./lib/jt_common'), ...require('./modules/huoliang') };
