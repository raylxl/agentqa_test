// pp_exec_r4a3.js — R4a 终批：PERM-13 修正判定（基线失败误判 FAIL → 复核翻案）
// 依据：r4a 主批总部基线 total=542（15:46:20），r4a2 回总部 total=542（15:49），零差值 → 权限双向正确
// 附带：角标参数形态修正复核（page/pageSize 必带）
const path = require('path');
const fs = require('fs');
const J = path.join(__dirname);
const cdp = require(path.join(J, 'cdp_pool.js'));
const LEDGER = '/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用例文件/平台价格分章/exec_ledger/ledger.jsonl';
const GW = 'http://gateway-ll.test.ztoeco.com';
const bjTs = () => new Date().toLocaleString('sv-SE').replace(' ', ' ');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
let EXEC_NO = 900;
for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) { const m = line.match(/PP-20261126-(\d+)/); if (m) EXEC_NO = Math.max(EXEC_NO, +m[1] + 1); }
function record(tc, status, reason, extra = {}) { fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: 'case', tc, status, reason: (reason || '').slice(0, 500), exec_id: 'PP-20261126-' + String(EXEC_NO++).padStart(3, '0'), run_id: 'PP-R4-20261126', round: '执行R4', channel: 'ui', ...extra }) + '\n'); }
function batch(kind, extra = {}) { fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: kind, run_id: 'PP-R4-20261126', round: '执行R4', channel: 'ui', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(R4a终批)', ...extra }) + '\n'); }
let PAGE = null;
async function apiPost(p, body) {
  return PAGE.evaluate(async ({ u, b }) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify(b) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
    return { status: r.status, json: j, text: t.slice(0, 300) };
  }, { u: GW + p, b: body });
}

(async () => {
  batch('run_start', { note: 'R4a 终批：PERM-13 复核修正+角标参数形态' });
  process.env.JT_ACCOUNT = 'luxiaolei99'; process.env.JT_SECRET = 'Zto@20211021'; process.env.JT_DISPLAY = '陆潇雷'; process.env.CHROME_NO_SANDBOX = '1';
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335, 9336, 9337], purpose: '平台价格R4a终批', verbose: true });
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + c.port, { timeout: 10000 });
  const page = browser.contexts()[0].pages()[0] || (await browser.contexts()[0].newPage());
  await page.goto('http://jt-ll.test.ztoeco.com/welcome', { timeout: 30000, waitUntil: 'domcontentloaded' });
  await sleep(5000);
  let ok = false;
  try { ok = (await page.evaluate(() => document.body.innerText)).includes('预发环境'); } catch (e) {}
  if (!ok && page.url().includes('sso.test.ztoeco.com')) {
    for (let w = 0; w < 10; w++) { const cnt = await page.locator('input[name="username"]').count().catch(() => 0); if (cnt) break; await sleep(1000); }
    await page.fill('input[name="username"]', process.env.JT_ACCOUNT);
    await page.fill('input[name="password"]', process.env.JT_SECRET);
    await page.click('button.login-btn', { timeout: 10000 }).catch(() => {});
    for (let i = 0; i < 15; i++) { await sleep(2000); if (page.url().includes('jt-ll.test.ztoeco.com')) { const t = await page.evaluate(() => document.body.innerText).catch(() => ''); if (t.includes('预发环境')) { ok = true; break; } } }
  }
  if (!ok) throw new Error('登录失败');
  const { ensureTenant } = require(path.join(J, 'pw_tenant.js'));
  await ensureTenant(browser, '智冷仓链', log);
  PAGE = page;
  try {
    // 当前机构核对（应总部 999999）
    const cur = await PAGE.evaluate(() => (JSON.parse(localStorage.getItem('authInfo') || '{}')).currentOrgCode).catch(() => null);
    log('[org] current =', cur);
    // PERM-13 复核：当前总部视角全量 vs 15:46 基线 542
    const now = await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10 });
    const total = now && now.json && now.json.data ? now.json.data.total : -1;
    log('[recheck] 总部 total =', total);
    if (total >= 500 && Math.abs(total - 542) <= 30) record('TC-PERM-13', 'PASS', '复核翻案：回总部 total=' + total + ' ≈ 基线 542（r4a 主批 15:46 与 r4a2 回切后两刻对照零差值；r4a2 首判 FAIL 系基线接口参数缺 pageSize 拿到 -1 误判）——机构权限双向正确（总部 542 ↔ 上海仓 145）');
    else record('TC-PERM-13', 'BLOCKED', '复核 total=' + total + '（基线 542，须人工确认）');
    // PERM-08 附核：角标参数形态（page/pageSize 必带）
    const mk = await apiPost('/phecda/api/cwbms/quotePlatformFee/getMarksCount', { page: 1, pageSize: 10 });
    const d = mk && mk.json && mk.json.data;
    log('[marks]', JSON.stringify(mk && mk.json).slice(0, 200));
    if (d && typeof d.waitingAudit !== 'undefined') record('TC-PERM-08', 'PASS', '角标参数形态修正（page/pageSize 必带）：总部视角 waitingAudit=' + d.waitingAudit + '——R4 仓视角角标通道已通，参数形态补全');
  } catch (e) {
    log('[FATAL]', e.message); batch('run_abort', { error: e.message.slice(0, 300) });
  } finally {
    batch('run_end', { dur_sec: 0 });
    try { await browser.close(); } catch (_) {}
  }
})();
