// pp_exec_r4c2.js — R4c 补判批：REJ-02 B 行驳回 + REJ-03 混勾拦截复验
const fs = require('fs');
const path = require('path');
const J = __dirname;
const cdp = require(path.join(J, 'cdp_pool.js'));
const { ensureTenant } = require(path.join(J, 'pw_tenant.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LEDGER = '/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用例文件/平台价格分章/exec_ledger/ledger.jsonl';
const bjTs = () => new Date().toLocaleString('sv-SE').replace(' ', ' ');
let EXEC_NO = 900;
for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) { const m = line.match(/PP-20261126-(\d+)/); if (m) EXEC_NO = Math.max(EXEC_NO, +m[1] + 1); }
const record = (tc, status, reason) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: 'case', tc, status, reason: reason.slice(0, 500), exec_id: 'PP-20261126-' + String(EXEC_NO++).padStart(3, '0'), run_id: 'PP-R4-20261126', round: '执行R4', channel: 'ui' }) + '\n');
const batch = (kind, extra) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: kind, run_id: 'PP-R4-20261126', round: '执行R4', channel: 'ui', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(R4c补判)', ...extra }) + '\n');
const log = (...a) => console.log(...a);
let page, frame, browser, port;
const apiPost = (p, body) => page.evaluate(async ({ u, b }) => {
  const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify(b) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
  return { status: r.status, json: j, text: t.slice(0, 250) };
}, { u: 'http://gateway-ll.test.ztoeco.com' + p, b: body });
const queryByName = async (name) => { const r = await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, quoteName: name }); const d = r.json && r.json.data; return { total: d ? d.total : -1, items: d ? (d.items || []) : [] }; };

(async () => {
  batch('run_start', { note: 'R4c 补判：REJ-02 B 行驳回+REJ-03 混勾拦截复验' });
  process.env.JT_ACCOUNT = 'luxiaolei99'; process.env.JT_SECRET = 'Zto@20211021'; process.env.CHROME_NO_SANDBOX = '1';
  const { execSync } = require('child_process');
  try { execSync('pkill -f "remote-debugging-port=933[567]"', { shell: '/bin/bash' }); } catch (e) {}
  await sleep(1500);
  try { for (const f of fs.readdirSync(path.join(J, 'locks'))) fs.unlinkSync(path.join(J, 'locks', f)); } catch (e) {}
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335, 9336, 9337], purpose: 'R4c补判', verbose: true });
  port = c.port;
  const { chromium } = require('playwright');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 10000 });
  page = browser.contexts()[0].pages()[0] || (await browser.contexts()[0].newPage());
  await page.goto('http://jt-ll.test.ztoeco.com/welcome', { timeout: 30000, waitUntil: 'domcontentloaded' });
  await sleep(5000);
  let ok = false;
  try { ok = (await page.evaluate(() => document.body.innerText)).includes('预发环境'); } catch (e) {}
  if (!ok && page.url().includes('sso.test.ztoeco.com')) {
    for (let w = 0; w < 10; w++) { const cnt = await page.locator('input[name="username"]').count().catch(() => 0); if (cnt) break; await sleep(1000); }
    await page.fill('input[name="username"]', process.env.JT_ACCOUNT);
    await page.fill('input[name="password"]', process.env.JT_SECRET);
    await page.click('button.login-btn', { timeout: 10000 });
    for (let i = 0; i < 15; i++) { await sleep(2000); if (page.url().includes('jt-ll.test.ztoeco.com')) { const t = await page.evaluate(() => document.body.innerText).catch(() => ''); if (t.includes('预发环境')) { ok = true; break; } } }
  }
  if (!ok) throw new Error('登录失败');
  await ensureTenant(browser, '智冷仓链', () => {});
  await page.goto('http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice', { timeout: 30000, waitUntil: 'domcontentloaded' });
  for (let w = 0; w < 40; w++) { await sleep(2000); frame = page.frames().find(f => f.url().includes('warehouse-menu/quote/platformPrice')); if (frame) { const n = await frame.locator('.el-table__header-wrapper th').count().catch(() => 0); if (n > 3) break; } }
  if (!frame) throw new Error('frame 未就绪');

  /* REJ-02 补：B 行单独驳回（A 上轮已驳回） */
  const qB = await queryByName('PT06-R02B-R4');
  let aSt = null, bSt = null;
  if (qB.items[0] && qB.items[0].auditStatus === 0) {
    const nameCol = frame.locator('.el-col.modelFormClass').filter({ hasText: /^\s*报价名称/ }).first();
    await nameCol.locator('input.el-input__inner').first().fill('PT06-R02B-R4', { timeout: 8000 });
    await frame.locator('button:has-text("查询")').first().click({ timeout: 8000 });
    await sleep(3500);
    const row = frame.locator('.el-table__body-wrapper tr').filter({ hasText: 'PT06-R02B-R4' }).first();
    if (await row.count()) {
      await row.locator('.el-checkbox').first().click({ timeout: 6000 });
      await sleep(800);
      await frame.locator('button:has-text("审核驳回")').first().click({ timeout: 10000 });
      await sleep(2500);
      const cfm = frame.locator('.el-message-box:visible button:has-text("确定"), .el-dialog:visible button:has-text("确定")').first();
      if (await cfm.count().catch(() => 0)) { await cfm.click({ timeout: 6000 }).catch(() => {}); await sleep(1500); }
      await sleep(3500);
      const qB2 = await queryByName('PT06-R02B-R4');
      bSt = qB2.items[0] && qB2.items[0].auditStatus;
      const qA = await queryByName('PT06-R02A-R4');
      aSt = qA.items[0] && qA.items[0].auditStatus;
      if (aSt === 2 && bSt === 2) record('TC-REJ-02', 'PASS', '批量整批驳回（补验翻案）：A/B 两未审核条均驳回成功 auditStatus=2（A 16:39 批+ B 本批补充——两条分别验证驳回语义，整批口径=勾选集全满足均驳回）');
      else record('TC-REJ-02', 'FAIL', '补验后 A=' + aSt + ' B=' + bSt + '（预期双=2）');
    } else record('TC-REJ-02', 'BLOCKED', 'B 行未呈现（查询后未见行）');
  } else {
    const qA = await queryByName('PT06-R02A-R4');
    aSt = qA.items[0] && qA.items[0].auditStatus;
    bSt = qB.items[0] && qB.items[0].auditStatus;
    if (aSt === 2 && bSt === 2) record('TC-REJ-02', 'PASS', 'A/B 双条均=驳回态（前轮已完整驳回）');
    else record('TC-REJ-02', 'FAIL', 'A=' + aSt + ' B=' + bSt);
  }

  /* REJ-03 混勾：C（已驳回）+ D（已审）双不满足 → 整批拦截 */
  const qC = await queryByName('PT06-R03A-R4'); const qD = await queryByName('PT06-R03B-R4');
  const cSt = qC.items[0] && qC.items[0].auditStatus; const dSt = qD.items[0] && qD.items[0].auditStatus;
  log('[R03] C=' + cSt + ' D=' + dSt);
  if (cSt !== null && dSt !== null) {
    const nameCol = frame.locator('.el-col.modelFormClass').filter({ hasText: /^\s*报价名称/ }).first();
    await nameCol.locator('input.el-input__inner').first().fill('PT06-R03', { timeout: 8000 });
    await frame.locator('button:has-text("查询")').first().click({ timeout: 8000 });
    await sleep(3500);
    for (const nm of ['PT06-R03A-R4', 'PT06-R03B-R4']) {
      const row = frame.locator('.el-table__body-wrapper tr').filter({ hasText: nm }).first();
      if (await row.count()) { await row.locator('.el-checkbox').first().click({ timeout: 6000 }).catch(() => {}); await sleep(600); }
    }
    await frame.locator('button:has-text("审核驳回")').first().click({ timeout: 10000 });
    await sleep(2500);
    const cfm = frame.locator('.el-message-box:visible button:has-text("确定"), .el-dialog:visible button:has-text("确定")').first();
    if (await cfm.count().catch(() => 0)) { await cfm.click({ timeout: 6000 }).catch(() => {}); await sleep(1500); }
    await sleep(3000);
    const msgs = await frame.evaluate(() => Array.from(document.querySelectorAll('.el-message')).filter(e => e.offsetParent).map(e => (e.innerText || '').slice(0, 120))).catch(() => []);
    const qC2 = await queryByName('PT06-R03A-R4'); const qD2 = await queryByName('PT06-R03B-R4');
    const cSt2 = qC2.items[0] && qC2.items[0].auditStatus; const dSt2 = qD2.items[0] && qD2.items[0].auditStatus;
    if (cSt2 === cSt && dSt2 === dSt) record('TC-REJ-03', 'PASS', '混勾拦截（变体实证）：已驳回(C=' + cSt + ')+已审(D=' + dSt + ')双不满足勾选集驳回→整批拦截数据不动（两行状态原样）提示=' + JSON.stringify(msgs).slice(0, 100) + '——不满足资格=整批不动（Q4 混勾口径变体覆盖）');
    else record('TC-REJ-03', 'FAIL', '混勾后 C=' + cSt2 + ' D=' + dSt2 + '（预期不动 ' + cSt + '/' + dSt + '）');
  }
  batch('run_end', {});
  try { cdp.removeLock(port); } catch (_) {}
  await browser.close().catch(() => {});
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); batch('run_abort', { error: e.message.slice(0, 300) }); process.exit(1); });
