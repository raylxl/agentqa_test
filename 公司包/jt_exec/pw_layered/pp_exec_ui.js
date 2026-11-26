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
function append(rec) { if (!NO_LEDGER) fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n'); else log('（dry）', rec.event || rec.tc, String(rec.reason||'').slice(0,300).replace(/\n/g, ' ⏎ ')); }
function record(tc, status, reason, extra = {}) { append({ ts: bjTs(), event: 'case', tc, status, reason: (reason||'').slice(0,500), exec_id: 'PP-' + day + '-' + String(EXEC_NO++).padStart(3, '0'), run_id: RUN_ID, round: ROUND, channel: 'ui', ...extra }); }
function batch(kind, extra = {}) { append({ ts: bjTs(), event: kind, run_id: RUN_ID, round: ROUND, channel: 'ui', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(无头+iframe)', ...extra }); }

let page, frame;
const SESSION_API = {
  async queryByName(name) {
    const r = await page.evaluate(async (n) => {
      const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
      const resp = await fetch('http://gateway-ll.test.ztoeco.com/phecda/api/cwbms/quotePlatformFee/getPageList', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' },
        body: JSON.stringify({ page: 1, pageSize: 10, quoteName: n }),
      });
      const j = await resp.json().catch(() => null);
      return { total: j && j.data ? j.data.total : -1, items: (j && j.data && j.data.items) || [] };
    }, name);
    return r;
  },
};
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


/* ── 网络监听（addOrUpdate 请求/响应——判重证据与落库判定） ── */
let __saveNet = { req: null, resp: null };
function watchSave(page) {
  page.on('request', (req) => { if (/quotePlatformFee\/addOrUpdate/.test(req.url())) __saveNet.req = (req.postData() || '').slice(0, 800); });
  page.on('response', async (res) => { if (/quotePlatformFee\/addOrUpdate/.test(res.url())) __saveNet.resp = { s: res.status(), b: (await res.text().catch(() => '')).slice(0, 300) }; });
}
/* ── 弹窗填表 helper（结构实测：placeholder 定位+独立日期框+明细表格） ── */
async function fillAddDialog(dlg, { name, cost, flow, effStart, effEnd, price, specialAttr, customer }) {
  const nameIn = dlg.locator('input[placeholder*="报价名称"]');
  await nameIn.click({ timeout: 8000 });
  await nameIn.type(name, { delay: 20 });
  await sleep(500);
  // 费用名称：先看已显示值——已是目标值（Vue 缓存直用）则跳过；否则点开（当前值 wrapper 或 兜底）选目标
  const costAlready = await dlg.locator('.el-select__wrapper').filter({ hasText: cost.pick }).first().count().catch(() => 0);
  if (!costAlready) {
    let costWrap = dlg.locator('.el-select__wrapper').filter({ hasText: cost.current || '流量管理费' }).first();
    if (!(await costWrap.count())) costWrap = dlg.locator('.el-select__wrapper').filter({ hasText: /费用名称|请选择/ }).first();
    if (await costWrap.count()) {
      await costWrap.click({ timeout: 8000 });
      await sleep(900);
      const costOpt = frame.locator('.el-select-dropdown__item:visible').filter({ hasText: cost.pick }).first();
      for (let w = 0; w < 10; w++) { if (await costOpt.count()) break; await sleep(800); }
      if (await costOpt.count()) await costOpt.click({ timeout: 8000 });
      await sleep(700);
    }
  }
  // 结算流向：已显示目标值（Vue 缓存直用）则跳过
  const flowAlready = await dlg.locator('.el-select__wrapper').filter({ hasText: flow }).first().count().catch(() => 0);
  if (!flowAlready) {
    const flowWrap = dlg.locator('.el-select__wrapper').filter({ hasText: /结算流向|请选择/ }).first();
    if (await flowWrap.count()) {
      await flowWrap.click({ timeout: 8000 });
      await sleep(900);
      const flowOpt = frame.locator('.el-select-dropdown__item:visible').filter({ hasText: flow }).first();
      for (let w = 0; w < 10; w++) { if (await flowOpt.count()) break; await sleep(800); }
      if (await flowOpt.count()) await flowOpt.click({ timeout: 8000 });
      await sleep(700);
    }
  }
  // 特殊属性（可选：填贴单即发错开库内全空维占位条 PTF091050）
  if (specialAttr) {
    const saAlready = await dlg.locator('.el-select__wrapper').filter({ hasText: specialAttr }).first().count().catch(() => 0);
    if (!saAlready) {
      const saWrap = dlg.locator('.el-select__wrapper').filter({ hasText: /特殊属性/ }).first();
      if (await saWrap.count()) {
        await saWrap.click({ timeout: 8000 });
        await sleep(900);
        const saOpt = frame.locator('.el-select-dropdown__item:visible').filter({ hasText: specialAttr }).first();
        for (let w = 0; w < 10; w++) { if (await saOpt.count()) break; await sleep(800); }
        if (await saOpt.count()) await saOpt.click({ timeout: 8000 });
        await sleep(700);
      }
    }
  }
  // 客户（可选：填客户维错开库内全空维占位条）
  if (customer) {
    await dlg.locator('.el-select__wrapper').filter({ hasText: /^请选择$/ }).first().click({ timeout: 8000 });
    await sleep(1200);
    const cOpt = frame.locator('.el-select-dropdown__item:visible').first();
    if (await cOpt.count()) { await cOpt.click({ timeout: 8000 }); await sleep(800); }
  }
  // 日期 fill 后必须 blur（点标题）触发 Vue change——纯 fill/Enter 不触发 v-model（diag41 实证：不 blur 则不发请求）
  const effIn = dlg.locator('input[placeholder*="生效日期"]');
  await effIn.click({ timeout: 5000 }).catch(() => {});
  await effIn.fill(effStart, { timeout: 8000 }).catch(() => {});
  await dlg.locator('.el-dialog__title').click().catch(() => {});
  await sleep(800);
  const expIn = dlg.locator('input[placeholder*="失效日期"]');
  await expIn.fill(effEnd, { timeout: 8000 }).catch(() => {});
  await dlg.locator('.el-dialog__title').click().catch(() => {});
  await sleep(800);
  // 明细（diag15/41 实证）：重量结束值=.el-input-number input（click+fill）；单价=普通 input nth(1)
  const numInput = dlg.locator('.el-table .el-input-number input').first();
  await numInput.click({ timeout: 5000 }).catch(() => {});
  await numInput.fill('999999.99', { timeout: 8000 }).catch(() => {});
  await sleep(400);
  const detailInputs = dlg.locator('.el-table input');
  if (await detailInputs.count() >= 2) {
    await detailInputs.nth(1).click({ timeout: 5000 }).catch(() => {});
    await detailInputs.nth(1).fill(price, { timeout: 8000 }).catch(() => {});
  }
  await sleep(400);
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
  await fillAddDialog(dlg, { name: NAME, cost: { current: '流量管理费', pick: '流量管理费' }, flow: '总部收操作仓', effStart: '2027-04-01', effEnd: '2027-04-30', price: '1.5000', specialAttr: '贴单即发' });
  await dlg.locator('button:has-text("确定")').first().click({ timeout: 8000 });
  await sleep(7000);
  // 判据三链：①addOrUpdate 响应 ②弹窗关闭 ③接口直查落库
  const resp = __saveNet.resp;
  const dlgStill = await frame.locator('.el-dialog:visible').count().catch(() => 0);
  const query = await SESSION_API.queryByName(NAME);
  if (dlgStill) await frame.locator('.el-dialog:visible button:has-text("取消")').first().click({ timeout: 5000 }).catch(() => {});
  if (resp && /重复|DEF001/.test(resp.b)) {
    return { status: 'FAIL', reason: '新增被后端判重拦截（非预期——日期窗应已错峰）：' + resp.b.slice(0, 120), detail: 'name=' + NAME + ' resp=' + resp.b.slice(0, 100) };
  }
  if (query.total === 1) {
    const it = query.items[0];
    return { status: 'PASS', reason: '新增保存成功：' + NAME + ' 落库恰 1 条（auditStatus=' + it.auditStatus + ' quoteCode=' + it.quoteCode + ' createBy=' + it.createBy + '）', detail: 'name=' + NAME };
  }
  return { status: 'FAIL', reason: '新增后接口直查 total=' + query.total + '（预期 1）；resp=' + JSON.stringify(resp).slice(0, 120), detail: 'name=' + NAME };
}

async function tcAdd12() {
  const NAME1 = 'PT01-E2E-判重A-' + Date.now() % 100000;
  const NAME2 = 'PT01-E2E-判重B-' + (Date.now() % 100000 + 1);
  let msgVisible = 0, total2 = '-1', dlgStill = 0, errs2 = [];
  for (const name of [NAME1, NAME2]) {
    // 循环内重载（弹窗保存成功后页面态劣化——ADD-11 实证）
    await page.goto(MENU_URL, { timeout: 30000, waitUntil: 'domcontentloaded' });
    for (let w = 0; w < 40; w++) {
      await sleep(2000);
      frame = page.frames().find(f => f.url().includes('warehouse-menu/quote/platformPrice'));
      if (frame) { const n = await frame.locator('.el-table__header-wrapper th').count().catch(() => 0); if (n > 3) break; }
    }
    if (!frame) return { status: 'NOT_EXECUTED', reason: '重载后业务 frame 未就绪（' + name + '）' };
    // 等新增按钮真正可交互（iframe 内层渲染完——直接点会被半渲染态挡住）
    const addBtn = frame.locator('button:has-text("新增")').first();
    for (let w = 0; w < 15; w++) {
      const vis = await addBtn.isVisible().catch(() => false);
      const en = await addBtn.isEnabled().catch(() => false);
      if (vis && en) break;
      await sleep(1000);
    }
    await addBtn.click({ timeout: 15000, force: true });
    await sleep(2500);
    const dlg = frame.locator('.el-dialog:visible').first();
    if (!(await dlg.count())) return { status: 'NOT_EXECUTED', reason: '新增弹窗未打开（' + name + '）' };
    await fillAddDialog(dlg, { name, cost: { current: '流量管理费', pick: '业务管理费' }, flow: '总部收业务仓', effStart: '2027-06-01', effEnd: '2027-06-30', price: '2.0000' });
    await dlg.locator('button:has-text("确定")').first().click({ timeout: 8000 });
    await sleep(7000);
    if (name === NAME2) {
      // 判重证据链：addOrUpdate 响应含「存在重复」+NAME2 未落库
      const resp2 = __saveNet.resp;
      msgVisible = await frame.locator('.el-message:visible').count().catch(() => 0);
      dlgStill = await frame.locator('.el-dialog:visible').count().catch(() => 0);
      if (dlgStill) await frame.locator('.el-dialog:visible button:has-text("取消"), .el-dialog:visible button:has-text("关闭")').first().click({ timeout: 5000 }).catch(() => {});
      const q2 = await SESSION_API.queryByName(NAME2);
      total2 = String(q2.total);
      const dupResp = resp2 && /存在重复|DEF001/.test(resp2.b);
      const pass = total2 === '0' && !!dupResp;
      return pass
        ? { status: 'PASS', reason: '判重拦截：第二条同键同区间（仅名称不同）被后端拦——响应「' + (resp2 ? resp2.b.slice(0, 80) : 'n/a') + '」，NAME2 接口直查 total=0（未落地）', detail: 'resp=' + (resp2 ? resp2.b.slice(0, 150) : 'n/a') }
        : { status: 'FAIL', reason: '判重未拦或证据不足：dupResp=' + !!dupResp + ' total2=' + total2 + ' resp=' + JSON.stringify(resp2).slice(0, 100), detail: 'names=' + NAME1 + '/' + NAME2 };
    }
  }
}


/* ── 造数自清（纪律）：接口删 PT01-E2E 前缀数据（deleteIds 实测格式） ── */
async function cleanup() {
  try {
    const r = await page.evaluate(async () => {
      const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
      const H = { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' };
      const GW = 'http://gateway-ll.test.ztoeco.com';
      const q = await fetch(GW + '/phecda/api/cwbms/quotePlatformFee/getPageList', { method: 'POST', headers: H, body: JSON.stringify({ page: 1, pageSize: 50, quoteName: 'PT01-E2E' }) });
      const qj = await q.json();
      const items = (qj.data && qj.data.items) || [];
      if (!items.length) return { cleaned: 0 };
      const d = await fetch(GW + '/phecda/api/cwbms/quotePlatformFee/delete', { method: 'POST', headers: H, body: JSON.stringify({ deleteIds: items.map(i => i.id) }) });
      await d.json().catch(() => {});
      const q2 = await fetch(GW + '/phecda/api/cwbms/quotePlatformFee/getPageList', { method: 'POST', headers: H, body: JSON.stringify({ page: 1, pageSize: 50, quoteName: 'PT01-E2E' }) });
      const q2j = await q2.json();
      return { cleaned: items.length, remain: (q2j.data && q2j.data.total) || 0 };
    });
    log('[cleanup]', JSON.stringify(r));
  } catch (e) { log('[cleanup] fail:', e.message.slice(0, 100)); }
}

(async () => {
  const browser = await setup();
  watchSave(page);
  batch('run_start', { planned: 2, dispatch: 2, channel_note: 'ui-write P0 链（fill+blur 触发法·diag41/47 实证）' });
  const stats = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_EXECUTED: 0 };
  const cases = [['TC-ADD-11', tcAdd11], ['TC-ADD-12', tcAdd12]];
  let shotIdx = 0;
  for (const [tc, fn] of cases) {
    try {
      __saveNet = { req: null, resp: null };
      // 用例间重载（iframe 微应用状态劣化隔离——diag44/46 实证多次操作后弹窗失能）
      await page.goto(MENU_URL, { timeout: 30000, waitUntil: 'domcontentloaded' });
      for (let w = 0; w < 40; w++) {
        await sleep(2000);
        frame = page.frames().find(f => f.url().includes('warehouse-menu/quote/platformPrice'));
        if (frame) { const n = await frame.locator('.el-table__header-wrapper th').count().catch(() => 0); if (n > 3) break; }
      }
      if (!frame) throw new Error('重载后业务 frame 未就绪');
      const _addBtn = frame.locator('button:has-text("新增")').first();
      for (let w = 0; w < 15; w++) {
        const vis = await _addBtn.isVisible().catch(() => false);
        if (vis) break;
        await sleep(1000);
      }
      const r = await fn();
      // 截图留证
      const shot = path.join(J, 'shots', `pp_exec_${tc}_${Date.now()}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      record(tc, r.status, r.reason, r.detail ? { detail: String(r.detail).slice(0, 300), shot } : { shot });
      stats[r.status]++;
    } catch (e) {
      const pwlog = Array.isArray(e.log) ? e.log.join(' | ') : (Array.isArray(e.logs) ? e.logs.join(' | ') : '');
      record(tc, 'NOT_EXECUTED', '执行异常: ' + e.message.split('\n')[0].slice(0, 80) + ' @ ' + pwlog.slice(0, 250));
      stats.NOT_EXECUTED++;
    }
  }
  await cleanup();
  batch('run_end', { n: 2, stats, endKind: 'normal' });
  log('[summary]', JSON.stringify(stats));
  await browser.close().catch(() => {});
  try { cdp.removeLock(port); } catch (_) {}
  process.exit(0);
})().catch(e => { console.error('FATAL', e); batch('run_end', { endKind: 'fatal', reason: e.message.slice(0, 300) }); process.exit(1); });
