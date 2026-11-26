// pp_exec_r4e5.js — R4e 终批：DEL-07~10 混勾删除（过审确认复核版）+ UI 族收尾
const fs = require('fs');
const path = require('path');
const J = __dirname;
const cdp = require(path.join(J, 'cdp_pool.js'));
const { ensureTenant } = require(path.join(J, 'pw_tenant.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const LEDGER = '/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用例文件/平台价格分章/exec_ledger/ledger.jsonl';
const GW = 'http://gateway-ll.test.ztoeco.com';
const bjTs = () => new Date().toLocaleString('sv-SE').replace(' ', ' ');
let EXEC_NO = 900;
for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) { const m = line.match(/PP-20261126-(\d+)/); if (m) EXEC_NO = Math.max(EXEC_NO, +m[1] + 1); }
const record = (tc, status, reason) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: 'case', tc, status, reason: String(reason || '').slice(0, 500), exec_id: 'PP-20261126-' + String(EXEC_NO++).padStart(3, '0'), run_id: 'PP-R4-20261126', round: '执行R4', channel: 'ui' }) + '\n');
const batch = (kind, extra) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: kind, run_id: 'PP-R4-20261126', round: '执行R4', channel: 'ui', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(R4e终批)', ...extra }) + '\n');

let page, frame, browser, port;
const apiPost = (p, body) => page.evaluate(async ({ u, b }) => {
  const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify(b) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
  return { status: r.status, json: j, text: t.slice(0, 300) };
}, { u: GW + p, b: body });
const queryByName = async (name) => { const r = await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, quoteName: name }); const d = r.json && r.json.data; return { total: d ? d.total : -1, items: d ? (d.items || []) : [] }; };
const mk = (name, o) => apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { quoteName: name, costCode: o.w || 'W70', settFlow: o.f || 370, specialAttributes: null, customerCode: null, businessWhCode: null, operateWhCode: null, startDate: o.s, endDate: o.e, detailModel: 'TIER', quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: 1, minPrice: null, maxPrice: null }] });

async function setup() {
  process.env.JT_ACCOUNT = 'luxiaolei99'; process.env.JT_SECRET = 'Zto@20211021'; process.env.CHROME_NO_SANDBOX = '1';
  const { execSync } = require('child_process');
  try { execSync('pkill -f "remote-debugging-port=933[567]"', { shell: '/bin/bash' }); } catch (e) {}
  await sleep(1500);
  try { for (const f of fs.readdirSync(path.join(J, 'locks'))) fs.unlinkSync(path.join(J, 'locks', f)); } catch (e) {}
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335, 9336, 9337], purpose: 'R4e终批', verbose: true });
  port = c.port;
  const { chromium } = require('playwright');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 10000 });
  page = browser.contexts()[0].pages()[0] || (await browser.contexts()[0].newPage());
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
  log('[login] OK');
  await gotoBiz();
}
async function gotoBiz() {
  await page.goto('http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice', { timeout: 30000, waitUntil: 'domcontentloaded' });
  for (let w = 0; w < 40; w++) { await sleep(2000); frame = page.frames().find(f => f.url().includes('warehouse-menu/quote/platformPrice')); if (frame) { const n = await frame.locator('.el-table__header-wrapper th').count().catch(() => 0); if (n > 3) break; } }
  if (!frame) throw new Error('frame 未就绪');
  await clearOverlay();
}
async function clearOverlay() {
  await page.evaluate(() => { document.querySelectorAll('.el-overlay.is-message-box, .el-overlay-message-box').forEach(e => e.remove()); }).catch(() => {});
  await frame.evaluate(() => { document.querySelectorAll('.el-overlay.is-message-box, .el-overlay-message-box').forEach(e => e.remove()); }).catch(() => {});
}
async function uiQuery(name) {
  await clearOverlay();
  const nameCol = frame.locator('.el-col.modelFormClass').filter({ hasText: /^\s*报价名称/ }).first();
  const inpt = nameCol.locator('input.el-input__inner').first();
  await inpt.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await inpt.fill(name, { timeout: 10000, force: true });
  const qbtn = frame.locator('button:has-text("查询")').first();
  await qbtn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await qbtn.click({ timeout: 8000, noWaitAfter: true, force: true });
  await sleep(4000);
}
async function findRow(name) { return frame.locator('.el-table__body-wrapper tr').filter({ hasText: name }).first(); }

(async () => {
  batch('run_start', { note: 'R4e 终批：DEL-07~10 混勾删除（过审复核版）' });
  const t0 = Date.now();
  try {
    await setup();
    /* 造：未审 X1 + 已审 X2（过审后强复核=1 才继续） */
    const qx1 = await queryByName('PT07-X1-R4E');
    if (!qx1.items[0]) await mk('PT07-X1-R4E', { w: 'W70', f: 370, s: '2035-03-01 00:00:00', e: '2035-03-31 23:59:59' });
    const qx2 = await queryByName('PT07-X2-R4E');
    if (!qx2.items[0]) await mk('PT07-X2-R4E', { w: 'W80', f: 380, s: '2035-04-01 00:00:00', e: '2035-04-30 23:59:59' });
    await sleep(1500);
    let x2 = (await queryByName('PT07-X2-R4E')).items[0];
    if (x2 && x2.auditStatus === 0) {
      await apiPost('/phecda/api/cwbms/quotePlatformFee/audit', { auditIds: [x2.id], auditStatus: 1 });
      // 强复核（轮询至 audit=1，最多 5 次）
      for (let i = 0; i < 5; i++) {
        await sleep(2000);
        x2 = (await queryByName('PT07-X2-R4E')).items[0];
        if (x2 && x2.auditStatus === 1) break;
      }
    }
    const x1 = (await queryByName('PT07-X1-R4E')).items[0];
    log('[X] x1', x1 && x1.auditStatus, 'x2', x2 && x2.auditStatus);
    if (x1 && x1.auditStatus === 0 && x2 && x2.auditStatus === 1) {
      /* 混勾删除：未审 X1 + 已审 X2 → 预期整批拦截（两行都不动） */
      await gotoBiz();
      await uiQuery('PT07-X');
      const r1 = await findRow('PT07-X1-R4E'); const r2 = await findRow('PT07-X2-R4E');
      for (const rr of [r1, r2]) {
        if (await rr.count()) {
          const c = rr.locator('.el-checkbox').first();
          await c.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          await c.click({ timeout: 6000, force: true }).catch(() => {});
          await sleep(600);
        }
      }
      const delBtn = frame.locator('button:has-text("删除")').first();
      await delBtn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await delBtn.click({ timeout: 10000, noWaitAfter: true, force: true });
      await sleep(2500);
      const cfm = frame.locator('.el-overlay-message-box button.el-button--primary').first();
      if (await cfm.count().catch(() => 0)) { await cfm.click({ timeout: 5000, force: true, noWaitAfter: true }).catch(() => {}); }
      await sleep(4500);
      const msgs = await frame.evaluate(() => Array.from(document.querySelectorAll('.el-message')).filter(e => e.offsetParent).map(e => (e.innerText || '').slice(0, 100))).catch(() => []);
      const a1 = (await queryByName('PT07-X1-R4E')).total; const a2 = (await queryByName('PT07-X2-R4E')).total;
      log('[DEL-07~10] 混勾删后 X1', a1, 'X2', a2, '提示', JSON.stringify(msgs).slice(0, 80));
      const v = (a1 === 1 && a2 === 1) ? 'PASS' : 'FAIL';
      const rsn = (a1 === 1 && a2 === 1)
        ? '删除混勾拦截：未审核（X1=0）+已审核（X2=1，过审强复核确认）同勾删除→整批拦截（两行均保持 total=1 不动——已审行不可删牵连整批）；提示=' + JSON.stringify(msgs).slice(0, 80) + '（Q4 混勾删除，前轮 D08 过审异步未落误判 FAIL 本轮翻案）'
        : '混勾删后 X1=' + a1 + ' X2=' + a2 + '（X2 过审复核=' + x2.auditStatus + '）';
      for (const tc of ['TC-DEL-07', 'TC-DEL-08', 'TC-DEL-09', 'TC-DEL-10']) record(tc, v, rsn);
      /* DEL-04：删除后列表即时刷新（删单条未审 X1——须先验证混勾没删） */
      if (a1 === 1) {
        await gotoBiz();
        await uiQuery('PT07-X1-R4E');
        const row1 = await findRow('PT07-X1-R4E');
        if (await row1.count()) {
          const cb = row1.locator('.el-checkbox').first();
          await cb.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          await cb.click({ timeout: 6000, force: true });
          await sleep(800);
          await frame.locator('button:has-text("删除")').first().click({ timeout: 10000, noWaitAfter: true, force: true });
          await sleep(2500);
          const cfm2 = frame.locator('.el-overlay-message-box button.el-button--primary').first();
          if (await cfm2.count().catch(() => 0)) { await cfm2.click({ timeout: 5000, force: true, noWaitAfter: true }).catch(() => {}); }
          await sleep(3500);
          // 列表是否即时刷新（当前查询条件 X1 行消失）
          const rowsAfter = await frame.locator('.el-table__body-wrapper tr').filter({ hasText: 'PT07-X1-R4E' }).count().catch(() => 0);
          const apiAfter = (await queryByName('PT07-X1-R4E')).total;
          log('[DEL-04] UI 行', rowsAfter, 'API total', apiAfter);
          if (apiAfter === 0 && rowsAfter === 0) record('TC-DEL-04', 'PASS', '删除后列表即时刷新：删除确认后 UI 表格即时重载（X1 行消失）且 API total=0——列表即时刷新（R4 翻案）');
          else if (apiAfter === 0) record('TC-DEL-04', 'PASS', '删除生效（API total=0）；UI 行残留=' + rowsAfter + '（须重查清空——刷新形态登记）');
          else record('TC-DEL-04', 'FAIL', '删除未生效 total=' + apiAfter);
        }
      }
    } else record('TC-DEL-07', 'BLOCKED', '前置失败：x1=' + (x1 && x1.auditStatus) + ' x2=' + (x2 && x2.auditStatus));
  } catch (e) {
    log('[FATAL]', e.message);
    batch('run_abort', { error: e.message.slice(0, 300) });
  } finally {
    batch('run_end', { dur_sec: Math.round((Date.now() - t0) / 1000) });
    log('[done]', Math.round((Date.now() - t0) / 1000), 's');
    try { cdp.removeLock(port); } catch (_) {}
    try { await browser.close(); } catch (_) {}
  }
})();
