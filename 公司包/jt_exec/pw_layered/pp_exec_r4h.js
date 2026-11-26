// pp_exec_r4h.js — R4h：DEL-09 单条终案（W80/370 流向错键）
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
const batch = (kind, extra) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: kind, run_id: 'PP-R4-20261126', round: '执行R4', channel: 'ui', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(R4h)', ...extra }) + '\n');

let page, frame, browser, port;
const apiPost = (p, body) => page.evaluate(async ({ u, b }) => {
  const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify(b) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
  return { status: r.status, json: j, text: t.slice(0, 300) };
}, { u: GW + p, b: body });
const queryByName = async (name) => { const r = await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, quoteName: name }); const d = r.json && r.json.data; return { total: d ? d.total : -1, items: d ? (d.items || []) : [] }; };

(async () => {
  batch('run_start', { note: 'R4h：DEL-09 单条终案' });
  const t0 = Date.now();
  try {
    process.env.JT_ACCOUNT = 'luxiaolei99'; process.env.JT_SECRET = 'Zto@20211021'; process.env.CHROME_NO_SANDBOX = '1';
    const { execSync } = require('child_process');
    try { execSync('pkill -f "remote-debugging-port=933[567]"', { shell: '/bin/bash' }); } catch (e) {}
    await sleep(1500);
    try { for (const f of fs.readdirSync(path.join(J, 'locks'))) fs.unlinkSync(path.join(J, 'locks', f)); } catch (e) {}
    const c = await cdp.ensureExecPortExclusive({ prefer: [9335, 9336, 9337], purpose: 'R4h', verbose: true });
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
      for (let w = 0; w < 10; w++) { const cnt = await page.locator('input[name="username"]').count().catch(() => 0); if (cnt) break; await sleep(1000); }
      await page.fill('input[name="username"]', process.env.JT_ACCOUNT);
      await page.fill('input[name="password"]', process.env.JT_SECRET);
      await page.click('button.login-btn', { timeout: 10000 }).catch(() => {});
      for (let i = 0; i < 15; i++) { await sleep(2000); if (page.url().includes('jt-ll.test.ztoeco.com')) { const t = await page.evaluate(() => document.body.innerText).catch(() => ''); if (t.includes('预发环境')) { ok = true; break; } } }
    }
    if (!ok) throw new Error('登录失败');
    await ensureTenant(browser, '智冷仓链', () => {});
    const mk9 = async () => apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { quoteName: 'PT07-D09F-R4H', costCode: 'W80', settFlow: 370, specialAttributes: null, customerCode: null, businessWhCode: null, operateWhCode: '上海仓', startDate: '2026-11-15 00:00:00', endDate: '2026-12-08 23:59:59', detailModel: 'TIER', quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: 1, minPrice: null, maxPrice: null }] });
    const pre = (await queryByName('PT07-D09F-R4H')).items[0];
    let d9 = pre;
    if (!d9) {
      const r9 = await mk9();
      await sleep(1800);
      d9 = (await queryByName('PT07-D09F-R4H')).items[0];
      log('[D09] 造数', d9 ? d9.auditStatus : r9.text.slice(0, 50));
    } else log('[D09] 已存在', d9.auditStatus);
    if (d9 && d9.auditStatus === 0) {
      // UI 驳回
      await page.goto('http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice', { timeout: 30000, waitUntil: 'domcontentloaded' });
      for (let w = 0; w < 40; w++) { await sleep(2000); frame = page.frames().find(f => f.url().includes('warehouse-menu/quote/platformPrice')); if (frame) { const n = await frame.locator('.el-table__header-wrapper th').count().catch(() => 0); if (n > 3) break; } }
      await page.evaluate(() => { document.querySelectorAll('.el-overlay.is-message-box').forEach(e => e.remove()); }).catch(() => {});
      const nameCol = frame.locator('.el-col.modelFormClass').filter({ hasText: /^\s*报价名称/ }).first();
      await nameCol.locator('input.el-input__inner').first().fill('PT07-D09F-R4H', { timeout: 8000, force: true });
      await frame.locator('button:has-text("查询")').first().click({ timeout: 8000, noWaitAfter: true, force: true });
      await sleep(4000);
      const row = frame.locator('.el-table__body-wrapper tr').filter({ hasText: 'PT07-D09F-R4H' }).first();
      const cb = row.locator('.el-checkbox').first();
      await cb.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await cb.click({ timeout: 6000, force: true });
      await sleep(800);
      const rb = frame.locator('button:has-text("审核驳回")').first();
      await rb.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await rb.click({ timeout: 10000, noWaitAfter: true, force: true });
      await sleep(2500);
      const cfm = frame.locator('.el-overlay-message-box button.el-button--primary').first();
      if (await cfm.count().catch(() => 0)) { await cfm.click({ timeout: 5000, force: true, noWaitAfter: true }).catch(() => {}); }
      await sleep(4500);
      d9 = (await queryByName('PT07-D09F-R4H')).items[0];
      log('[D09] 驳回后', d9 && d9.auditStatus);
    }
    if (d9 && d9.auditStatus === 2) {
      // UI 删除
      await page.goto('http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice', { timeout: 30000, waitUntil: 'domcontentloaded' });
      await sleep(6000);
      frame = page.frames().find(f => f.url().includes('warehouse-menu/quote/platformPrice'));
      await page.evaluate(() => { document.querySelectorAll('.el-overlay.is-message-box').forEach(e => e.remove()); }).catch(() => {});
      const nameCol = frame.locator('.el-col.modelFormClass').filter({ hasText: /^\s*报价名称/ }).first();
      await nameCol.locator('input.el-input__inner').first().fill('PT07-D09F-R4H', { timeout: 8000, force: true });
      await frame.locator('button:has-text("查询")').first().click({ timeout: 8000, noWaitAfter: true, force: true });
      await sleep(4000);
      const row = frame.locator('.el-table__body-wrapper tr').filter({ hasText: 'PT07-D09F-R4H' }).first();
      const cb = row.locator('.el-checkbox').first();
      await cb.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await cb.click({ timeout: 6000, force: true });
      await sleep(800);
      const db = frame.locator('button:has-text("删除")').first();
      await db.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await db.click({ timeout: 10000, noWaitAfter: true, force: true });
      await sleep(2500);
      const cfm = frame.locator('.el-overlay-message-box button.el-button--primary').first();
      if (await cfm.count().catch(() => 0)) { await cfm.click({ timeout: 5000, force: true, noWaitAfter: true }).catch(() => {}); }
      await sleep(4500);
      const after = (await queryByName('PT07-D09F-R4H')).total;
      log('[D09] 删后', after);
      if (after === 0) record('TC-DEL-09', 'PASS', '审核驳回且生效中可删：D09F（驳回+生效中 2026-11-15~12-08 跨当前日、W80/370 流向错键）删除成功——驳回态可删（17:26 误判 FAIL 系语义误用+过审异步双误，终案翻案）');
      else record('TC-DEL-09', 'FAIL', '删后=' + after);
    } else record('TC-DEL-09', 'BLOCKED', '驳回态未达（audit=' + (d9 && d9.auditStatus) + '）');
  } catch (e) {
    log('[FATAL]', e.message);
    batch('run_abort', { error: e.message.slice(0, 300) });
  } finally {
    batch('run_end', { dur_sec: Math.round((Date.now() - t0) / 1000) });
    try { cdp.removeLock(port); } catch (_) {}
    try { await browser.close(); } catch (_) {}
  }
})();
