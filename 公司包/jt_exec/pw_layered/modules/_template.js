/**
 * 新菜单接入模板（复制为 modules/<key>.js，按该菜单 AI 首跑实测填写；未实测前不得进回归池）
 *
 * 一、模式层（直接复用，不改）：
 *   pw_runner.js（四态/台账/证据/实例锁）· cdp_pool.js · pw_login.js · pw_tenant.js
 *   lib/jt_common.js（抽屉开菜单 openMenuViaDrawer / 渲染判定 waitBizRendered / 真实点击 / 浮层驱散）
 *
 * 二、配方层（本文件要填的，契约名固定；货量考核实例见 modules/huoliang.js）：
 *   MODULE          菜单元数据：租户、入口（spa 直连地址 / menu{column,name} 菜单链）、弹窗标识、列表接口
 *   openPage        进入业务页并等就绪：SPA 直连优先；SPA 不稳（坑库 E3）→ lib/jt_common.openMenuViaNav 按栏目树导航（坑库 H1c）
 *   openAddDialog   打开新增/编辑弹窗
 *   posOf           弹窗内按「行名」定位控件中心坐标（可见文案定位，禁硬编码坐标——细则 §四）
 *   closeDialog     关弹窗：「取消」优先，禁 Esc（坑库 G2）
 *   queryByPrefix   列表按造数前缀查询：先点「重置」再填（坑库 H7）
 *   deleteByPrefix  造数自清：单条循环删除 + 数量闸 maxExpect（坑库 H8；工序 1.8 三步校验法）
 *   apiQuery        接口直查入库值（断言用，须在自清前调用）
 *
 * 三、域引擎层：在本模块里包装你的域引擎（弹窗/表单自动化引擎，实现参考你的域层与坑库），
 *     不要重写一套 DOM 配方；el-select 索引序以坑库 Q1 现行序表为准。
 *
 * 四、接入步骤：
 *   ① AI 首跑全册（usecase-executor 工序 1~6，坑库注入）
 *   ② 按首跑实测填本模板 → modules/<key>.js
 *   ③ PASS 条写 spec：只读类可直接套 specs/factory_smoke（channel:'drawer' 通用）；
 *      填表保存类参照 specs/factory_save 的结构写本菜单工厂——现有工厂内联了货量弹窗结构，第二个模块落地时再按两份实测抽公共参数
 *      （不做没有第二个实例验证的空泛抽象）
 *   ④ pw_runner 回归转绿 → 入池；脚本红一律「待复核」回流 AI 定性
 */
const NOT_YET = name => async () => { throw new Error(`modules/_template: ${name} 未接入（按 AI 首跑实测填写后再用）`); };

module.exports = {
  MODULE: { key: 'TODO', name: 'TODO', tenant: 'TODO', entry: { spa: null, menu: { column: 'TODO', name: 'TODO' } }, dialogMarker: 'TODO', listApi: null },
  openPage: NOT_YET('openPage'),
  openAddDialog: NOT_YET('openAddDialog'),
  posOf: NOT_YET('posOf'),
  closeDialog: NOT_YET('closeDialog'),
  queryByPrefix: NOT_YET('queryByPrefix'),
  deleteByPrefix: NOT_YET('deleteByPrefix'),
  apiQuery: NOT_YET('apiQuery'),
};
