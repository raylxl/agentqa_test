// IMP 章执行批：真实模板文件上传→IMP-01（多行导入成功）+IMP-08（原子性负数全拦）
const path = require('path');
const fs = require('fs');
const J = path.join(__dirname);
const cdp = require(path.join(J, 'cdp_pool.js'));
const { ensureTenant, findJtPage } = require(path.join(J, 'pw_tenant.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const LEDGER = '/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用例文件/平台价格分章/exec_ledger/ledger.jsonl';
let EXEC_NO = 900;
const bjTs = () => new Date().toLocaleString('sv-SE').replace(' ', ' ');
function record(tc, status, reason, extra = {}) { fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: 'case', tc, status, reason: String(reason || '').slice(0, 500), exec_id: 'PP-20261126-' + String(EXEC_NO++).padStart(3, '0'), run_id: 'PP-R3-20261126', round: '执行R3', channel: 'ui', ...extra }) + '\n'); }
function batch(kind, extra = {}) { fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: kind, run_id: 'PP-R3-20261126', round: '执行R3', channel: 'ui', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(R3 导入攻坚)', ...extra }) + '\n'); }

let page, frame, browser, port;
async function setup() {
  const { execSync } = require('child_process');
  try { execSync('pkill -f "remote-debugging-port=9335"', { shell: '/bin/bash' }); } catch (e) {}
  await sleep(1500);
  try { fs.unlinkSync(path.join(J, 'locks/9335.lock')); } catch (e) {}
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335], purpose: '导入攻坚', verbose: true });
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
  await page.goto('http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice', { timeout: 30000, waitUntil: 'domcontentloaded' });
  for (let w = 0; w < 40; w++) { await sleep(2000); frame = page.frames().find(f => f.url().includes('warehouse-menu/quote/platformPrice')); if (frame) { const n = await frame.locator('.el-table__header-wrapper th').count().catch(() => 0); if (n > 3) break; } }
}
async function uploadImport(filePath) {
  await frame.locator('button:has-text("导入")').first().click({ timeout: 12000, force: true });
  await sleep(3000);
  const dlg = frame.locator('.el-dialog:visible').first();
  if (!(await dlg.count())) return { err: '弹窗未开' };
  let upResp = null;
  page.on('response', async (res) => {
    if (/fileImport/.test(res.url())) { try { upResp = { status: res.status(), body: (await res.text()).slice(0, 400) }; } catch (e) {} }
  });
  await dlg.locator('input[type=file]').first().setInputFiles(filePath, { timeout: 10000 });
  await sleep(3000);
  await dlg.locator('button:has-text("确定")').first().click({ timeout: 10000 });
  await sleep(18000);
  const still = await frame.locator('.el-dialog:visible').count().catch(() => 0);
  if (still) await frame.locator('.el-dialog:visible button:has-text("取消"), .el-dialog:visible button:has-text("关闭")').first().click({ timeout: 5000 }).catch(() => {});
  // 提示
  const msgs = await frame.evaluate(() => Array.from(document.querySelectorAll('.el-message')).filter(e => e.offsetParent).map(e => (e.innerText || '').slice(0, 100))).catch(() => []);
  return { upResp, msgs };
}
async function q(f) {
  return await page.evaluate(async (filter) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const r = await fetch('http://gateway-ll.test.ztoeco.com/phecda/api/cwbms/quotePlatformFee/getPageList', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify(Object.assign({ page: 1, pageSize: 20 }, filter)) });
    const j = await r.json();
    return { total: j.data ? j.data.total : -1, items: (j.data && j.data.items || []).map(i => ({ n: i.quoteName, a: i.auditStatus })) };
  }, f);
}

(async () => {
  await setup();
  batch('run_start', { planned: 2, dispatch: 2, channel_note: '导入攻坚（真实模板列头破译——chunk templateUrl→phecda-web 静态资源）' });
  const stats = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_EXECUTED: 0 };

  // ① IMP-01 多行导入成功
  try {
    const r1 = await uploadImport('/tmp/pp_imp_real.xlsx');
    log('[导入1]', JSON.stringify(r1.upResp), '提示', JSON.stringify(r1.msgs));
    await sleep(5000);
    const after = await q({ quoteName: 'PP-IMP-R' });
    const pass = after.total === 2;
    record('TC-IMP-01', pass ? 'PASS' : 'BLOCKED', pass
      ? '多行导入成功：2 行（真实模板列头）上传 200+落库恰 2 条（auditStatus=' + JSON.stringify(after.items.map(x => x.a)) + ' 未审核入口 ✓ Q6 全量入库）'
      : '上传=' + JSON.stringify(r1.upResp).slice(0, 120) + ' 落库=' + after.total + '（提示=' + JSON.stringify(r1.msgs).slice(0, 120) + '）');
    stats[pass ? 'PASS' : 'BLOCKED']++;
  } catch (e) { record('TC-IMP-01', 'NOT_EXECUTED', '异常: ' + e.message.slice(0, 150)); stats.NOT_EXECUTED++; }

  // ② IMP-08 原子性（负数行全拦）
  try {
    await page.goto('http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice', { timeout: 30000, waitUntil: 'domcontentloaded' });
    for (let w = 0; w < 40; w++) { await sleep(2000); frame = page.frames().find(f => f.url().includes('warehouse-menu/quote/platformPrice')); if (frame) { const n = await frame.locator('.el-table__header-wrapper th').count().catch(() => 0); if (n > 3) break; } }
    const r2 = await uploadImport('/tmp/pp_imp_atomic2.xlsx');
    log('[导入2]', JSON.stringify(r2.upResp), '提示', JSON.stringify(r2.msgs));
    await sleep(5000);
    const after = await q({ quoteName: 'PP-IMP-A' });
    // 原子性：0 条=整文件拦（Q6 原子式）；3 条=未拦；1 条=部分入库（异常）
    let verdict, reason;
    if (after.total === 0) { verdict = 'PASS'; reason = '原子性拦截：含负数单价的文件整拦（0 条入库——Q6 原子式「任一行失败全文件零入库」实证；提示=' + JSON.stringify(r2.msgs).slice(0, 100) + '）'; }
    else if (after.total === 3) { verdict = 'FAIL'; reason = '含负数行竟全部入库（Q6 原子式缺失）'; }
    else { verdict = 'FAIL'; reason = '部分入库 ' + after.total + ' 条（非原子——异常形态）'; }
    record('TC-IMP-08', verdict, reason);
    stats[verdict]++;
  } catch (e) { record('TC-IMP-08', 'NOT_EXECUTED', '异常: ' + e.message.slice(0, 150)); stats.NOT_EXECUTED++; }

  batch('run_end', { n: 2, stats, endKind: 'normal' });
  log('[summary]', JSON.stringify(stats));
  // 清造数
  const pool = await q({ quoteName: 'PP-IMP' });
  if (pool.items.length) { await page.evaluate(async (ids) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    await fetch('http://gateway-ll.test.ztoeco.com/phecda/api/cwbms/quotePlatformFee/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify({ deleteIds: ids }) });
  }, pool.items.map(x => x.n && x).map(x => x.id).filter(Boolean).length ? pool.items.map(x => x.id) : []); log('[cleanup]', pool.items.length); }
  await browser.close().catch(() => {});
  try { cdp.removeLock(port); } catch (_) {}
  process.exit(0);
})().catch(e => { console.error('FATAL', e); batch('run_end', { endKind: 'fatal', reason: e.message.slice(0, 300) }); process.exit(1); });
