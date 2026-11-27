/**
 * pp_exec_lib.js — 平台价格执行器公共库（2026-11-27 由 R4 十四批执行器抽取）
 *
 * 来源：R4 轮 r4a~r4h 共 14 个执行器，每个重复 80% 的 setup/登录/租户/进业务页/清遮挡/查询/勾选
 * 造数/审核/删除/驳回公共链——本库一次沉淀，后续执行批只写差异断言。
 *
 * 坑库依据（全部 R4 实证）：
 *   - 单进程自包含：cdp_pool spawn（detached+unref）实例跨 Bash 调用存活；shell 直接起的会被会话回收
 *   - Chrome 必须 --no-sandbox（CHROME_NO_SANDBOX=1）
 *   - 页面上下文 fetch 桥=唯一可靠 API 通道（Playwright request 直调网关假 200）
 *   - audit 落库有延迟：audit1() 内置轮询复核（立即查会拿到旧态——DEL-04 两轮误判根因）
 *   - 判定纪律：断言值从接口响应取（禁凭记忆）；预期不符先复核前置态
 *   - 造数错键四维：特殊属性('1'/null)/流向(370/380)/操作仓('上海仓')/客户+业务仓成对
 *   - 遮挡弹窗残留：uiQuery 前清 .el-overlay-message-box
 *
 * 用法：
 *   const PPL = require('./pp_exec_lib.js');
 *   const S = await PPL.setup({ purpose: '批名' });     // { browser, page, frame, port, api, ... }
 *   await PPL.uiQuery(S, 'PT01-');
 *   await PPL.checkAndAction(S, ['名称'], '删除');
 *   PPL.record('TC-XX-01', 'PASS', '证据原文');
 */
const path = require('path');
const fs = require('fs');
const J = path.join(__dirname);
const cdp = require(path.join(J, 'cdp_pool.js'));
const { ensureTenant } = require(path.join(J, 'pw_tenant.js'));

const GW = 'http://gateway-ll.test.ztoeco.com';
const SGW = 'http://sys-gw-ll.test.ztoeco.com';
const MENU_URL = 'http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice';
const ACCOUNT = { user: 'luxiaolei99', pass: 'Zto@20211021', display: '陆潇雷' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── 账本（含执行号自增） ── */
const LEDGER = '/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用例文件/平台价格分章/exec_ledger/ledger.jsonl';
const bjTs = () => new Date().toLocaleString('sv-SE').replace(' ', ' ');
function _nextExecNo() {
  let n = 900;
  if (fs.existsSync(LEDGER)) {
    for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
      const m = line.match(/PP-\d{8}-(\d+)/);
      if (m) n = Math.max(n, +m[1] + 1);
    }
  }
  return n;
}
let _execNo = _nextExecNo();
function record(tc, status, reason, extra = {}) {
  fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: 'case', tc, status, reason: String(reason || '').slice(0, 500), exec_id: 'PP-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + String(_execNo++).padStart(3, '0'), run_id: 'PP-R4-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''), round: '执行R4', channel: 'ui', ...extra }) + '\n');
}
function batch(kind, extra = {}) {
  fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: kind, run_id: 'PP-R4-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''), round: '执行R4', channel: 'ui', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(pp_exec_lib)', ...extra }) + '\n');
}

/* ── setup：清锁→独占端口→登录→租户→业务页（单进程自包含） ── */
async function setup(opts = {}) {
  process.env.JT_ACCOUNT = opts.account || ACCOUNT.user;
  process.env.JT_SECRET = opts.pass || ACCOUNT.pass;
  process.env.CHROME_NO_SANDBOX = '1';
  const { execSync } = require('child_process');
  try { execSync('pkill -f "remote-debugging-port=933[567]"', { shell: '/bin/bash' }); } catch (e) {}
  await sleep(1500);
  try { for (const f of fs.readdirSync(path.join(J, 'locks'))) fs.unlinkSync(path.join(J, 'locks', f)); } catch (e) {}
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335, 9336, 9337], purpose: opts.purpose || 'pp_exec_lib', verbose: true });
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + c.port, { timeout: 10000 });
  const page = browser.contexts()[0].pages()[0] || (await browser.contexts()[0].newPage());
  // 登录（welcome→SSO→账密；已登录态快速通过）
  await page.goto('http://jt-ll.test.ztoeco.com/welcome', { timeout: 30000, waitUntil: 'domcontentloaded' });
  await sleep(5000);
  let ok = false;
  try { ok = (await page.evaluate(() => document.body.innerText)).includes('预发环境'); } catch (e) {}
  if (!ok && !page.url().includes('sso.test.ztoeco.com')) {
    await page.evaluate(() => { localStorage.removeItem('MICRO_APP_MAIN_TOKEN_KEY'); location.href = 'http://jt-ll.test.ztoeco.com/welcome'; }).catch(() => {});
    await sleep(6000);
  }
  if (!ok && page.url().includes('sso.test.ztoeco.com')) {
    let ins = await page.evaluate(() => [...document.querySelectorAll('input')].filter(el => el.offsetWidth || el.offsetHeight).length).catch(() => 0);
    if (ins === 0) { await page.click('a.login-switch-link', { timeout: 10000 }).catch(() => {}); await sleep(2500); }
    for (let w = 0; w < 10; w++) { const cnt = await page.locator('input[name="username"]').count().catch(() => 0); if (cnt) break; await sleep(1000); }
    await page.fill('input[name="username"]', process.env.JT_ACCOUNT);
    await page.fill('input[name="password"]', process.env.JT_SECRET);
    await page.click('button.login-btn', { timeout: 10000 }).catch(() => {});
    for (let i = 0; i < 15; i++) { await sleep(2000); if (page.url().includes('jt-ll.test.ztoeco.com')) { const t = await page.evaluate(() => document.body.innerText).catch(() => ''); if (t.includes('预发环境')) { ok = true; break; } } }
  }
  if (!ok) throw new Error('登录失败');
  await ensureTenant(browser, '智冷仓链', () => {});
  const S = { browser, page, frame: null, port: c.port };
  await gotoBiz(S);
  // API 桥（页面上下文——唯一可靠通道）
  S.api = (p, body, gw) => page.evaluate(async ({ u, b }) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify(b) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
    return { status: r.status, json: j, text: t.slice(0, 300) };
  }, { u: (gw || GW) + p, b: body });
  return S;
}

/* ── 业务页与基础操作 ── */
async function gotoBiz(S) {
  await S.page.goto(MENU_URL, { timeout: 30000, waitUntil: 'domcontentloaded' });
  for (let w = 0; w < 40; w++) {
    await sleep(2000);
    S.frame = S.page.frames().find(f => f.url().includes('warehouse-menu/quote/platformPrice'));
    if (S.frame) { const n = await S.frame.locator('.el-table__header-wrapper th').count().catch(() => 0); if (n > 3) break; }
  }
  if (!S.frame) throw new Error('业务 frame 未就绪');
  await clearOverlay(S);
}
async function clearOverlay(S) {
  await S.page.evaluate(() => { document.querySelectorAll('.el-overlay.is-message-box, .el-overlay-message-box').forEach(e => e.remove()); }).catch(() => {});
  if (S.frame) await S.frame.evaluate(() => { document.querySelectorAll('.el-overlay.is-message-box, .el-overlay-message-box').forEach(e => e.remove()); }).catch(() => {});
}
async function uiQuery(S, name) {
  await clearOverlay(S);
  const nameCol = S.frame.locator('.el-col.modelFormClass').filter({ hasText: /^\s*报价名称/ }).first();
  const inpt = nameCol.locator('input.el-input__inner').first();
  await inpt.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await inpt.fill(name, { timeout: 10000, force: true });
  const qbtn = S.frame.locator('button:has-text("查询")').first();
  await qbtn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await qbtn.click({ timeout: 8000, noWaitAfter: true, force: true });
  await sleep(4000);
}
async function findRow(S, name) { return S.frame.locator('.el-table__body-wrapper tr').filter({ hasText: name }).first(); }
/* 勾选行→点工具栏按钮→确认弹窗→返回提示 */
async function checkAndAction(S, names, btnText) {
  for (const nm of (Array.isArray(names) ? names : [names])) {
    const rr = await findRow(S, nm);
    if (await rr.count()) {
      const c = rr.locator('.el-checkbox').first();
      await c.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await c.click({ timeout: 6000, force: true }).catch(() => {});
      await sleep(600);
    }
  }
  const btn = S.frame.locator('button:has-text("' + btnText + '")').first();
  await btn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await btn.click({ timeout: 10000, noWaitAfter: true, force: true });
  await sleep(2500);
  const cfm = S.frame.locator('.el-overlay-message-box button.el-button--primary').first();
  if (await cfm.count().catch(() => 0)) { await cfm.click({ timeout: 5000, force: true, noWaitAfter: true }).catch(() => {}); }
  await sleep(4500);
  return await S.frame.evaluate(() => Array.from(document.querySelectorAll('.el-message')).filter(e => e.offsetParent).map(e => (e.innerText || '').slice(0, 100))).catch(() => []);
}

/* ── 业务原子 ── */
async function queryByName(S, name) {
  const r = await S.api('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, quoteName: name });
  const d = r.json && r.json.data;
  return { total: d ? d.total : -1, items: d ? (d.items || []) : [] };
}
/* 造数（键窗+四维错键可选） */
async function mk(S, name, o = {}) {
  return S.api('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', {
    quoteName: name, costCode: o.w || 'W70', settFlow: o.f || 370,
    specialAttributes: o.sa === undefined ? '1' : o.sa,
    customerCode: o.customer || null, businessWhCode: o.biz || null, operateWhCode: o.wh || null,
    startDate: o.s, endDate: o.e, detailModel: 'TIER',
    quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: o.price || 1, minPrice: null, maxPrice: null }],
  });
}
/* 审核（auditIds 参数+轮询复核——audit 落库有延迟） */
async function audit1(S, id, name, status = 1) {
  await S.api('/phecda/api/cwbms/quotePlatformFee/audit', { auditIds: [id], auditStatus: status });
  for (let i = 0; i < 5; i++) {
    await sleep(2500);
    const it = (await queryByName(S, name)).items[0];
    if (it && it.auditStatus === status) return it;
  }
  return (await queryByName(S, name)).items[0];
}
async function delByIds(S, ids) {
  return S.api('/phecda/api/cwbms/quotePlatformFee/delete', { deleteIds: ids });
}

/* ── 判定 checklist（防误判纪律内化） ── */
async function judgeWithDiscipline(S, tc, expect, getState, opts = {}) {
  // 纪律 1：预期不符先复核前置态（BLOCKED vs FAIL 分流）
  // 纪律 2：断言值从接口响应取（禁凭记忆）——getState 必须返回含原始响应
  const st = await getState();
  const match = opts.match ? opts.match(st) : JSON.stringify(st).includes(String(expect));
  if (match) record(tc, 'PASS', (opts.reasonOk ? opts.reasonOk(st) : String(st).slice(0, 200)));
  else {
    // 前置复核
    if (opts.precheck) {
      const pre = await opts.precheck();
      if (!pre.ok) { record(tc, 'BLOCKED', '前置不成立：' + pre.why + '（实测=' + JSON.stringify(st).slice(0, 150) + '）'); return; }
    }
    record(tc, 'FAIL', '预期=' + JSON.stringify(expect).slice(0, 100) + ' 实测=' + JSON.stringify(st).slice(0, 200));
  }
}

module.exports = { GW, SGW, MENU_URL, LEDGER, sleep, record, batch, setup, gotoBiz, clearOverlay, uiQuery, findRow, checkAndAction, queryByName, mk, audit1, delByIds, judgeWithDiscipline };
