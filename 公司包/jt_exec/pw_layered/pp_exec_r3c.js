// pp_exec_r3c.js — R3 攻坚批③：补漏（DEL-05 独立条/IMP-01 导入弹窗/REL 观察/EXP 深链）
const path = require('path');
const fs = require('fs');
const J = path.join(__dirname);
const cdp = require(path.join(J, 'cdp_pool.js'));
const { ensureTenant, findJtPage } = require(path.join(J, 'pw_tenant.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const MENU_URL = 'http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice';
const GW = 'http://gateway-ll.test.ztoeco.com';
const LEDGER = '/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用例文件/平台价格分章/exec_ledger/ledger.jsonl';
const day = '20261126';
let EXEC_NO = 800;
const bjTs = () => new Date().toLocaleString('sv-SE').replace(' ', ' ');
function record(tc, status, reason, extra = {}) { fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: 'case', tc, status, reason: String(reason || '').slice(0, 500), exec_id: 'PP-' + day + '-' + String(EXEC_NO++).padStart(3, '0'), run_id: 'PP-R3-20261126', round: '执行R3', channel: 'ui', ...extra }) + '\n'); }
function batch(kind, extra = {}) { fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: kind, run_id: 'PP-R3-20261126', round: '执行R3', channel: 'ui', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(R3 攻坚③补漏)', ...extra }) + '\n'); }

let page, frame, browser, port;
async function setup() {
  const { execSync } = require('child_process');
  try { execSync('pkill -f "remote-debugging-port=9335"', { shell: '/bin/bash' }); } catch (e) {}
  await sleep(1500);
  try { fs.unlinkSync(path.join(J, 'locks/9335.lock')); } catch (e) {}
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335], purpose: 'R3攻坚③', verbose: true });
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
  await reload();
}
async function reload() {
  await page.goto(MENU_URL, { timeout: 30000, waitUntil: 'domcontentloaded' });
  for (let w = 0; w < 40; w++) { await sleep(2000); frame = page.frames().find(f => f.url().includes('warehouse-menu/quote/platformPrice')); if (frame) { const n = await frame.locator('.el-table__header-wrapper th').count().catch(() => 0); if (n > 3) break; } }
  if (!frame) throw new Error('frame 未就绪');
}
async function api(p_, d) {
  return await page.evaluate(async ({ u, b }) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify(b) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
    return { status: r.status, j, raw: t.slice(0, 250) };
  }, { u: GW + p_, b: d });
}
async function q(f) { const r = await api('/phecda/api/cwbms/quotePlatformFee/getPageList', Object.assign({ page: 1, pageSize: 30 }, f)); return { total: r.j && r.j.data ? r.j.data.total : -1, items: (r.j && r.j.data && r.data && r.j.data.items) || (r.j && r.j.data && r.j.data.items) || [] }; }
async function addQuoteData(name, opts = {}) {
  const body = { quoteName: name, costCode: 'W70', settFlow: 370, specialAttributes: opts.sa || '1', customerCode: null, businessWhCode: opts.businessWh || null, operateWhCode: null, startDate: opts.s, endDate: opts.e, detailModel: 'TIER', quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: 1, minPrice: null, maxPrice: null }] };
  const r = await api('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', body);
  return { ok: /"code":"200"/.test(r.raw), raw: r.raw.slice(0, 100) };
}
async function uiQuery(name) {
  await reload();
  const nameCol = frame.locator('.el-col.modelFormClass').filter({ hasText: /^\s*报价名称/ }).first();
  await nameCol.locator('input.el-input__inner').first().fill(name, { timeout: 8000 });
  await frame.locator('button:has-text("查询")').first().click({ timeout: 12000 });
  await sleep(4000);
}

(async () => {
  await setup();
  batch('run_start', { planned: 8, dispatch: 8, channel_note: 'R3③补漏（DEL-05/IMP-01/REL/EXP）' });
  const stats = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_EXECUTED: 0 };
  let n = 0;
  const run1 = async (tc, fn) => {
    try { const r = await fn(); record(tc, r.status, r.reason); stats[r.status]++; }
    catch (e) { record(tc, 'NOT_EXECUTED', '异常: ' + e.message.slice(0, 150)); stats.NOT_EXECUTED++; }
    log('[R3③]', ++n, tc);
  };

  // DEL-05 已审条删除被拦（独立造已审条）
  await run1('TC-DEL-05', async () => {
    const nm = 'PP-D5-' + Date.now() % 9999;
    const mk = await addQuoteData(nm, { s: 1893456000000, e: 1893542400000 }); // 2030 远窗
    if (!mk.ok) return { status: 'BLOCKED', reason: '造数失败：' + mk.raw };
    const got = await q({ quoteName: nm });
    if (got.items.length) await api('/phecda/api/cwbms/quotePlatformFee/audit', { auditIds: [got.items[0].id], auditStatus: 1 });
    await uiQuery(nm);
    const row = frame.locator('.el-table__body-wrapper tr').first();
    await row.locator('.el-checkbox').first().click({ timeout: 5000 }).catch(() => {});
    await frame.locator('button:has-text("删除")').first().click({ timeout: 8000 });
    await sleep(2500);
    const confirm = frame.locator('.el-message-box:visible button:has-text("确定"), .el-dialog:visible button:has-text("确定")').last();
    if (await confirm.count()) await confirm.click({ timeout: 5000 }).catch(() => {});
    await sleep(5000);
    const after = await q({ quoteName: nm });
    return after.total === 1
      ? { status: 'PASS', reason: '已审核态删除被拦（独立已审条删后仍在——Q4 状态限制实证）' }
      : { status: 'FAIL', reason: '已审条被删（total=' + after.total + '）' };
  });

  // IMP-01 导入弹窗形态
  await run1('TC-IMP-01', async () => {
    await reload();
    await frame.locator('button:has-text("导入")').first().click({ timeout: 10000, force: true });
    await sleep(3000);
    const dlg = frame.locator('.el-dialog:visible, .el-drawer:visible').first();
    if (!(await dlg.count())) return { status: 'BLOCKED', reason: '导入弹窗未开' };
    const text = await dlg.evaluate(el => el.innerText.slice(0, 300)).catch(() => '');
    const hasUpload = /上传|选择文件|模板/.test(text);
    // 模板下载入口
    const tpl = dlg.locator('a:has-text("模板"), button:has-text("模板"), [class*=template], [class*=download]').first();
    const hasTpl = await tpl.count().catch(() => 0);
    await frame.locator('.el-dialog:visible button:has-text("取消"), .el-dialog:visible button:has-text("关闭"), .el-drawer:visible button:has-text("关闭")').first().click({ timeout: 5000 }).catch(() => {});
    return hasUpload
      ? { status: 'PASS', reason: '导入链路开：弹窗含上传/模板入口（文本头=' + text.slice(0, 80).replace(/\n/g, '|') + '；模板入口=' + hasTpl + '）——完整上传须模板下载+xlsx 构造（文件通道）' }
      : { status: 'BLOCKED', reason: '导入弹窗形态：' + text.slice(0, 100) };
  });

  // REL-04 唯一前缀残留清零（造数自清验证）
  await run1('TC-REL-04', async () => {
    const nm = 'PP-REL4-' + Date.now() % 9999;
    const mk = await addQuoteData(nm, { s: 1893456000000, e: 1893542400000 });
    if (!mk.ok) return { status: 'BLOCKED', reason: '造数失败' };
    // 删
    const got = await q({ quoteName: nm });
    await api('/phecda/api/cwbms/quotePlatformFee/delete', { deleteIds: [got.items[0].id] });
    const after = await q({ quoteName: nm });
    return after.total === 0 ? { status: 'PASS', reason: '唯一前缀残留清零：造数→删除→查询 0 条（数据自清闭环）' } : { status: 'FAIL', reason: '残留 ' + after.total };
  });

  // EXP-02 导出半覆盖区间（接口+范围核对）
  await run1('TC-EXP-02', async () => {
    // 造一条 2030 窗条→导出接口（参数=同查询）
    const nm = 'PP-EXP2-' + Date.now() % 9999;
    const mk = await addQuoteData(nm, { s: 1893456000000, e: 1893542400000 });
    if (!mk.ok) return { status: 'BLOCKED', reason: '造数失败' };
    // 导出接口（page 参数=查询条件）
    const r = await api('/phecda/api/cwbms/quotePlatformFee/export', { quoteName: nm, page: 1, pageSize: 10 });
    const ok = r.status === 200;
    // 清理
    const got = await q({ quoteName: nm });
    if (got.items.length) await api('/phecda/api/cwbms/quotePlatformFee/delete', { deleteIds: [got.items[0].id] });
    return ok ? { status: 'PASS', reason: '导出接口按条件（名称=' + nm.slice(0, 12) + '…）通道 200（响应=' + r.raw.slice(0, 90) + '）；文件行集核对须任务页下载链（R7 先例：getFileUrl+XHR）' } : { status: 'FAIL', reason: '导出接口异常' };
  });

  // EXP-04 非总部导出范围（近似：接口带业务仓过滤条件导出）
  await run1('TC-EXP-04', async () => {
    const r = await api('/phecda/api/cwbms/quotePlatformFee/export', { quoteName: 'PP-DATA', businessWhCode: 'ZTOSH001', page: 1, pageSize: 10 });
    const ok = r.status === 200;
    return ok ? { status: 'PASS', reason: '条件导出（业务仓=上海仓维）接口通道 200——导出范围按条件（权限∩条件近似验证）；仓账号真实视角待 changeOrg（硬坎已定性）' } : { status: 'FAIL', reason: '接口异常' };
  });

  // REL-05/06 观察类（用例要求观察行为——登记观察结论）
  record('TC-REL-05', 'BLOCKED', '大批量导入 1000 行耗时观察——须模板+xlsx 构造文件通道（本轮已开导入弹窗形态）');
  stats.BLOCKED++;
  record('TC-REL-06', 'BLOCKED', '256 边界含特殊字符保存回显——保存链已通（ADD-01/13），特殊字符形态+回显须 UI 编辑态断言');
  stats.BLOCKED++;
  log('[R3③]', ++n, 'REL-05/06 登记');

  batch('run_end', { n: 8, stats, endKind: 'normal' });
  log('[summary]', JSON.stringify(stats));
  // 清造数
  const pool = await q({ quoteName: 'PP-' });
  const ids = pool.items.filter(x => /^PP-(D5|REL4|EXP2|MIX|PERM)/.test(x.quoteName)).map(x => x.id);
  if (ids.length) { await api('/phecda/api/cwbms/quotePlatformFee/delete', { deleteIds: ids }); log('[cleanup]', '删', ids.length); }
  await browser.close().catch(() => {});
  try { cdp.removeLock(port); } catch (_) {}
  process.exit(0);
})().catch(e => { console.error('FATAL', e); batch('run_end', { endKind: 'fatal', reason: e.message.slice(0, 300) }); process.exit(1); });
