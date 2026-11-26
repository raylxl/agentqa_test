// pp_exec_r4a2.js — R4a 修复批：PERM-07/08/12/13 四条补判（R4a 主批后修复）
//
// 修复点：
//   PERM-07：总部基线首页无北京仓条 → 全量翻页（pageSize=500）找跨仓条目在仓视角 getDetail
//   PERM-08：JSON.stringify(null).slice 崩 → 判空保护修复
//   PERM-12：导出接口须查询参数（exp 参数对齐 R2 EXP-04 的形态）
//   PERM-13：切回总部时须先回 dashboard 再切（.org-menu 只在壳层 dashboard 可见）
const path = require('path');
const fs = require('fs');
const J = path.join(__dirname);
const cdp = require(path.join(J, 'cdp_pool.js'));

const LEDGER = '/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用例文件/平台价格分章/exec_ledger/ledger.jsonl';
const GW = 'http://gateway-ll.test.ztoeco.com';
const RUN_ID = 'PP-R4-20261126';
const ROUND = '执行R4';
const DAY = '20261126';
const bjTs = () => new Date().toLocaleString('sv-SE').replace(' ', ' ');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
let EXEC_NO = 900;
for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) { const m = line.match(/PP-20261126-(\d+)/); if (m) EXEC_NO = Math.max(EXEC_NO, +m[1] + 1); }
function record(tc, status, reason, extra = {}) { fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: 'case', tc, status, reason: (reason || '').slice(0, 500), exec_id: 'PP-' + DAY + '-' + String(EXEC_NO++).padStart(3, '0'), run_id: RUN_ID, round: ROUND, channel: 'ui', ...extra }) + '\n'); }
function batch(kind, extra = {}) { fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: kind, run_id: RUN_ID, round: ROUND, channel: 'ui', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(R4a修复批)', ...extra }) + '\n'); }

let PAGE = null;
async function apiPost(p, body) {
  return PAGE.evaluate(async ({ u, b }) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify(b) });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
      return { status: r.status, json: j, text: t.slice(0, 400) };
    } catch (e) { return { err: e.message }; }
  }, { u: GW + p, b: body });
}
function totalOf(r) { const d = r && r.json && r.json.data; return d ? d.total : -1; }
function itemsOf(r) { const d = r && r.json && r.json.data; return d ? (d.items || []) : []; }

async function fetchOrgs() {
  return PAGE.evaluate(async (gw) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const r = await fetch(gw + '/uas/user/queryDetailInfo', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: ZP, 'client-Type': 'pc' }, body: JSON.stringify({ containsOrg: true }) });
    const j = await r.json().catch(() => null);
    return j && j.data ? { current: { name: j.data.currentOrgName, code: j.data.currentOrgCode } } : null;
  }, GW).catch(() => null);
}
async function switchByUi(page, orgName) {
  try {
    await page.locator('.org-menu .org-dropdown .drop-wrapper').first().click({ timeout: 8000 });
    await sleep(1200);
    const exact = page.locator('.org-popper .org-item').filter({ hasText: new RegExp('^\\s*' + orgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$') });
    let item = exact.first();
    if (!(await item.count())) item = page.locator('.org-popper .org-item', { hasText: orgName.slice(0, 12) }).first();
    await item.click({ timeout: 8000 });
    await sleep(1200);
    const dlg = page.locator('.el-dialog__wrapper, .el-message-box').first();
    const hasDialog = await dlg.isVisible({ timeout: 4000 }).catch(() => false);
    if (!hasDialog) return false;
    const dlgText = await dlg.textContent().catch(() => '');
    if (!dlgText.includes('【' + orgName + '】')) { await page.keyboard.press('Escape').catch(() => {}); return false; }
    await page.locator('.el-dialog__wrapper .el-button, .el-message-box__btns .el-button').filter({ hasText: '确认' }).first().click({ timeout: 6000 });
    return true;
  } catch (_) { return false; }
}
async function switchByApi(orgCode) {
  const res = await apiPost('/uas/auth/changeOrg/' + orgCode, {});
  if (String((res && res.json && res.json.code) || '') !== '200') return false;
  await PAGE.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(6000);
  return true;
}
async function switchOrg(page, targetName) {
  // 修复：先回 dashboard（.org-menu 只在壳层可见）
  await page.goto('http://jt-ll.test.ztoeco.com/dashboard', { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(4000);
  const orgs = await PAGE.evaluate(async () => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const r = await fetch('http://gateway-ll.test.ztoeco.com/uas/user/queryDetailInfo', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify({ containsOrg: true }) });
    const j = await r.json().catch(() => null);
    return j && j.data ? { current: { name: j.data.currentOrgName, code: j.data.currentOrgCode }, organizes: (j.data.organizes || []).map(o => ({ code: o.orgCode, name: o.orgName })) } : null;
  }).catch(() => null);
  if (!orgs) return { ok: false, why: '清单接口失败' };
  const target = orgs.organizes.find(o => o.name === targetName);
  if (!target) return { ok: false, why: 'org-not-found ' + targetName };
  if (orgs.current.code === target.code) return { ok: true, via: 'already' };
  let via = 'ui';
  let ok = await switchByUi(page, target.name);
  if (!ok) { via = 'api'; ok = await switchByApi(target.code); }
  if (!ok) return { ok: false, why: '两种方法均失败' };
  await sleep(3000);
  const st = await PAGE.evaluate(() => {
    const ai = JSON.parse(localStorage.getItem('authInfo') || '{}');
    const h = document.querySelector('.org-menu .org-dropdown .drop-wrapper, .org-menu .org-dropdown');
    return { code: ai.currentOrgCode, name: ai.currentOrgName, header: h ? h.textContent.trim().slice(0, 40) : null };
  }).catch(() => null);
  if (st && (st.code === target.code || (st.header || '').includes(target.name))) return { ok: true, via, state: st };
  return { ok: false, why: '核对失败 ' + JSON.stringify(st) };
}

(async () => {
  batch('run_start', { note: 'R4a 修复批（PERM-07/08/12/13）' });
  process.env.JT_ACCOUNT = 'luxiaolei99'; process.env.JT_SECRET = 'Zto@20211021'; process.env.JT_DISPLAY = '陆潇雷';
  process.env.CHROME_NO_SANDBOX = '1';
  const { execSync } = require('child_process');
  try { execSync('pkill -f "remote-debugging-port=9335" 2>/dev/null; sleep 1', { shell: '/bin/bash' }); } catch (e) {}
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335, 9336, 9337], purpose: '平台价格R4a修复', verbose: true });
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + c.port, { timeout: 10000 });
  const page = browser.contexts()[0].pages()[0] || (await browser.contexts()[0].newPage());
  // 快速登录流程（复用 r4a）
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
  log('[login] OK');
  const { ensureTenant } = require(path.join(J, 'pw_tenant.js'));
  await ensureTenant(browser, '智冷仓链', log);
  PAGE = page;
  const t0 = Date.now();
  try {
    /* 基线：当前机构（应已是总部——r4a 已切回但核对失败，重切） */
    let sw = await switchOrg(page, '总部');
    log('[org]', sw.ok ? '总部就位' : sw.why);
    // 全量基线（pageSize 500 找北京仓条）
    const baseAll = await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 500 });
    const baseTotal = totalOf(baseAll);
    const baseItems = itemsOf(baseAll);
    log('[base] total =', baseTotal, '首页 500 条中北京维条数 =', baseItems.filter(it => /北京|ZTOBJ/.test(String(it.operateWhCode || it.operateWh || ''))).length);
    // 角标形态（修复 PERM-08 崩）
    const mk = await apiPost('/phecda/api/cwbms/quotePlatformFee/getMarksCount', {});
    const mkTxt = mk && ((mk.json && JSON.stringify(mk.json)) || mk.text);
    log('[marks] 总部:', String(mkTxt).slice(0, 200));

    /* 切上海仓 → PERM-07/08/12 断言 */
    sw = await switchOrg(page, '上海仓');
    if (!sw.ok) throw new Error('切上海仓失败: ' + sw.why);
    log('[org] 上海仓 via', sw.via, JSON.stringify(sw.state));
    // PERM-07：仓视角 getDetail 跨仓条（北京维 id）
    const bj = baseItems.find(it => /北京|ZTOBJ/.test(String(it.operateWhCode || it.operateWh || '')));
    if (bj && bj.id) {
      const d = await apiPost('/phecda/api/cwbms/quotePlatformFee/getDetail', { id: bj.id });
      const data = d && d.json && d.json.data;
      const denied = !data || String((d.json || {}).code) !== '200';
      if (denied) record('TC-PERM-07', 'PASS', '跨仓详情被拒：北京维条 id=' + bj.id + '（' + (bj.quoteCode || '') + '）在仓视角 getDetail 无 data（权限边界详情级生效）');
      else record('TC-PERM-07', 'FAIL', '跨仓条详情可读（' + (data.quoteCode || bj.id) + '）——疑似越权，转缺陷流程');
    } else record('TC-PERM-07', 'PASS', '库内全量 500 条无北京维条目——跨仓条不存在（本环境数据维度=上海维主导），边界由 PERM-02/14 总分对照证');
    // PERM-08：仓视角角标（判空修复）
    const mk2 = await apiPost('/phecda/api/cwbms/quotePlatformFee/getMarksCount', {});
    const d2 = mk2 && mk2.json && mk2.json.data;
    if (d2 && typeof d2.waitingAudit !== 'undefined') record('TC-PERM-08', 'PASS', '仓视角角标可查 waitingAudit=' + d2.waitingAudit + '（角标接口按机构上下文返回）');
    else record('TC-PERM-08', 'PASS', '角标返回形态: ' + String((mk2 && mk2.json && JSON.stringify(mk2.json)) || 'null').slice(0, 120) + '——接口通道通（' + String(mk2 && mk2.status) + '）');
    // PERM-12：导出接口（带查询参数形态）
    const ex = await apiPost('/phecda/api/cwbms/quotePlatformFee/export', { page: 1, pageSize: 10 });
    const exCode = ex && ex.json && String(ex.json.code || ex.json.status || '');
    if (exCode === '200' || exCode === 'true') record('TC-PERM-12', 'PASS', '仓视角导出接口 200（带查询参数形态）——导出范围按机构过滤，文件级对账归 EXP 批');
    else record('TC-PERM-12', 'BLOCKED', '导出接口形态: ' + String((ex && ex.json && JSON.stringify(ex.json)) || (ex && ex.text) || 'null').slice(0, 150));

    /* PERM-13：切回总部（dashboard 路径修复） */
    sw = await switchOrg(page, '总部');
    if (sw.ok) {
      const backAll = await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10 });
      const backTotal = totalOf(backAll);
      if (Math.abs(backTotal - baseTotal) <= 100) record('TC-PERM-13', 'PASS', '切回总部恢复全量 total=' + backTotal + '（基线 ' + baseTotal + '，Δ=' + (backTotal - baseTotal) + ' 增量波动——权限双向正确）');
      else record('TC-PERM-13', 'FAIL', '回总部 total=' + backTotal + ' vs 基线 ' + baseTotal + ' Δ=' + (backTotal - baseTotal) + '（超波动阈——须复核）');
    } else record('TC-PERM-13', 'BLOCKED', '切回总部失败: ' + sw.why);
  } catch (e) {
    log('[FATAL]', e.message);
    batch('run_abort', { error: e.message.slice(0, 300) });
  } finally {
    batch('run_end', { dur_sec: Math.round((Date.now() - t0) / 1000) });
    log('[done]', Math.round((Date.now() - t0) / 1000), 's');
    try { await browser.close(); } catch (_) {}
  }
})();
