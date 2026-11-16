/**
 * 接口 spec 模板（复制为 api_specs/<name>.api.spec.js；_pending/ 内为候选基准草稿禁执行——标准 §7.2.5）
 *
 * 模式层复用（不改）：pw_runner.js（--channel api 调度/台账/AX 执行号）· lib/api_channel.js（token 引导会话/三层断言/变量解析）
 *
 * 写法契约（与 UI spec 同构 {id,title,tenant,run}→四态；网络异常=阻塞/断言不符=待复核/全过=通过）：
 *   id       API-{域}-{序号}（转正时定稿；草稿期 API-DRAFT-xxx）
 *   tenant   token 是租户域的——runner 按 tenant 分组各建一个引导会话（G36：先切租户后取 token）
 *   lineage  血缘 {源UI用例, 源步骤号, 菜单, 租户, 采集执行ID}（UI 沉淀必填——总用例库库规四）
 *   vars     变量四类（标准 §5）：固定值=字面量 / 唯一生成=uniq() / 上游产出=前步 exports / 环境注入=runner 注入 env
 *   steps    调用序列；exports 显式映射链内传递（禁"用上一步的结果"模糊表述——标准 §2）
 *   asserts  三层封闭集合（标准 §3）：L1 状态 / L2 结构 / L3 值（数值相等优先；动态字段只断存在且格式合法）
 *   cleanup  链尾清理（场景链在链尾清理——标准 §5 造数纪律）
 *
 * 实例参考：depose_api.js 生成的 _pending/ 草稿（机械转换稿，AI 续作变量归类与基准确认）
 */
const { makeApiSpec, runSteps, uniq } = require('../lib/api_channel');

const META = {
  id: 'API-域-000', title: '接口场景链示例：新增→查详情→清理', tenant: '智冷仓链',
  // lineage: { 源UI用例: 'TC-XX-000', 源步骤号: '2~5', 菜单: 'xx管理', 租户: '智冷仓链', 采集执行ID: 'LX-20xx' },
};

module.exports = makeApiSpec(META, async ({ ctx, log, vars }) => {
  const out = await runSteps({
    steps: [
      {
        name: '新增', method: 'POST', url: '/phecda/xxx/save',
        body: { customerName: '${唯一.名称}', warehouseCode: '${env.仓编码}', remark: 'api回归' },
        asserts: [
          { layer: 'L1' },
          { layer: 'L2', fields: [['data.id', 'string']] },
          { layer: 'L3', path: 'data.status', expect: 1, mode: 'numeric', note: '状态=生效（基准 BL-xx）' },
        ],
        exports: { 单据id: 'data.id' },            // 上游产出→注入后续步骤
      },
      {
        name: '查详情', method: 'POST', url: '/phecda/xxx/detail',
        body: { id: '${单据id}' },
        asserts: [
          { layer: 'L1' },
          { layer: 'L3', path: 'data.customerName', expect: '${唯一.名称}', mode: 'eq', note: '回读一致' },
        ],
      },
    ],
    vars: Object.assign({ 唯一: { 名称: uniq('TEST_API_') } }, vars),  // 唯一生成防污染；env 由 runner 注入
    ctx, log,
  });
  out.cleanup = 'API 造数自清：删除 ${单据id}（链尾清理）';   // 实际清理补一步 DELETE
  return out;
});
