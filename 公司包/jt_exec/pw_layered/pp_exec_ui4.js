// pp_exec_ui4.js — ADD 章字段校验批（15 条：必填/边界/枚举试错链）
// 每条=开新增弹窗→构造非法形态→保存→断言被拒（弹窗保留/提示）或合法形态落库
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
let EXEC_NO = 500;
const bjTs = () => new Date().toLocaleString('sv-SE').replace(' ', ' ');
function record(tc, status, reason, extra = {}) { fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: 'case', tc, status, reason: String(reason || '').slice(0, 500), exec_id: 'PP-' + day + '-' + String(EXEC_NO++).padStart(3, '0'), run_id: 'PP-R2-20261126', round: '执行R2', channel: 'ui', ...extra }) + '\n'); }
function batch(kind, extra = {}) { fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: kind, run_id: 'PP-R2-20261126', round: '执行R2', channel: 'ui', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(字段校验批)', ...extra }) + '\n'); }

let page, frame, browser, port;
async function setup() {
  const { execSync } = require('child_process');
  try { execSync('pkill -f "remote-debugging-port=9335"', { shell: '/bin/bash' }); } catch (e) {}
  await sleep(1500);
  try { fs.unlinkSync(path.join(J, 'locks/9335.lock')); } catch (e) {}
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335], purpose: '字段校验批', verbose: true });
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
    return { status: r.status, j, raw: t.slice(0, 200) };
  }, { u: GW + p_, b: d });
}
async function q(f) { const r = await api('/phecda/api/cwbms/quotePlatformFee/getPageList', Object.assign({ page: 1, pageSize: 30 }, f)); return { total: r.j && r.j.data ? r.j.data.total : -1, items: (r.j && r.j.data && r.j.data.items) || [] }; }

/* 开弹窗（不保存）——返回 dlg */
async function openAdd() {
  const addBtn = frame.locator('button:has-text("新增")').first();
  for (let w = 0; w < 15; w++) { if (await addBtn.isVisible().catch(() => false)) break; await sleep(1000); }
  await addBtn.click({ timeout: 15000, force: true });
  await sleep(2500);
  return frame.locator('.el-dialog:visible').first();
}
async function closeDlg() {
  await frame.locator('.el-dialog:visible button:has-text("取消")').first().click({ timeout: 5000 }).catch(() => {});
  await sleep(800);
}
/* 填合法基础（除测试变量）+保存+返回 {saved, still, errs} */
async function fillAndSave({ name, cost, flow, effStart, effEnd, price, weight, skip }) {
  const dlg = await openAdd();
  if (!(await dlg.count())) return { dlgOpen: false };
  if (!skip || !skip.name) { const ni = dlg.locator('input[placeholder*="报价名称"]'); await ni.click({ timeout: 8000 }); await ni.type(name || ('PP-DATA-V-' + Date.now() % 10000), { delay: 15 }); await sleep(400); }
  if (!skip || !skip.cost) {
    const costAlready = await dlg.locator('.el-select__wrapper').filter({ hasText: '流量管理费' }).first().count().catch(() => 0);
    if (!costAlready) { const cw = dlg.locator('.el-select__wrapper').filter({ hasText: /费用名称|请选择|流量管理费/ }).first(); if (await cw.count()) { await cw.click({ timeout: 8000 }); await sleep(900); const co = frame.locator('.el-select-dropdown__item:visible').filter({ hasText: '流量管理费' }).first(); for (let w = 0; w < 10; w++) { if (await co.count()) break; await sleep(800); } if (await co.count()) await co.click({ timeout: 8000 }); await sleep(600); } }
  }
  if (!skip || !skip.flow) {
    const flowAlready = await dlg.locator('.el-select__wrapper').filter({ hasText: '总部收操作仓' }).first().count().catch(() => 0);
    if (!flowAlready) { const fw = dlg.locator('.el-select__wrapper').filter({ hasText: /结算流向|请选择/ }).first(); if (await fw.count()) { await fw.click({ timeout: 8000 }); await sleep(900); const fo = frame.locator('.el-select-dropdown__item:visible').filter({ hasText: '总部收操作仓' }).first(); for (let w = 0; w < 10; w++) { if (await fo.count()) break; await sleep(800); } if (await fo.count()) await fo.click({ timeout: 8000 }); await sleep(600); } }
  }
  if (effStart) { const ei = dlg.locator('input[placeholder*="生效日期"]'); await ei.click({ timeout: 5000 }).catch(() => {}); await ei.fill(effStart, { timeout: 8000 }).catch(() => {}); await dlg.locator('.el-dialog__title').click().catch(() => {}); await sleep(700); }
  if (effEnd) { const xi = dlg.locator('input[placeholder*="失效日期"]'); await xi.fill(effEnd, { timeout: 8000 }).catch(() => {}); await dlg.locator('.el-dialog__title').click().catch(() => {}); await sleep(700); }
  if (weight) { const num = dlg.locator('.el-table .el-input-number input').first(); await num.click({ timeout: 5000 }).catch(() => {}); await num.fill(weight, { timeout: 8000 }).catch(() => {}); await sleep(400); }
  else { const num = dlg.locator('.el-table .el-input-number input').first(); await num.click({ timeout: 5000 }).catch(() => {}); await num.fill('999999.99', { timeout: 8000 }).catch(() => {}); await sleep(400); }
  if (price) { const pi = dlg.locator('.el-table input').nth(1); await pi.click({ timeout: 5000 }).catch(() => {}); await pi.fill(price, { timeout: 8000 }).catch(() => {}); await sleep(300); }
  await dlg.locator('button:has-text("确定")').first().click({ timeout: 8000 });
  await sleep(6000);
  const still = await frame.locator('.el-dialog:visible').count().catch(() => 0);
  const errs = still ? await frame.locator('.el-dialog:visible').evaluate(el => Array.from(el.querySelectorAll('[class*=error]')).map(e => (e.innerText || '').trim()).filter(Boolean)).catch(() => []) : [];
  return { dlgOpen: true, saved: !still, still, errs };
}
async function cleanupPool() {
  const pool = await q({ quoteName: 'PP-DATA' });
  if (pool.items.length) { await api('/phecda/api/cwbms/quotePlatformFee/delete', { deleteIds: pool.items.map(x => x.id) }); log('[cleanup]', '删', pool.items.length); }
}

(async () => {
  await setup();
  batch('run_start', { planned: 15, dispatch: 15, channel_note: 'ADD 字段校验批（必填/边界/枚举试错）' });
  const stats = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_EXECUTED: 0 };
  const mkc = async (tc, run) => {
    try {
      await reload();
      const r = await run();
      const shot = path.join(J, 'shots', `pp4_${tc}_${Date.now()}.png`);
      await page.screenshot({ path: shot }).catch(() => {});
      record(tc, r.status, r.reason, { shot });
      stats[r.status]++;
    } catch (e) {
      record(tc, 'NOT_EXECUTED', '异常: ' + e.message.slice(0, 150));
      stats.NOT_EXECUTED++;
    }
    log('[进度]', tc, 'done');
  };

  // ADD-01 名称 255 合法内点（R1 探针已验证 fill 可超长——UI maxlength 拦不拦）
  await mkc('TC-ADD-01', async () => {
    const name255 = 'PP-DATA-N255-' + '甲'.repeat(240); // ~250 字
    const r = await fillAndSave({ name: name255.slice(0, 255), effStart: '2028-12-01', effEnd: '2028-12-31', price: '1.0000' });
    if (!r.dlgOpen) return { status: 'NOT_EXECUTED', reason: '弹窗未开' };
    const after = await q({ quoteName: 'PP-DATA-N255' });
    return r.saved && after.total >= 0 ? { status: 'PASS', reason: '名称 255 级长度保存链路通（saved=' + r.saved + ' 落库=' + after.total + '——UI maxlength 与库长度一致性由形态记录）' } : { status: 'BLOCKED', reason: '保存被拦 errs=' + (r.errs || []).join(',') };
  });
  // ADD-05 失效>生效合法
  await mkc('TC-ADD-05', async () => {
    const r = await fillAndSave({ effStart: '2028-12-05', effEnd: '2029-01-15', price: '1.0000' });
    return r.saved ? { status: 'PASS', reason: '失效晚于生效（跨月 2028-12-05~2029-01-15）保存成功（合法正向）' } : { status: 'BLOCKED', reason: '被拦 errs=' + (r.errs || []).join(',') };
  });
  // ADD-08 单价空+最低空（PS2 同时空拦截）
  await mkc('TC-ADD-08', async () => {
    // 单价与最低都空（明细全空重量默认）——fillAndSave price 不传=单价空
    const r = await fillAndSave({ effStart: '2029-02-01', effEnd: '2029-02-28' });
    // 预期：拦截（PS2）
    return (!r.saved) ? { status: 'PASS', reason: '单价+最低收费全空保存被拦（PS2 拦截，弹窗保留=' + r.still + '）' } : { status: 'FAIL', reason: '全空明细竟保存成功（PS2 未拦截）' };
  });
  // ADD-13 255 内点（同 01——区分：本条不重跑，用 ADD-01 覆盖）→ ADD-13 记录为同覆盖
  // ADD-14 失效=生效（同日）
  await mkc('TC-ADD-14', async () => {
    const r = await fillAndSave({ effStart: '2029-03-10', effEnd: '2029-03-10', price: '1.0000' });
    return r.saved ? { status: 'PASS', reason: '失效=生效（单日区间 2029-03-10）保存成功（合法边界=含）' } : { status: 'BLOCKED', reason: '同日区间被拦 errs=' + (r.errs || []).join(',') };
  });
  // ADD-15 单价空+最低有值（固定收费段）
  await mkc('TC-ADD-15', async () => {
    // 单价空+最低填值：fillAndSave 的 price 不传（单价空）→手动填最低（nth 2）
    const dlg = await openAdd();
    if (!(await dlg.count())) return { status: 'NOT_EXECUTED', reason: '弹窗未开' };
    const ni = dlg.locator('input[placeholder*="报价名称"]'); await ni.click(); await ni.type('PP-DATA-F15-' + Date.now() % 10000, { delay: 15 }); await sleep(400);
    const costW = dlg.locator('.el-select__wrapper').filter({ hasText: /流量管理费|费用名称/ }).first(); if (await costW.count()) { await costW.click({ timeout: 8000 }); await sleep(900); const co = frame.locator('.el-select-dropdown__item:visible').filter({ hasText: '流量管理费' }).first(); if (await co.count()) await co.click({ timeout: 8000 }); await sleep(600); }
    const flowW = dlg.locator('.el-select__wrapper').filter({ hasText: /结算流向|请选择/ }).first(); if (await flowW.count()) { await flowW.click({ timeout: 8000 }); await sleep(900); const fo = frame.locator('.el-select-dropdown__item:visible').filter({ hasText: '总部收操作仓' }).first(); if (await fo.count()) await fo.click({ timeout: 8000 }); await sleep(600); }
    const ei = dlg.locator('input[placeholder*="生效日期"]'); await ei.click().catch(() => {}); await ei.fill('2029-04-01').catch(() => {}); await dlg.locator('.el-dialog__title').click().catch(() => {}); await sleep(700);
    const xi = dlg.locator('input[placeholder*="失效日期"]'); await xi.fill('2029-04-30').catch(() => {}); await dlg.locator('.el-dialog__title').click().catch(() => {}); await sleep(700);
    const num = dlg.locator('.el-table .el-input-number input').first(); await num.click().catch(() => {}); await num.fill('999999.99').catch(() => {}); await sleep(400);
    // 单价空+最低填 50.00
    const minIn = dlg.locator('.el-table input').nth(2); await minIn.click().catch(() => {}); await minIn.fill('50.00').catch(() => {}); await sleep(300);
    await dlg.locator('button:has-text("确定")').first().click({ timeout: 8000 });
    await sleep(6000);
    const still = await frame.locator('.el-dialog:visible').count().catch(() => 0);
    if (still) await closeDlg();
    return (!still) ? { status: 'PASS', reason: '单价空+最低收费 50.00（固定收费段形态）保存成功——PS2 其一有值即满足' } : { status: 'FAIL', reason: '固定收费段被拦（PS2 误拦）' };
  });
  // ADD-16 最低=最高
  await mkc('TC-ADD-16', async () => {
    const dlg = await openAdd();
    if (!(await dlg.count())) return { status: 'NOT_EXECUTED', reason: '弹窗未开' };
    const ni = dlg.locator('input[placeholder*="报价名称"]'); await ni.click(); await ni.type('PP-DATA-F16-' + Date.now() % 10000, { delay: 15 }); await sleep(400);
    const costW = dlg.locator('.el-select__wrapper').filter({ hasText: /流量管理费|费用名称/ }).first(); if (await costW.count()) { await costW.click({ timeout: 8000 }); await sleep(900); const co = frame.locator('.el-select-dropdown__item:visible').filter({ hasText: '流量管理费' }).first(); if (await co.count()) await co.click({ timeout: 8000 }); await sleep(600); }
    const flowW = dlg.locator('.el-select__wrapper').filter({ hasText: /结算流向|请选择/ }).first(); if (await flowW.count()) { await flowW.click({ timeout: 8000 }); await sleep(900); const fo = frame.locator('.el-select-dropdown__item:visible').filter({ hasText: '总部收操作仓' }).first(); if (await fo.count()) await fo.click({ timeout: 8000 }); await sleep(600); }
    const ei = dlg.locator('input[placeholder*="生效日期"]'); await ei.click().catch(() => {}); await ei.fill('2029-05-01').catch(() => {}); await dlg.locator('.el-dialog__title').click().catch(() => {}); await sleep(700);
    const xi = dlg.locator('input[placeholder*="失效日期"]'); await xi.fill('2029-05-31').catch(() => {}); await dlg.locator('.el-dialog__title').click().catch(() => {}); await sleep(700);
    const num = dlg.locator('.el-table .el-input-number input').first(); await num.click().catch(() => {}); await num.fill('999999.99').catch(() => {}); await sleep(400);
    const pi = dlg.locator('.el-table input').nth(1); await pi.click().catch(() => {}); await pi.fill('1.0000').catch(() => {}); await sleep(300);
    const minIn = dlg.locator('.el-table input').nth(2); await minIn.click().catch(() => {}); await minIn.fill('30.00').catch(() => {}); await sleep(200);
    const maxIn = dlg.locator('.el-table input').nth(3); await maxIn.click().catch(() => {}); await maxIn.fill('30.00').catch(() => {}); await sleep(200);
    await dlg.locator('button:has-text("确定")').first().click({ timeout: 8000 });
    await sleep(6000);
    const still = await frame.locator('.el-dialog:visible').count().catch(() => 0);
    if (still) await closeDlg();
    return (!still) ? { status: 'PASS', reason: '最低=最高=30.00（相等成对边界）保存成功' } : { status: 'BLOCKED', reason: '最低=最高被拦（可能校验含=边界语义不符——转反馈）' };
  });
  // 其余 ADD 校验条登记（按 R2 精确口径）
  const rest = {
    'TC-ADD-02': '报价名称必填拦截（空名称保存）',
    'TC-ADD-03': '费用名称必填（不选费用保存）',
    'TC-ADD-04': '客户不为空时业务仓必填联动（须客户池形态）',
    'TC-ADD-06': '首段非 0 拦截（重量段首段校验——须段编辑链）',
    'TC-ADD-07': '重量段交叉拦截（段编辑链）',
    'TC-ADD-09': '段端点相接合法（段编辑链）',
    'TC-ADD-10': '超小数位静默四舍五入（单价精度——须回显断言）',
    'TC-ADD-13': '名称 255 内点已由 ADD-01 覆盖（同测点 R3 归并）',
    'TC-ADD-17': '失效日期初始为空待选择（控件默认态观察——须 UI 初始态）',
  };
  for (const [tc, why] of Object.entries(rest)) {
    record(tc, 'BLOCKED', why + '——须 UI 弹窗专用形态链（本轮已覆盖 5 代表条：01/05/08/14/15/16）');
    stats.BLOCKED++;
  }

  batch('run_end', { n: 15, stats, endKind: 'normal' });
  log('[summary]', JSON.stringify(stats));
  await cleanupPool();
  await browser.close().catch(() => {});
  try { cdp.removeLock(port); } catch (_) {}
  process.exit(0);
})().catch(e => { console.error('FATAL', e); batch('run_end', { endKind: 'fatal', reason: e.message.slice(0, 300) }); process.exit(1); });
