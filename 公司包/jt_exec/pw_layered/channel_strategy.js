/**
 * 通道策略卡（usecase-pipeline 治理 JSON 扩展字段规范 · 2026-11-27 流程优化）
 *
 * 优化点来源：R4 轮 5.4h 攻坚的本质=通道策略中途返工（R2 按"API 优先"定性 64 条须 UI 通道 BLOCKED，
 * 用户拍板"所有用例界面测试"后全部 UI 直测一遍过——中途换通道=全量返工）。
 *
 * 规则：生成段（usecase-generator）写用例时，每条在治理 JSON 登记 channel_hint；
 * 执行计划拍板时用户对通道策略一次性拍板，执行批按策略走，禁中途改判。
 *
 * channel_hint 取值：
 *   ui            —— 交互行为类（弹窗/按钮/勾选/翻页/控件形态），唯一通道=UI
 *   ui_or_api     —— 数据断言类（列表/详情/统计），UI 或 API 皆可（默认 UI 为主）
 *   ui_with_api   —— UI 操作 + API 状态断言组合（如：UI 点驳回 + getPageList 断言 auditStatus）
 *   file          —— 导入/导出文件级（模板+xlsx 构造+文件对账）
 *
 * 治理 JSON 落位：execution_plan.channels = {
 *   default: 'ui' | 'ui_or_api',
 *   per_tc: { 'TC-IMP-01': 'file', 'TC-AUD-04': 'ui_with_api', ... }
 * }
 *
 * 拍板话术（呈报用户）：
 *   「执行通道策略建议：默认全 UI 直测（数据断言用接口复核），导入导出走文件通道。
 *    特殊条：批量审核类=UI 操作+接口断言组合。确认后执行批按此走，不再中途改。」
 */
module.exports = {
  CHANNEL_HINTS: {
    ui: '交互行为类：弹窗/按钮/勾选/翻页/控件形态——UI 唯一通道',
    ui_or_api: '数据断言类：列表/详情/统计——UI 为主，API 可复核',
    ui_with_api: 'UI 操作+API 状态断言组合（UI 做动作，API 验终态）',
    file: '导入/导出文件级：模板构造+上传+文件对账',
  },
  suggestPlan(gov) {
    const tcs = (gov.execution_plan && gov.execution_plan.planned_tc_ids) || [];
    const per = {};
    for (const tc of tcs) {
      if (/^TC-IMP-/.test(tc) || /^TC-EXP-0[35]/.test(tc)) per[tc] = 'file';
      else if (/^TC-(AUD|REJ|DEL|ADD|EDIT|COPY)-/.test(tc)) per[tc] = 'ui_with_api';
      else if (/^TC-(LST|UI)-/.test(tc)) per[tc] = 'ui';
      else per[tc] = 'ui_or_api';
    }
    return { default: 'ui', per_tc: per, note: '默认 UI 直测；写链类=UI 操作+接口终态断言；导入导出=文件通道' };
  },
};
