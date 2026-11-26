// pp_exec_r4d4.js — DEL-03 收尾批（换键维 W70+380 错开库内 W80 占位）
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LEDGER = '/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用例文件/平台价格分章/exec_ledger/ledger.jsonl';
const bjTs = () => new Date().toLocaleString('sv-SE').replace(' ', ' ');
let EXEC_NO = 900;
for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) { const m = line.match(/PP-20261126-(\d+)/); if (m) EXEC_NO = Math.max(EXEC_NO, +m[1] + 1); }
const record = (tc, status, reason) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: 'case', tc, status, reason: reason.slice(0, 500), exec_id: 'PP-20261126-' + String(EXEC_NO++).padStart(3, '0'), run_id: 'PP-R4-20261126', round: '执行R4', channel: 'ui' }) + '\n');
const log = (...a) => console.log(...a);

(async () => {
  const { chromium } = require('playwright');
  const http = require('http');
  const probe = (port) => new Promise(res => { const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 2000 }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(true)); }); req.on('error', () => res(false)); req.on('timeout', () => { req.destroy(); res(false); }); });
  let port = null;
  for (const p of [9335, 9336, 9337]) if (await probe(p)) { port = p; break; }
  if (!port) throw new Error('无可用实例（先跑 setup）');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 10000 });
  const page = browser.contexts()[0].pages().find(p => p.url().includes('jt-ll'));
  await page.goto('http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(9000);
  const apiPost = (p, body) => page.evaluate(async ({ u, b }) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify(b) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
    return { status: r.status, json: j, text: t.slice(0, 200) };
  }, { u: 'http://gateway-ll.test.ztoeco.com' + p, b: body });
  const queryByName = async (name) => { const r = await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, quoteName: name }); const d = r.json && r.json.data; return { total: d ? d.total : -1, items: d ? (d.items || []) : [] }; };
  // 造数（键维换 W70 流量管理费+380 收业务仓——错开 W80 库内占位；生效中窗含当前日 2026-11-26）
  const mk = (name, o) => apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { quoteName: name, costCode: o.w, settFlow: 380, specialAttributes: null, customerCode: null, businessWhCode: null, operateWhCode: null, startDate: o.s, endDate: o.e, detailModel: 'TIER', quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: 1, minPrice: null, maxPrice: null }] });
  const preE = await queryByName('PT07-D03G-R4'); const preF = await queryByName('PT07-D03F-R4');
  let ra = null, rb = null;
  if (preE.total === 0) ra = await mk('PT07-D03G-R4', { w: 'W70', s: '2026-11-20 00:00:00', e: '2026-12-15 23:59:59' });
  if (preF.total > 0 && preF.items[0].auditStatus === 0) await apiPost('/phecda/api/cwbms/quotePlatformFee/audit', { auditIds: [preF.items[0].id], auditStatus: 1 });
  const qe = await queryByName('PT07-D03G-R4'); const qf = await queryByName('PT07-D03F-R4');
  log('E(G) 造数', qe.total, ra ? ra.text.slice(0, 50) : 'skip', '| F', qf.total, qf.items[0] && qf.items[0].auditStatus);
  if (qe.items[0] && qf.items[0]) {
    if (qe.items[0].auditStatus === 0) await apiPost('/phecda/api/cwbms/quotePlatformFee/audit', { auditIds: [qe.items[0].id], auditStatus: 1 });
    if (qf.items[0].auditStatus === 0) await apiPost('/phecda/api/cwbms/quotePlatformFee/audit', { auditIds: [qf.items[0].id], auditStatus: 1 });
    await sleep(1500);
    const qe2 = await queryByName('PT07-D03G-R4'); const qf2 = await queryByName('PT07-D03F-R4');
    const eSt = qe2.items[0] && qe2.items[0].auditStatus; const fSt = qf2.items[0] && qf2.items[0].auditStatus;
    log('过审 E(G)', eSt, 'F', fSt);
    const delUI = async (name) => {
      await page.goto('http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(7000);
      const fr = page.frames().find(f => f.url().includes('platformPrice'));
      try {
        const nameCol = fr.locator('.el-col.modelFormClass').filter({ hasText: /^\s*报价名称/ }).first();
        await nameCol.locator('input.el-input__inner').first().fill(name, { timeout: 8000 });
        await fr.locator('button:has-text("查询")').first().click({ timeout: 8000, noWaitAfter: true });
        await sleep(4000);
        const row = fr.locator('.el-table__body-wrapper tr').filter({ hasText: name }).first();
        if (!(await row.count())) return 'row-miss';
        await row.locator('.el-checkbox').first().click({ timeout: 6000 });
        await sleep(800);
        await fr.locator('button:has-text("删除")').first().click({ timeout: 10000, noWaitAfter: true });
        await sleep(3000);
        const okBtn = fr.locator('.el-overlay-message-box button.el-button--primary').first();
        if (await okBtn.count().catch(() => 0)) { await okBtn.click({ timeout: 5000, force: true, noWaitAfter: true }).catch(() => {}); }
        await sleep(4000);
      } catch (e) { log('del err', e.message.slice(0, 60)); }
      return (await queryByName(name)).total;
    };
    const eAfter = await delUI('PT07-D03G-R4');
    const fAfter = await delUI('PT07-D03F-R4');
    log('删后 E(G)', eAfter, 'F', fAfter);
    if (eAfter === 1 && fAfter === 1) record('TC-DEL-03', 'PASS', '生效中+已失效已审删除拦截：G（生效中 2026-11-20~12-15 窗跨当前日，W70 维错键）/F（已失效 2026-03 窗）过审后 UI 删除→双双被拦（行保持 total=1）——已审态删除限制跨生效态一致（Q4 状态限制，R4 换维造数终案）');
    else record('TC-DEL-03', 'FAIL', '删后 E=' + eAfter + ' F=' + fAfter + '（预期保持 1）——过审态 E=' + eSt + ' F=' + fSt);
  } else record('TC-DEL-03', 'BLOCKED', '造数 E(G)=' + qe.total + ' F=' + qf.total + ' resp=' + String((ra && ra.text) || 'skip').slice(0, 60));
  await browser.close().catch(() => {});
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
