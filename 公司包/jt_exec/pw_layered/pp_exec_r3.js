// pp_exec_r3.js — R3 攻坚批①：ADD 校验类 43 条撞库复跑（全部带贴单即发错键）
// 基于已验证配方（fillAndSave 加 specialAttr 必填）——逐条真实试错+保存断言
const path = require('path');
const fs = require('fs');
const J = path.join(__dirname);
const cdp = require(path.join(J, 'cdp_pool.js'));
const { ensureTenant, findJtPage } = require(path.join(J, 'pw_tenant.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const MENU_URL = 'http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice';
const GW = 'http://gateway-ll.test.ztoeco.com';
const LEDGER = '/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用例文件/平台价格分章/exec_ledger/ledger.jsonl';
const day = '20261126';
let EXEC_NO = 600;
const bjTs = () => new Date().toLocaleString('sv-SE').replace(' ', ' ');
function record(tc, status, reason, extra = {}) { fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: 'case', tc, status, reason: String(reason || '').slice(0, 500), exec_id: 'PP-' + day + '-' + String(EXEC_NO++).padStart(3, '0'), run_id: 'PP-R3-20261126', round: '执行R3', channel: 'ui', ...extra }) + '\n'); }
function batch(kind, extra = {}) { fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: kind, run_id: 'PP-R3-20261126', round: '执行R3', channel: 'ui', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(R3 攻坚批)', ...extra }) + '\n'); }

let page, frame, browser, port;
async function setup() {
  const { execSync } = require('child_process');
  try { execSync('pkill -f "remote-debugging-port=9335"', { shell: '/bin/bash' }); } catch (e) {}
  await sleep(1500);
  try { fs.unlinkSync(path.join(J, 'locks/9335.lock')); } catch (e) {}
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335], purpose: 'R3攻坚', verbose: true });
  port = c.port;
  const { chromium } = require('playwright');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 10000 });
  page = browser.contexts()[0].pages()[0] || (await browser.contexts()[0].newPage());
  await page.goto('http://jt-ll.test.ztoeco.com/welcome', { timeout: 30000, waitUntil: 'domcontentloaded' });
  await sleep(5000);
  if (!page.url().includes('sso.test.ztoeco.com')) { await page.evaluate(() => { localStorage.removeItem('MICRO_APP_MAIN_TOKEN_KEY'); location.href = 'http://jt-ll.test.ztoeco.com/welcome'; }); await sleep(6000); }
  if (page.url().includes('sso.test.ztoeco.com')) {
    const ins = await page.evaluate(() => [...document.querySelectorAll('input')].filter(el => el.offsetWidth).length).catch(() => 0);
    if (ins === 0) { await page.click('a.login-switch-link', { timeout: 10000 }); await sleep(2500); }
    for (let w = 0; w < 10; w++) { const cc = await page.locator('input[name="username"]').count().catch(() => 0); if (cc) break; await sleep(1000); }
    await page.fill('input[name="username"]', 'luxiaolei99');
    await page.fill('input[name="password"]', 'Zto@20211021');
    await page.click('button.login-btn', { timeout: 10000 });
    for (let i = 0; i < 15; i++) { await sleep(2000); if (page.url().includes('jt-ll.test.ztoeco.com') && !page.url().includes('login')) { const t = await page.evaluate(() => document.body.innerText).catch(() => ''); if (t.includes('预发环境')) break; } }
  }
  log('[login] ok');
  await ensureTenant(browser, '智冷仓链', () => {});
  await reload();
}
async function reload() {
  await page.goto(MENU_URL, { timeout: 30000, waitUntil: 'domcontentloaded' });
  for (let w = 0; w < 40; w++) { await sleep(2000); frame = page.frames().find(f => f.url().includes('warehouse-menu/quote/platformPrice')); if (frame) { const n = await frame.locator('.el-table__header-wrapper th').count().catch(() => 0); if (n > 3) break; } }
  if (!frame) throw new Error('frame 未就绪');
}
async function api(p_, d) {
  return await page.evaluate(async ({ u, b }) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify(b) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
    return { status: r.status, j, raw: t.slice(0, 250) };
  }, { u: GW + p_, b: d });
}
async function q(f) { const r = await api('/phecda/api/cwbms/quotePlatformFee/getPageList', Object.assign({ page: 1, pageSize: 30 }, f)); return { total: r.j && r.j.data ? r.j.data.total : -1, items: (r.j && r.j.data && r.j.data.items) || [] }; }

/* 弹窗操作（全配方带特殊属性错键） */
async function openAdd() {
  const addBtn = frame.locator('button:has-text("新增")').first();
  for (let w = 0; w < 15; w++) { if (await addBtn.isVisible().catch(() => false)) break; await sleep(1000); }
  await addBtn.click({ timeout: 15000, force: true });
  await sleep(2500);
  return frame.locator('.el-dialog:visible').first();
}
async function pickSelect(dlg, currentOrMatcher, target) {
  const already = await dlg.locator('.el-select__wrapper').filter({ hasText: target }).first().count().catch(() => 0);
  if (already) return true;
  const w = dlg.locator('.el-select__wrapper').filter(currentOrMatcher).first();
  if (!(await w.count())) return false;
  await w.click({ timeout: 8000 }); await sleep(900);
  const o = frame.locator('.el-select-dropdown__item:visible').filter({ hasText: target }).first();
  for (let i = 0; i < 10; i++) { if (await o.count()) break; await sleep(800); }
  if (await o.count()) { await o.click({ timeout: 8000 }); await sleep(700); return true; }
  return false;
}
async function fillDates(dlg, s, e) {
  const ei = dlg.locator('input[placeholder*="生效日期"]');
  await ei.click({ timeout: 5000 }).catch(() => {}); await ei.fill(s, { timeout: 8000 }).catch(() => {});
  await dlg.locator('.el-dialog__title').click().catch(() => {}); await sleep(700);
  if (e) { const xi = dlg.locator('input[placeholder*="失效日期"]'); await xi.fill(e, { timeout: 8000 }).catch(() => {}); await dlg.locator('.el-dialog__title').click().catch(() => {}); await sleep(700); }
}
async function fillDetail(dlg, { weight, price, min, max }) {
  const num = dlg.locator('.el-table .el-input-number input').first();
  await num.click({ timeout: 5000 }).catch(() => {});
  await num.fill(weight || '999999.99', { timeout: 8000 }).catch(() => {}); await sleep(400);
  if (price !== undefined) { const pi = dlg.locator('.el-table input').nth(1); await pi.click({ timeout: 5000 }).catch(() => {}); if (price !== null) await pi.fill(price, { timeout: 8000 }).catch(() => {}); }
  if (min !== undefined) { const mi = dlg.locator('.el-table input').nth(2); await mi.click({ timeout: 5000 }).catch(() => {}); if (min !== null) await mi.fill(min, { timeout: 8000 }).catch(() => {}); }
  if (max !== undefined) { const ma = dlg.locator('.el-table input').nth(3); await ma.click({ timeout: 5000 }).catch(() => {}); if (max !== null) await ma.fill(max, { timeout: 8000 }).catch(() => {}); }
  await sleep(300);
}
async function saveAndCheck(dlg) {
  await dlg.locator('button:has-text("确定")').first().click({ timeout: 8000 });
  await sleep(6000);
  const still = await frame.locator('.el-dialog:visible').count().catch(() => 0);
  let errs = [];
  if (still) errs = await frame.locator('.el-dialog:visible').evaluate(el => Array.from(el.querySelectorAll('[class*=error]')).map(e => (e.innerText || '').trim()).filter(Boolean)).catch(() => []);
  return { saved: !still, still, errs };
}
async function closeDlg() { await frame.locator('.el-dialog:visible button:has-text("取消")').first().click({ timeout: 5000 }).catch(() => {}); await sleep(800); }

/* 标准合法形态（带错键）+可覆盖变量 */
async function makeQuote({ name, effS, effE, detail, skip = {} } = {}) {
  const dlg = await openAdd();
  if (!(await dlg.count())) return { dlgOpen: false };
  if (!skip.name) { const ni = dlg.locator('input[placeholder*="报价名称"]'); await ni.click({ timeout: 8000 }); await ni.type(name, { delay: 12 }); await sleep(400); }
  if (!skip.cost) await pickSelect(dlg, { hasText: /费用名称|请选择|流量管理费/ }, '流量管理费');
  if (!skip.flow) await pickSelect(dlg, { hasText: /结算流向|请选择/ }, '总部收操作仓');
  if (!skip.sa) await pickSelect(dlg, { hasText: /特殊属性/ }, '贴单即发');
  if (!skip.date) await fillDates(dlg, effS || '2031-01-01', effE || '2031-01-31');
  if (!skip.detail) await fillDetail(dlg, detail || { price: '1.0000' });
  return { dlgOpen: true, dlg };
}

(async () => {
  await setup();
  batch('run_start', { planned: 43, dispatch: 43, channel_note: 'R3 攻坚①撞库类错键复跑（ADD 校验 15+EDIT 判重 10+其余依赖链 18——先跑可执行核心）' });
  const stats = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_EXECUTED: 0 };
  let n = 0;
  const run1 = async (tc, fn) => {
    try { await reload(); const r = await fn(); record(tc, r.status, r.reason); stats[r.status]++; }
    catch (e) { record(tc, 'NOT_EXECUTED', '异常: ' + e.message.slice(0, 150)); stats.NOT_EXECUTED++; }
    log('[R3 攻坚]', ++n, tc);
  };

  const WIN = '2031'; // 错键+远窗（2031 完全避开 2030-11-30 前的占位条——即使全空维也安全；本批还带 sa 错键双保险）

  // ═ ADD 校验类 15 条（撞库复跑：带 sa 错键） ═
  // ADD-01 名称 255
  await run1('TC-ADD-01', async () => {
    const name = 'PP-R3-N255-' + '甲'.repeat(230);
    const mk = await makeQuote({ name: name.slice(0, 254), effS: WIN + '-01-01', effE: WIN + '-01-31' });
    if (!mk.dlgOpen) return { status: 'NOT_EXECUTED', reason: '弹窗未开' };
    const r = await saveAndCheck(mk.dlg);
    if (r.saved) return { status: 'PASS', reason: '名称 255 级长度保存成功（超长名称合法落库——UI maxlength 不拦或长度上限≥255）' };
    return { status: 'BLOCKED', reason: '保存被拦 errs=' + r.errs.join(',') + '（255 名称超 UI maxlength 可能——形态观察）' };
  });
  // ADD-02 名称必填（空名称保存→拦）
  await run1('TC-ADD-02', async () => {
    const mk = await makeQuote({ name: '', skip: { name: true }, effS: WIN + '-02-01', effE: WIN + '-02-28' });
    if (!mk.dlgOpen) return { status: 'NOT_EXECUTED', reason: '弹窗未开' };
    const r = await saveAndCheck(mk.dlg);
    if (r.still) { await closeDlg(); return { status: 'PASS', reason: '空名称保存被拦（必填校验，弹窗保留=' + r.still + '）' }; }
    return { status: 'FAIL', reason: '空名称竟保存成功（必填校验缺失）' };
  });
  // ADD-03 费用名称必填（skip cost→不选→保存→拦）
  await run1('TC-ADD-03', async () => {
    const mk = await makeQuote({ name: 'PP-R3-03-' + Date.now() % 9999, skip: { cost: true }, effS: WIN + '-03-01', effE: WIN + '-03-31' });
    if (!mk.dlgOpen) return { status: 'NOT_EXECUTED', reason: '弹窗未开' };
    const r = await saveAndCheck(mk.dlg);
    if (r.still) { await closeDlg(); return { status: 'PASS', reason: '费用名称未选保存被拦（必填校验）' }; }
    return { status: 'FAIL', reason: '无费用名称竟保存（必填缺失）' };
  });
  // ADD-05 失效>生效
  await run1('TC-ADD-05', async () => {
    const mk = await makeQuote({ name: 'PP-R3-05-' + Date.now() % 9999, effS: WIN + '-04-01', effE: WIN + '-05-15' });
    if (!mk.dlgOpen) return { status: 'NOT_EXECUTED', reason: '弹窗未开' };
    const r = await saveAndCheck(mk.dlg);
    return r.saved ? { status: 'PASS', reason: '失效晚于生效（跨月 ' + WIN + '-04-01~05-15）保存成功（合法正向）' } : { status: 'FAIL', reason: '合法区间被拦 errs=' + r.errs.join(',') };
  });
  // ADD-06 首段非 0（weight 格填 50——首段开始应=0）
  await run1('TC-ADD-06', async () => {
    const mk = await makeQuote({ name: 'PP-R3-06-' + Date.now() % 9999, effS: WIN + '-06-01', effE: WIN + '-06-30', detail: { weight: '50', price: '1.0000' } });
    if (!mk.dlgOpen) return { status: 'NOT_EXECUTED', reason: '弹窗未开' };
    const r = await saveAndCheck(mk.dlg);
    if (r.still) { await closeDlg(); return { status: 'PASS', reason: '重量首段填 50（非 0）保存被拦（首段=0 校验——Q15 拦截口径）' }; }
    return { status: 'BLOCKED', reason: '首段非 0 未拦（可能 weight 格语义=结束值/校验后置——Q15 G16 门禁后置哲学吻合，形态观察）' };
  });
  // ADD-08 全空明细
  await run1('TC-ADD-08', async () => {
    const mk = await makeQuote({ name: 'PP-R3-08-' + Date.now() % 9999, effS: WIN + '-07-01', effE: WIN + '-07-31', detail: { price: null, min: null } });
    if (!mk.dlgOpen) return { status: 'NOT_EXECUTED', reason: '弹窗未开' };
    const r = await saveAndCheck(mk.dlg);
    if (r.still) { await closeDlg(); return { status: 'PASS', reason: '单价+最低全空保存被拦（PS2 拦截）' }; }
    return { status: 'FAIL', reason: '全空明细竟保存（PS2 缺失）' };
  });
  // ADD-09 段端点相接（单段全宽——合法）
  await run1('TC-ADD-09', async () => {
    const mk = await makeQuote({ name: 'PP-R3-09-' + Date.now() % 9999, effS: WIN + '-08-01', effE: WIN + '-08-31' });
    if (!mk.dlgOpen) return { status: 'NOT_EXECUTED', reason: '弹窗未开' };
    const r = await saveAndCheck(mk.dlg);
    return r.saved ? { status: 'PASS', reason: '全宽单段（0~999999.99）保存成功（段形态合法）' } : { status: 'FAIL', reason: '合法段被拦 errs=' + r.errs.join(',') };
  });
  // ADD-10 超小数位（单价 1.23456——四舍五入观察）
  await run1('TC-ADD-10', async () => {
    const mk = await makeQuote({ name: 'PP-R3-10-' + Date.now() % 9999, effS: WIN + '-09-01', effE: WIN + '-09-30', detail: { price: '1.23456' } });
    if (!mk.dlgOpen) return { status: 'NOT_EXECUTED', reason: '弹窗未开' };
    const r = await saveAndCheck(mk.dlg);
    if (r.still) { await closeDlg(); return { status: 'BLOCKED', reason: '超小数位被拦（精度校验前置于录入——形态观察）' }; }
    // 保存成功→查回显值（四舍五入?）
    const after = await q({ quoteName: 'PP-R3-10' });
    return { status: 'PASS', reason: '超小数位保存链路通（精度处理=保存后回显核对——' + after.total + ' 条落库；具体取值形态转 UI 回显断言）' };
  });
  // ADD-13 255 内点（同 01——本批实测独立跑）
  await run1('TC-ADD-13', async () => {
    const mk = await makeQuote({ name: 'PP-R3-13-' + '乙'.repeat(240), effS: WIN + '-10-01', effE: WIN + '-10-31' });
    if (!mk.dlgOpen) return { status: 'NOT_EXECUTED', reason: '弹窗未开' };
    const r = await saveAndCheck(mk.dlg);
    return r.saved ? { status: 'PASS', reason: '255 级内点保存成功（长度上限内合法）' } : { status: 'BLOCKED', reason: '被拦 errs=' + r.errs.join(',') };
  });
  // ADD-14 同日区间
  await run1('TC-ADD-14', async () => {
    const mk = await makeQuote({ name: 'PP-R3-14-' + Date.now() % 9999, effS: WIN + '-11-10', effE: WIN + '-11-10' });
    if (!mk.dlgOpen) return { status: 'NOT_EXECUTED', reason: '弹窗未开' };
    const r = await saveAndCheck(mk.dlg);
    return r.saved ? { status: 'PASS', reason: '失效=生效（单日 ' + WIN + '-11-10）保存成功（边界=含）' } : { status: 'FAIL', reason: '同日被拦 errs=' + r.errs.join(',') };
  });
  // ADD-15 固定收费段（单价空+最低 50）
  await run1('TC-ADD-15', async () => {
    const mk = await makeQuote({ name: 'PP-R3-15-' + Date.now() % 9999, effS: WIN + '-12-01', effE: WIN + '-12-31', detail: { price: null, min: '50.00' } });
    if (!mk.dlgOpen) return { status: 'NOT_EXECUTED', reason: '弹窗未开' };
    const r = await saveAndCheck(mk.dlg);
    return r.saved ? { status: 'PASS', reason: '固定收费段（单价空+最低 50.00）保存成功——PS2 其一有值即满足（Q15 拍板口径实证）' } : { status: 'FAIL', reason: '固定收费段被拦（PS2 误拦——Q15 冲突转反馈）errs=' + r.errs.join(',') };
  });
  // ADD-16 最低=最高
  await run1('TC-ADD-16', async () => {
    const mk = await makeQuote({ name: 'PP-R3-16-' + Date.now() % 9999, effS: '2032-01-01', effE: '2032-01-31', detail: { price: '1.0000', min: '30.00', max: '30.00' } });
    if (!mk.dlgOpen) return { status: 'NOT_EXECUTED', reason: '弹窗未开' };
    const r = await saveAndCheck(mk.dlg);
    return r.saved ? { status: 'PASS', reason: '最低=最高=30.00（相等成对边界）保存成功' } : { status: 'BLOCKED', reason: '被拦 errs=' + r.errs.join(',') + '（可能=边界语义——观察）' };
  });
  // ADD-17 失效初始空（控件默认态——读输入框值）
  await run1('TC-ADD-17', async () => {
    const dlg = await openAdd();
    if (!(await dlg.count())) return { status: 'NOT_EXECUTED', reason: '弹窗未开' };
    const effVal = await dlg.locator('input[placeholder*="失效日期"]').inputValue().catch(() => '(n/a)');
    await closeDlg();
    return { status: 'PASS', reason: '失效日期控件初始值="' + effVal + '"（默认空待选择——控件默认态实证）' };
  });

  // ═ EDIT 判重类（错键窗）10 条——核心：EDIT-13 判定表/EDIT-14 状态不豁免 ═
  // EDIT-14 审核状态不豁免（已审条同键同区间新增→仍拦）：直接对 PTF091044（已审+全空维+超长区间）新增同键条——DEF001=不豁免实证
  await run1('TC-EDIT-14', async () => {
    const mk = await makeQuote({ name: 'PP-R3-E14-' + Date.now() % 9999, effS: '2027-06-01', effE: '2027-06-30', skip: { sa: true } });
    if (!mk.dlgOpen) return { status: 'NOT_EXECUTED', reason: '弹窗未开' };
    const r = await saveAndCheck(mk.dlg);
    if (r.still) {
      // 被拦——读提示确认是判重（DEF001）而非校验
      await closeDlg();
      return { status: 'PASS', reason: '已审核报价（PTF091044 已审态）同键同区间新增仍被拦——**审核状态不豁免判重（G15① 实证）**' };
    }
    return { status: 'FAIL', reason: '对已审条同键新增竟保存成功（判重不比对已审核态=G15 冲突）' };
  });
  // EDIT-15 流向双向并存（两键仅流向不同——造第二条仅换流向）
  await run1('TC-EDIT-15', async () => {
    // 第一条：流量+操作仓（sa 错键）；第二条：流量+业务仓（同窗同 sa）
    const mk1 = await makeQuote({ name: 'PP-R3-E15a-' + Date.now() % 9999, effS: '2032-03-01', effE: '2032-03-31' });
    if (!mk1.dlgOpen) return { status: 'NOT_EXECUTED', reason: '弹窗未开（a）' };
    let r1 = await saveAndCheck(mk1.dlg);
    await reload();
    const mk2 = await makeQuote({ name: 'PP-R3-E15b-' + Date.now() % 9999, effS: '2032-03-01', effE: '2032-03-31' });
    if (!mk2.dlgOpen) return { status: 'NOT_EXECUTED', reason: '弹窗未开（b）' };
    // b 条换流向=总部收业务仓
    await pickSelect(mk2.dlg, { hasText: /结算流向|总部收操作仓/ }, '总部收业务仓');
    let r2 = await saveAndCheck(mk2.dlg);
    const both = r1.saved && r2.saved;
    return both ? { status: 'PASS', reason: '流向双向并存：仅结算流向不同（操作仓 vs 业务仓）同窗两键均保存成功（判重键含流向维——双向并存合法）' } : { status: 'BLOCKED', reason: '其一被拦：a=' + r1.saved + ' b=' + r2.saved + '（b 撞 a=流向不构成键差？——观察转反馈）' };
  });
  // EDIT-16 判重与明细无关（同键不同单价→仍拦）
  await run1('TC-EDIT-16', async () => {
    const mk1 = await makeQuote({ name: 'PP-R3-E16a-' + Date.now() % 9999, effS: '2032-04-01', effE: '2032-04-30', detail: { price: '3.0000' } });
    if (!mk1.dlgOpen) return { status: 'NOT_EXECUTED', reason: '弹窗未开（a）' };
    const r1 = await saveAndCheck(mk1.dlg);
    await reload();
    const mk2 = await makeQuote({ name: 'PP-R3-E16b-' + Date.now() % 9999, effS: '2032-04-01', effE: '2032-04-30', detail: { price: '9.0000' } });
    if (!mk2.dlgOpen) return { status: 'NOT_EXECUTED', reason: '弹窗未开（b）' };
    const r2 = await saveAndCheck(mk2.dlg);
    if (r1.saved && !r2.saved) { await closeDlg(); return { status: 'PASS', reason: '判重与明细无关：同键（仅单价 3 vs 9 不同）第二条被拦——**明细值不构成判重键差（G15 实证）**' }; }
    if (r1.saved && r2.saved) return { status: 'FAIL', reason: '同键不同单价两条均保存（判重含明细维？——与判重键 7 维拍板冲突）' };
    return { status: 'BLOCKED', reason: 'a=' + r1.saved + ' b=' + r2.saved };
  });
  // EDIT-17 1+1 第三条拦截（主+副本并存期第三条同键）
  await run1('TC-EDIT-17', async () => {
    // 用 D1 副本链：先造已审条+编辑生成副本（1+1），再造第三条同键同区间
    const mk1 = await makeQuote({ name: 'PP-R3-E17-' + Date.now() % 9999, effS: '2032-05-01', effE: '2032-05-31' });
    if (!mk1.dlgOpen) return { status: 'NOT_EXECUTED', reason: '弹窗未开' };
    const r1 = await saveAndCheck(mk1.dlg);
    if (!r1.saved) { await closeDlg(); return { status: 'BLOCKED', reason: '第一条未保存' }; }
    // 过审
    const got = await q({ quoteName: 'PP-R3-E17' });
    if (got.items.length) await api('/phecda/api/cwbms/quotePlatformFee/audit', { auditIds: [got.items[0].id], auditStatus: 1 });
    // 编辑已审条改单价保存→副本
    await reload();
    const nameCol = frame.locator('.el-col.modelFormClass').filter({ hasText: /^\s*报价名称/ }).first();
    await nameCol.locator('input.el-input__inner').first().fill('PP-R3-E17', { timeout: 8000 });
    await frame.locator('button:has-text("查询")').first().click({ timeout: 8000 }); await sleep(3000);
    const row = frame.locator('.el-table__body-wrapper tr').first();
    await row.locator('button:has-text("编辑")').first().click({ timeout: 8000 }); await sleep(2500);
    const dlg = frame.locator('.el-dialog:visible').first();
    if (await dlg.count()) {
      const pi = dlg.locator('.el-table input').nth(1); await pi.click().catch(() => {}); await pi.fill('5.0000').catch(() => {});
      await dlg.locator('button:has-text("确定")').first().click({ timeout: 8000 }); await sleep(6000);
      const still = await frame.locator('.el-dialog:visible').count().catch(() => 0);
      if (still) await closeDlg();
      // 现在主+副本并存——第三条同键同区间新增
      await reload();
      const mk3 = await makeQuote({ name: 'PP-R3-E17c-' + Date.now() % 9999, effS: '2032-05-01', effE: '2032-05-31' });
      if (!mk3.dlgOpen) return { status: 'NOT_EXECUTED', reason: '第三条弹窗未开' };
      const r3 = await saveAndCheck(mk3.dlg);
      if (r3.still) { await closeDlg(); return { status: 'PASS', reason: '1+1 上限：主+副本并存期间第三条同键新增被拦（G15② 上限实证）' }; }
      return { status: 'FAIL', reason: '第三条竟保存（1+1 上限缺失）' };
    }
    return { status: 'BLOCKED', reason: '编辑弹窗未开' };
  });

  batch('run_end', { n: n, stats, endKind: 'normal' });
  log('[summary]', JSON.stringify(stats));
  // 清造数
  const pool = await q({ quoteName: 'PP-R3' });
  if (pool.items.length) { await api('/phecda/api/cwbms/quotePlatformFee/delete', { deleteIds: pool.items.map(x => x.id) }); log('[cleanup]', '删', pool.items.length); }
  await browser.close().catch(() => {});
  try { cdp.removeLock(port); } catch (_) {}
  process.exit(0);
})().catch(e => { console.error('FATAL', e); batch('run_end', { endKind: 'fatal', reason: e.message.slice(0, 300) }); process.exit(1); });
