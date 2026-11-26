// pp_exec_r4d2.js — DEL-03 终批（全新窗造数：生效中 2026-12/已失效 2026-04）
const fs = require('fs');
const path = require('path');
const J = __dirname;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LEDGER = '/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用例文件/平台价格分章/exec_ledger/ledger.jsonl';
const bjTs = () => new Date().toLocaleString('sv-SE').replace(' ', ' ');
let EXEC_NO = 900;
for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) { const m = line.match(/PP-20261126-(\d+)/); if (m) EXEC_NO = Math.max(EXEC_NO, +m[1] + 1); }
const record = (tc, status, reason) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: 'case', tc, status, reason: reason.slice(0, 500), exec_id: 'PP-20261126-' + String(EXEC_NO++).padStart(3, '0'), run_id: 'PP-R4-20261126', round: '执行R4', channel: 'ui' }) + '\n');
const batch = (kind, extra) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: kind, run_id: 'PP-R4-20261126', round: '执行R4', channel: 'ui', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(R4d补2)', ...extra }) + '\n');
const log = (...a) => console.log(...a);

(async () => {
  batch('run_start', { note: 'DEL-03 终批（全新窗 2026-12/2026-04）' });
  const { chromium } = require('playwright');
  const http = require('http');
  const probe = (port) => new Promise(res => { const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 2000 }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(true)); }); req.on('error', () => res(false)); req.on('timeout', () => { req.destroy(); res(false); }); });
  let port = null;
  for (const p of [9335, 9336, 9337]) if (await probe(p)) { port = p; break; }
  if (!port) throw new Error('无可用实例');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 10000 });
  const page = browser.contexts()[0].pages().find(p => p.url().includes('jt-ll'));
  await page.goto('http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(8000);
  const apiPost = (p, body) => page.evaluate(async ({ u, b }) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify(b) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
    return { status: r.status, json: j, text: t.slice(0, 200) };
  }, { u: 'http://gateway-ll.test.ztoeco.com' + p, b: body });
  const queryByName = async (name) => { const r = await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, quoteName: name }); const d = r.json && r.json.data; return { total: d ? d.total : -1, items: d ? (d.items || []) : [] }; };
  const mk = (name, o) => apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { quoteName: name, costCode: 'W80', settFlow: 380, specialAttributes: o.sa === null ? null : '1', customerCode: null, businessWhCode: null, operateWhCode: null, startDate: o.s, endDate: o.e, detailModel: 'TIER', quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: 1, minPrice: null, maxPrice: null }] });
  // 全新窗：生效中=2026-12（跨当前 2026-11-26）、已失效=2026-04
  const ra = await mk('PT07-D03C-R4', { sa: null, s: '2026-12-01 00:00:00', e: '2026-12-31 23:59:59' });
  const rb = await mk('PT07-D03D-R4', { sa: null, s: '2026-04-01 00:00:00', e: '2026-04-30 23:59:59' });
  const qa = await queryByName('PT07-D03C-R4'); const qb = await queryByName('PT07-D03D-R4');
  log('造数 C', qa.total, ra.text.slice(0, 60), '| D', qb.total, rb.text.slice(0, 60));
  if (qa.items[0] && qb.items[0]) {
    await apiPost('/phecda/api/cwbms/quotePlatformFee/audit', { auditIds: [qa.items[0].id], auditStatus: 1 });
    await apiPost('/phecda/api/cwbms/quotePlatformFee/audit', { auditIds: [qb.items[0].id], auditStatus: 1 });
    await sleep(1500);
    const qa2 = await queryByName('PT07-D03C-R4'); const qb2 = await queryByName('PT07-D03D-R4');
    const aSt = qa2.items[0] && qa2.items[0].auditStatus; const bSt = qb2.items[0] && qb2.items[0].auditStatus;
    log('过审 C', aSt, 'D', bSt);
    const del = async (name) => {
      const fr = page.frames().find(f => f.url().includes('platformPrice'));
      if (!fr) return 'no-frame';
      const nameCol = fr.locator('.el-col.modelFormClass').filter({ hasText: /^\s*报价名称/ }).first();
      await nameCol.locator('input.el-input__inner').first().fill(name, { timeout: 8000 });
      await fr.locator('button:has-text("查询")').first().click({ timeout: 8000 });
      await sleep(3500);
      const row = fr.locator('.el-table__body-wrapper tr').filter({ hasText: name }).first();
      if (!(await row.count())) return 'row-miss';
      await row.locator('.el-checkbox').first().click({ timeout: 6000 });
      await sleep(800);
      await fr.locator('button:has-text("删除")').first().click({ timeout: 10000 });
      await sleep(2500);
      const okBtn = fr.locator('.el-overlay-message-box button.el-button--primary, .el-message-box button:has-text("确定")').first();
      if (await okBtn.count().catch(() => 0)) { await okBtn.click({ timeout: 6000, force: true, noWaitAfter: true }).catch(() => {}); }
      await sleep(4000);
      return (await queryByName(name)).total;
    };
    const aAfter = await del('PT07-D03C-R4');
    const bAfter = await del('PT07-D03D-R4');
    log('删后 C', aAfter, 'D', bAfter);
    if (aAfter === 1 && bAfter === 1) record('TC-DEL-03', 'PASS', '生效中+已失效已审删除拦截：C（生效中 2026-12 窗）/D（已失效 2026-04 窗）过审后 UI 删除→双双被拦（行保持 total=1）——已审态删除限制跨生效态一致（Q4 状态限制，R4 全新窗造数翻案）');
    else record('TC-DEL-03', 'FAIL', '删后 C=' + aAfter + ' D=' + bAfter + '（预期保持 1）');
  } else record('TC-DEL-03', 'BLOCKED', '造数 C=' + qa.total + ' D=' + qb.total + ' resp=' + ra.text.slice(0, 80));
  batch('run_end', {});
  await browser.close().catch(() => {});
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); batch('run_abort', { error: e.message.slice(0, 200) }); process.exit(1); });
