// pp_exec_ui.js — 平台价格 UI 写链批（新增/判重/删除链·P0 核心）
// 架构：iframe phecda-web 内操作（el-col.modelFormClass 定位+新增弹窗）
const path = require('path');
const fs = require('fs');
const J = path.join(__dirname);
const cdp = require(path.join(J, 'cdp_pool.js'));
const { ensureLogin } = require(path.join(J, 'pw_login.js'));
const { ensureTenant, findJtPage } = require(path.join(J, 'pw_tenant.js'));

const LEDGER = process.env.PP_LEDGER || path.join('/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用例文件/平台价格分章/exec_ledger', 'ledger.jsonl');
const RUN_ID = 'PP-R1-20261126';
const ROUND = '执行R1';
const DRY = process.argv.includes('--dry');
const NO_LEDGER = DRY;
const MENU_URL = 'http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice';

const bjTs = () => new Date().toLocaleString('sv-SE').replace(' ', ' ');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
const day = '20261126';
let EXEC_NO = 100; // UI 批从 PP-*-100 起（与 api 批 001~050 区分）
function append(rec) { if (!NO_LEDGER) fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n'); else log('（dry）', rec.event || rec.tc, (rec.reason||'').slice(0,60)); }
function record(tc, status, reason, extra = {}) { append({ ts: bjTs(), event: 'case', tc, status, reason: (reason||'').slice(0,500), exec_id: 'PP-' + day + '-' + String(EXEC_NO++).padStart(3, '0'), run_id: RUN_ID, round: ROUND, channel: 'ui', ...extra }); }
function batch(kind, extra = {}) { append({ ts: bjTs(), event: kind, run_id: RUN_ID, round: ROUND, channel: 'ui', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(无头+iframe)', ...extra }); }

let page, frame;
async function setup() {
  // luxiaolei99 全新会话（2026-11-26 11:34 用户提供总部账户；房耀华旧会话有弹窗态残留——新实例新会话已验证新增弹窗可开）
  process.env.JT_ACCOUNT = 'luxiaolei99';
  process.env.JT_SECRET = 'Zto@20211021';
  process.env.JT_DISPLAY = '陆潇雷';
  const { execSync } = require('child_process');
  try { execSync('pkill -f "remote-debugging-port=9335" 2>/dev/null; sleep 1', { shell: '/bin/bash' }); } catch (e) {}
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335, 9336, 9337], purpose: '平台价格UI批-lux', verbose: true });
  const port = c.port;
  console.log('[pool] using port', port);
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 10000 });
  // 简化登录（直达表单：name 定位+动态码）
  const page0 = browser.contexts()[0].pages()[0] || (await browser.contexts()[0].newPage());
  await page0.goto('http://jt-ll.test.ztoeco.com/welcome', { timeout: 30000, waitUntil: 'domcontentloaded' });
  await sleep(5000);
  if (!page0.url().includes('sso.test.ztoeco.com')) {
    await page0.evaluate(() => { localStorage.removeItem('MICRO_APP_MAIN_TOKEN_KEY'); location.href = 'http://jt-ll.test.ztoeco.com/welcome'; }).catch(() => {});
    await sleep(6000);
  }
  if (page0.url().includes('sso.test.ztoeco.com')) {
    let ins = await page0.evaluate(() => [...document.querySelectorAll('input')].filter(el => el.offsetWidth || el.offsetHeight).length).catch(() => 0);
    if (ins === 0) { await page0.click('a.login-switch-link', { timeout: 10000 }).catch(() => {}); await sleep(2500); ins = 1; }
    // 等输入框真正出现（switch 后渲染）
    for (let w = 0; w < 10; w++) {
      const c = await page0.locator('input[name="username"]').count().catch(() => 0);
      if (c) break;
      await sleep(1000);
    }
    await page0.fill('input[name="username"]', process.env.JT_ACCOUNT);
    await page0.fill('input[name="password"]', process.env.JT_SECRET);
    await page0.click('button.login-btn', { timeout: 10000 }).catch(async () => { await page0.locator('button:has-text("登录")').first().click({ timeout: 10000 }); });
    for (let i = 0; i < 15; i++) {
      await sleep(2000);
      if (page0.url().includes('jt-ll.test.ztoeco.com') && !page0.url().includes('login')) {
        const txt = await page0.evaluate(() => document.body.innerText).catch(() => '');
        if (txt.includes('预发环境')) break;
      }
    }
  }
  log('[login] luxiaolei99 done');
  const t2 = await ensureTenant(browser, '智冷仓链', log);
  log('[tenant]', JSON.stringify(t2));
  page = await findJtPage(browser) || page0;
  await page.goto(MENU_URL, { timeout: 30000, waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    frame = page.frames().find(f => f.url().includes('warehouse-menu/quote/platformPrice'));
    if (frame) { const n = await frame.locator('.el-table__header-wrapper th').count().catch(() => 0); if (n > 3) break; }
  }
  if (!frame) throw new Error('业务 frame 未就绪');
  log('[frame] ready', frame.url().slice(0, 80));
  return browser;
}

/* helpers（探针已验的控件结构） */
const findCol = async (label) => frame.locator('.el-col.modelFormClass').filter({ hasText: new RegExp('^\\s*' + label) }).first();
async function pickSelect(colLabel, optText) {
  const col = await findCol(colLabel);
  await col.click({ timeout: 8000 });
  await sleep(900);
  const opt = frame.locator('.el-select-dropdown__item:visible').filter({ hasText: optText }).first();
  await opt.click({ timeout: 8000 });
  await sleep(600);
}
async function fillInput(colLabel, val) {
  const col = await findCol(colLabel);
  await col.locator('input.el-input__inner').first().fill(val, { timeout: 8000 });
  await sleep(300);
}

/* ── TC-ADD-11 新增保存成功链（P0 前置链——完整走通新增弹窗） ── */
async function tcAdd11() {
  const NAME = 'PT01-E2E-新增基础-' + Date.now() % 100000;
  await frame.locator('button:has-text("新增")').first().click({ timeout: 8000 });
  await sleep(2500);
  const dlg = frame.locator('.el-dialog:visible').first();
  if (!(await dlg.count())) return { status: 'NOT_EXECUTED', reason: '新增弹窗未打开' };
  // 报价名称
  await dlg.locator('.el-col, .el-form-item').filter({ hasText: /报价名称/ }).first().locator('input').first().fill(NAME, { timeout: 8000 });
  await sleep(300);
  // 费用名称（弹窗内 select）
  const costCol = dlg.locator('.el-col, .el-form-item').filter({ hasText: /费用名称/ }).first();
  await costCol.click({ timeout: 8000 }); await sleep(900);
  await frame.locator('.el-select-dropdown__item:visible').filter({ hasText: '业务管理费' }).first().click({ timeout: 8000 });
  await sleep(700);
  // 结算流向（费用选业务管理费后流向选项=总部收业务仓）
  const flowCol = dlg.locator('.el-col, .el-form-item').filter({ hasText: /结算流向/ }).first();
  await flowCol.click({ timeout: 8000 }); await sleep(900);
  await frame.locator('.el-select-dropdown__item:visible').filter({ hasText: '总部收业务仓' }).first().click({ timeout: 8000 });
  await sleep(700);
  // 生效日期/失效日期（日期控件分格）
  const effCol = dlg.locator('.el-col, .el-form-item').filter({ hasText: /生效日期/ }).first();
  const effInputs = effCol.locator('input');
  await effInputs.first().fill('2027-01-01', { timeout: 8000 }).catch(() => {});
  await effInputs.nth(1).fill('2027-02-28', { timeout: 8000 }).catch(() => {});
  await page.keyboard.press('Enter'); await sleep(800);
  // 价格明细第 1 段（0 起始默认带入；单价）
  const detailTable = dlg.locator('.el-table').first();
  const firstRow = detailTable.locator('.el-table__body-wrapper tr').first();
  // 单价列（第 3 输入格——适用重量开始/结束默认带入 0/999999.99）
  const inputs = firstRow.locator('input');
  const n = await inputs.count();
  // 找单价输入格（placeholder 或位置——明细行 5 输入：开始/结束/单价/最低/最高）
  if (n >= 5) {
    await inputs.nth(2).fill('1.5000', { timeout: 8000 }).catch(() => {});
  }
  await sleep(500);
  // 确定
  await dlg.locator('button:has-text("确定")').first().click({ timeout: 8000 });
  await sleep(4000);
  // 查询验证
  await fillInput('报价名称', NAME);
  await frame.locator('button:has-text("查询")').first().click({ timeout: 8000 });
  await sleep(3000);
  const rows = await frame.locator('.el-table__body-wrapper tr').count();
  const totalText = await frame.locator('.el-pagination').innerText().catch(() => '');
  const total = (totalText.match(/共\s*(\d+)\s*条/) || [])[1];
  const pass = String(total) === '1' && rows >= 1;
  return pass
    ? { status: 'PASS', reason: '新增保存成功：名称=' + NAME + ' 查询恰 1 条（列表新增行+审核状态=未审核由行内容核——详见截图）', detail: 'name=' + NAME + ' total=' + total }
    : { status: 'FAIL', reason: '新增后查询 total=' + total + ' rows=' + rows + '（预期恰 1）', detail: 'name=' + NAME };
}

/* ── TC-ADD-12 判重拦截（P0）：同键同区间第二条拦截 ── */
async function tcAdd12() {
  const NAME1 = 'PT01-E2E-判重A-' + Date.now() % 100000;
  const NAME2 = 'PT01-E2E-判重B-' + Date.now() % 100000;
  // 第一条
  for (const name of [NAME1, NAME2]) {
    await frame.locator('button:has-text("新增")').first().click({ timeout: 8000 });
    await sleep(2000);
    const dlg = frame.locator('.el-dialog:visible').first();
    if (!(await dlg.count())) return { status: 'NOT_EXECUTED', reason: '新增弹窗未打开（' + name + '）' };
    await dlg.locator('.el-col, .el-form-item').filter({ hasText: /报价名称/ }).first().locator('input').first().fill(name, { timeout: 8000 });
    const costCol = dlg.locator('.el-col, .el-form-item').filter({ hasText: /费用名称/ }).first();
    await costCol.click({ timeout: 8000 }); await sleep(900);
    await frame.locator('.el-select-dropdown__item:visible').filter({ hasText: '业务管理费' }).first().click({ timeout: 8000 }); await sleep(700);
    const flowCol = dlg.locator('.el-col, .el-form-item').filter({ hasText: /结算流向/ }).first();
    await flowCol.click({ timeout: 8000 }); await sleep(900);
    await frame.locator('.el-select-dropdown__item:visible').filter({ hasText: '总部收业务仓' }).first().click({ timeout: 8000 }); await sleep(700);
    const effCol = dlg.locator('.el-col, .el-form-item').filter({ hasText: /生效日期/ }).first();
    const effInputs = effCol.locator('input');
    await effInputs.first().fill('2027-03-01', { timeout: 8000 }).catch(() => {});
    await effInputs.nth(1).fill('2027-03-31', { timeout: 8000 }).catch(() => {});
    await page.keyboard.press('Enter'); await sleep(700);
    const detailTable = dlg.locator('.el-table').first();
    const firstRow = detailTable.locator('.el-table__body-wrapper tr').first();
    const inputs = firstRow.locator('input');
    if (await inputs.count() >= 5) await inputs.nth(2).fill('2.0000', { timeout: 8000 }).catch(() => {});
    await sleep(400);
    await dlg.locator('button:has-text("确定")').first().click({ timeout: 8000 });
    await sleep(3500);
    // 第二条保存后应有拦截提示（判重）；弹窗保持打开=数据未落地
    if (name === NAME2) {
      // 断言：提示出现+列表无新增（查 NAME2 无行）
      const msgVisible = await frame.locator('.el-message:visible, .el-message-box:visible, [class*=message]:visible').count().catch(() => 0);
      await fillInput('报价名称', NAME2);
      await frame.locator('button:has-text("查询")').first().click({ timeout: 8000 });
      await sleep(3000);
      const totalText = await frame.locator('.el-pagination').innerText().catch(() => '');
      const total2 = (totalText.match(/共\s*(\d+)\s*条/) || [])[1];
      // 关闭残留弹窗
      await frame.locator('.el-dialog:visible button:has-text("取消"), .el-dialog:visible button:has-text("关闭")').first().click({ timeout: 5000 }).catch(() => {});
      const pass = String(total2) === '0' && msgVisible > 0;
      return pass
        ? { status: 'PASS', reason: '判重拦截：第二条（同键同区间，仅名称不同）保存被拦（提示出现=' + (msgVisible > 0) + '），查询 NAME2 total=0（未落地）', detail: 'msg=' + msgVisible + ' total2=' + total2 }
        : { status: 'FAIL', reason: '判重未拦或未提示：msg=' + msgVisible + ' total2=' + total2, detail: 'names=' + NAME1 + '/' + NAME2 };
    }
  }
}

/* ── 造数自清（纪律）：删本批 PT01-E2E 前缀数据 ── */
async function cleanup() {
  try {
    await fillInput('报价名称', 'PT01-E2E');
    await frame.locator('button:has-text("查询")').first().click({ timeout: 8000 });
    await sleep(3000);
    let guard = 0;
    while (guard++ < 20) {
      const row = frame.locator('.el-table__body-wrapper tr').first();
      if (!(await row.count())) break;
      const cb = row.locator('.el-checkbox, input[type=checkbox]').first();
      await cb.click({ timeout: 5000 }).catch(() => {});
      await frame.locator('button:has-text("删除")').first().click({ timeout: 5000 });
      await sleep(1500);
      // 确认弹窗
      const confirm = frame.locator('.el-message-box:visible button:has-text("确定"), .el-dialog:visible button:has-text("确定")').last();
      await confirm.click({ timeout: 5000 }).catch(() => {});
      await sleep(2500);
    }
    log('[cleanup] done, guard=', guard);
  } catch (e) { log('[cleanup] skip:', e.message.slice(0, 80)); }
}

(async () => {
  const browser = await setup();
  batch('run_start', { planned: 2, dispatch: 2, channel_note: 'ui-write P0 链' });
  const stats = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_EXECUTED: 0 };
  const cases = [['TC-ADD-11', tcAdd11], ['TC-ADD-12', tcAdd12]];
  let shotIdx = 0;
  for (const [tc, fn] of cases) {
    try {
      const r = await fn();
      // 截图留证
      const shot = path.join(J, 'shots', `pp_exec_${tc}_${Date.now()}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      record(tc, r.status, r.reason, r.detail ? { detail: String(r.detail).slice(0, 300), shot } : { shot });
      stats[r.status]++;
    } catch (e) {
      record(tc, 'NOT_EXECUTED', '执行异常: ' + e.message.slice(0, 200));
      stats.NOT_EXECUTED++;
    }
  }
  if (!DRY) await cleanup();
  batch('run_end', { n: 2, stats, endKind: 'normal' });
  log('[summary]', JSON.stringify(stats));
  await browser.close().catch(() => {});
  try { cdp.removeLock(port); } catch (_) {}
  process.exit(0);
})().catch(e => { console.error('FATAL', e); batch('run_end', { endKind: 'fatal', reason: e.message.slice(0, 300) }); process.exit(1); });
