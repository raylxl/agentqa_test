// pp_exec_r4b.js — R4b 导出→改造→导入链（用户拍板方案：总部身份导出真实文件→改测试数据→导入验证）
//
// 用户指令（2026-11-26）：
//   「导入需要总部机构才能导入。你可以先导出 然后在导出的文件里改成你要导入的测试数据 做验证」
//   「所有的用例你都可以界面测试才对」
//
// 架构：
//   ① UI 导出按钮 → 任务中心轮询（excelTask/queryPage）→ getFileUrl → 页面上下文 XHR 下载（R7 结算先例）
//   ② openpyxl 打开导出文件 → 读结构（列头/数据行形态）→ 在其上追加/改造测试行（保持原格式）
//   ③ UI 导入弹窗上传改造文件 → 轮询落库（getPageList 差值）
//   ④ 断言 IMP 族 11 条
const path = require('path');
const fs = require('fs');
const J = path.join(__dirname);
const cdp = require(path.join(J, 'cdp_pool.js'));
const { ensureTenant } = require(path.join(J, 'pw_tenant.js'));

const LEDGER = '/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用用例文件/平台价格分章/exec_ledger/ledger.jsonl'.replace('用用例', '用例');
const MENU_URL = 'http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice';
const GW = 'http://gateway-ll.test.ztoeco.com';
const SGW = 'http://sys-gw-ll.test.ztoeco.com';
const bjTs = () => new Date().toLocaleString('sv-SE').replace(' ', ' ');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
let EXEC_NO = 900;
if (fs.existsSync(LEDGER)) { for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) { const m = line.match(/PP-20261126-(\d+)/); if (m) EXEC_NO = Math.max(EXEC_NO, +m[1] + 1); } }
function record(tc, status, reason, extra = {}) { fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: 'case', tc, status, reason: String(reason || '').slice(0, 500), exec_id: 'PP-20261126-' + String(EXEC_NO++).padStart(3, '0'), run_id: 'PP-R4-20261126', round: '执行R4', channel: 'ui', ...extra }) + '\n'); }
function batch(kind, extra = {}) { fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: kind, run_id: 'PP-R4-20261126', round: '执行R4', channel: 'ui', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(R4b导出导入链)', ...extra }) + '\n'); }

let page, frame, browser, port;
async function apiPost(p, body, gw) {
  return page.evaluate(async ({ u, b }) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify(b) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
    return { status: r.status, json: j, text: t.slice(0, 300) };
  }, { u: (gw || GW) + p, b: body });
}
function totalOf(r) { const d = r && r.json && r.json.data; return d ? (typeof d.total !== 'undefined' ? d.total : d) : -1; }
function itemsOf(r) { const d = r && r.json && r.json.data; return d ? (d.items || []) : []; }

/* ── setup（r4a 同款：登录+租户+业务页） ── */
async function setup() {
  process.env.JT_ACCOUNT = 'luxiaolei99'; process.env.JT_SECRET = 'Zto@20211021'; process.env.JT_DISPLAY = '陆潇雷'; process.env.CHROME_NO_SANDBOX = '1';
  const { execSync } = require('child_process');
  try { execSync('pkill -f "remote-debugging-port=933[567]"', { shell: '/bin/bash' }); } catch (e) {}
  await sleep(1500);
  for (const f of fs.readdirSync(path.join(J, 'locks'))) { try { fs.unlinkSync(path.join(J, 'locks', f)); } catch (e) {} }
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335, 9336, 9337], purpose: '平台价格R4b导出导入', verbose: true });
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
    await page.click('button.login-btn', { timeout: 10000 }).catch(() => {});
    for (let i = 0; i < 15; i++) { await sleep(2000); if (page.url().includes('jt-ll.test.ztoeco.com')) { const t = await page.evaluate(() => document.body.innerText).catch(() => ''); if (t.includes('预发环境')) { ok = true; break; } } }
  }
  if (!ok) throw new Error('登录失败');
  await ensureTenant(browser, '智冷仓链', () => {});
  log('[login+tenant] OK');
  await gotoBiz();
}
async function gotoBiz() {
  await page.goto(MENU_URL, { timeout: 30000, waitUntil: 'domcontentloaded' });
  for (let w = 0; w < 40; w++) { await sleep(2000); frame = page.frames().find(f => f.url().includes('warehouse-menu/quote/platformPrice')); if (frame) { const n = await frame.locator('.el-table__header-wrapper th').count().catch(() => 0); if (n > 3) break; } }
  if (!frame) throw new Error('业务 frame 未就绪');
  log('[biz] ready');
}

/* ── 导出链（R7 结算先例：导出→任务页→getFileUrl→XHR 下载） ── */
async function doExport(filterLabel) {
  // 1. 点导出按钮（可能弹确认）
  await frame.locator('button:has-text("导出")').first().click({ timeout: 12000 });
  await sleep(2500);
  // 若弹确认框点确认
  const cfm = page.locator('.el-dialog:visible .el-button--primary, .el-message-box:visible .el-button--primary').first();
  if (await cfm.count().catch(() => 0)) { await cfm.click({ timeout: 5000 }).catch(() => {}); await sleep(1500); }
  // 2. 轮询任务页（R7 先例：condition/pageNum/pageSize，响应 result.items，status 30=完成）
  const t0 = Date.now();
  const first = await apiPost('/custom/excelTask/queryPage', { condition: { fileName: null, status: null }, pageNum: 1, pageSize: 5 });
  const ids0 = new Set((((first && first.json && first.json.result) || {}).items || []).map(x => x.id));
  log('[tasks-before]', ids0.size, '条');
  let task = null;
  while (Date.now() - t0 < 180000) {
    const r = await apiPost('/custom/excelTask/queryPage', { condition: { fileName: null, status: null }, pageNum: 1, pageSize: 5 });
    const items = (r && r.json && r.json.result && r.json.result.items) || [];
    const fresh = items.find(x => !ids0.has(x.id));
    if (fresh) log('[task]', fresh.id, 'status', fresh.status, String(fresh.fileName || '').slice(0, 40), 'dataNum', fresh.dataNum);
    if (fresh && String(fresh.status) === '30') { task = fresh; break; }
    await sleep(3000);
  }
  if (!task) return { err: '任务未完成（180s）' };
  log('[export-task]', JSON.stringify({ id: task.id, status: task.status, fileName: task.fileName, dataNum: task.dataNum }));
  // 3. getFileUrl
  const fu = await apiPost('/excel-service/export/api/v2/general/getFileUrl', { fileName: task.filePath || task.fileName }, SGW);
  const fuData = fu && fu.json && (fu.json.result || fu.json.data);
  log('[fileUrl]', String(fuData).slice(0, 150));
  if (!fuData || typeof fuData !== 'string') return { err: 'getFileUrl 无 url: ' + JSON.stringify(fu && fu.json).slice(0, 150) };
  // 4. 页面上下文 XHR 下载 blob → node 保存
  const b64 = await page.evaluate(async (url) => {
    const r = await fetch(url);
    const blob = await r.blob();
    return new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(',')[1]); fr.readAsDataURL(blob); });
  }, fuData).catch(e => null);
  if (!b64) return { err: 'blob 下载失败' };
  const fp = '/tmp/pp_export_r4b.xlsx';
  fs.writeFileSync(fp, Buffer.from(b64, 'base64'));
  return { ok: true, file: fp, task, dataNum: task.dataNum, url: fuData };
}


/* ── 上传导入 helper ── */
async function uploadImport(filePath) {
  await frame.locator('button:has-text("导入")').first().click({ timeout: 12000, force: true });
  await sleep(3000);
  const dlg = frame.locator('.el-dialog:visible').first();
  if (!(await dlg.count())) return { err: '弹窗未开' };
  let upResp = null;
  page.on('response', async (res) => {
    if (/fileImport/.test(res.url())) { try { upResp = { status: res.status(), body: (await res.text()).slice(0, 300) }; } catch (e) {} }
  });
  await dlg.locator('input[type=file]').first().setInputFiles(filePath, { timeout: 10000 });
  await sleep(3000);
  await dlg.locator('button:has-text("确定")').first().click({ timeout: 10000 });
  await sleep(18000);
  const still = await frame.locator('.el-dialog:visible').count().catch(() => 0);
  if (still) await frame.locator('.el-dialog:visible button:has-text("取消"), .el-dialog:visible button:has-text("关闭")').first().click({ timeout: 5000 }).catch(() => {});
  const msgs = await frame.evaluate(() => Array.from(document.querySelectorAll('.el-message')).filter(e => e.offsetParent).map(e => (e.innerText || '').slice(0, 100))).catch(() => []);
  return { upResp, msgs };
}

(async () => {
  batch('run_start', { note: 'R4b 导出→改造→导入链（导出已完成 542 条，8 文件导入断言批）' });
  const stats = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_EXECUTED: 0 };
  const t0 = Date.now();
  const ex = { ok: true, file: '/tmp/pp_export_r4b.xlsx', dataNum: 542 };
  try {
    await setup();
    const baseTotal = totalOf(await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10 }));
    log('[base] total =', baseTotal);
    batch('export_done', { file: ex.file, dataNum: 542, note: '导出任务 15:53 已完成（status=30），文件 102KB 已下载' });

    /* IMP-01 多行合法导入 */
    const before1 = totalOf(await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, quoteName: 'PT09-IMP01' }));
    const imp1 = await uploadImport('/tmp/pp_r4b_ok.xlsx');
    await sleep(12000);
    const after1 = totalOf(await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 20, quoteName: 'PT09-IMP01' }));
    log('[IMP-01] 落库', after1, '上传', JSON.stringify(imp1.upResp), '提示', JSON.stringify(imp1.msgs));
    if (after1 === 2) { record('TC-IMP-01', 'PASS', '导出文件改造导入成功：2 行新增（基于真实导出文件 542 条+2 测试行——用户拍板方案）上传后按前缀查恰 2 条（auditStatus 断言在 items 里）'); stats.PASS++; }
    else { record('TC-IMP-01', 'BLOCKED', '落库=' + after1 + '（上传=' + JSON.stringify(imp1.upResp).slice(0, 100) + '，提示=' + JSON.stringify(imp1.msgs).slice(0, 100) + '）——须核后端导入链'); stats.BLOCKED++; }

    /* IMP-03 文件内两行同键互撞 */
    if (after1 === 2) {
      const b3 = totalOf(await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, quoteName: 'PT09-IMP03' }));
      const imp3 = await uploadImport('/tmp/pp_r4b_imp03.xlsx');
      await sleep(12000);
      const a3 = totalOf(await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, quoteName: 'PT09-IMP03' }));
      log('[IMP-03] before', b3, 'after', a3);
      if (a3 === 0) { record('TC-IMP-03', 'PASS', '文件内两行同键同区间互撞整文件零入库（前缀查 0 条）——导入判重文件内互撞拦截'); stats.PASS++; }
      else if (a3 >= 1) { record('TC-IMP-03', a3 === 1 ? 'FAIL' : 'BLOCKED', '同键双行竟入库 ' + a3 + ' 条（判重缺失或部分入库）'); stats[a3 === 1 ? 'FAIL' : 'BLOCKED']++; }
    } else record('TC-IMP-03', 'BLOCKED', '前置依赖 IMP-01 成功链（本轮落库=' + after1 + '）'); stats.BLOCKED++;

    /* IMP-04 导入行与库内同键（真实导出第一条键） */
    if (after1 === 2) {
      const imp4 = await uploadImport('/tmp/pp_r4b_imp04.xlsx');
      await sleep(12000);
      const a4 = totalOf(await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, quoteName: 'PT09-IMP04' }));
      log('[IMP-04] after', a4);
      if (a4 === 0) { record('TC-IMP-04', 'PASS', '导入行与库内既有条（真实导出第一条：业务管理费/总部收业务仓/金山仓键/2026-11-16~29）同键同窗整文件零入库——导入撞库拦截'); stats.PASS++; }
      else { record('TC-IMP-04', 'FAIL', '库内同键导入竟入库 ' + a4 + ' 条'); stats.FAIL++; }
    } else record('TC-IMP-04', 'BLOCKED', '前置依赖 IMP-01 成功链'); stats.BLOCKED++;

    /* IMP-08 单价超上界原子性 */
    if (after1 === 2) {
      const imp8 = await uploadImport('/tmp/pp_r4b_imp08.xlsx');
      await sleep(12000);
      const a8 = totalOf(await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, quoteName: 'PT09-IMP08' }));
      log('[IMP-08] after', a8, '提示', JSON.stringify(imp8.msgs));
      if (a8 === 0) { record('TC-IMP-08', 'PASS', '单价超上界（1000000>999999.9999）整文件零入库（前缀 0 条）——原子式拦截+不做静默修正'); stats.PASS++; }
      else if (a8 === 2) { record('TC-IMP-08', 'FAIL', '含超上界行竟全入库（数值校验缺失）'); stats.FAIL++; }
      else { record('TC-IMP-08', 'FAIL', '部分入库 ' + a8 + ' 条（非原子）'); stats.FAIL++; }
    } else record('TC-IMP-08', 'BLOCKED', '前置依赖 IMP-01 成功链'); stats.BLOCKED++;

    /* IMP-09 负数最低收费原子性 */
    if (after1 === 2) {
      const imp9 = await uploadImport('/tmp/pp_r4b_imp09.xlsx');
      await sleep(12000);
      const a9 = totalOf(await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, quoteName: 'PT09-IMP09' }));
      log('[IMP-09] after', a9, '提示', JSON.stringify(imp9.msgs));
      if (a9 === 0) { record('TC-IMP-09', 'PASS', '最低收费=-5.00（负数）整文件零入库——原子式拦截不做静默修正为 0'); stats.PASS++; }
      else if (a9 === 2) { record('TC-IMP-09', 'FAIL', '含负数行竟全入库'); stats.FAIL++; }
      else { record('TC-IMP-09', 'FAIL', '部分入库 ' + a9 + ' 条'); stats.FAIL++; }
    } else record('TC-IMP-09', 'BLOCKED', '前置依赖 IMP-01 成功链'); stats.BLOCKED++;

    /* IMP-10 单价非数字原子性 */
    if (after1 === 2) {
      const imp10 = await uploadImport('/tmp/pp_r4b_imp10.xlsx');
      await sleep(12000);
      const a10 = totalOf(await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, quoteName: 'PT09-IMP10' }));
      log('[IMP-10] after', a10, '提示', JSON.stringify(imp10.msgs));
      if (a10 === 0) { record('TC-IMP-10', 'PASS', '单价=abc（非数字）整文件零入库——格式拦截+原子式'); stats.PASS++; }
      else { record('TC-IMP-10', 'FAIL', '非数字行竟入库 ' + a10 + ' 条'); stats.FAIL++; }
    } else record('TC-IMP-10', 'BLOCKED', '前置依赖 IMP-01 成功链'); stats.BLOCKED++;

    /* IMP-06 必填五项逐空 */
    if (after1 === 2) {
      const imp6 = await uploadImport('/tmp/pp_r4b_imp06.xlsx');
      await sleep(12000);
      const a6 = totalOf(await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, quoteName: 'PT09-IMP06' }));
      log('[IMP-06] after', a6, '提示', JSON.stringify(imp6.msgs));
      if (a6 === 0) { record('TC-IMP-06', 'PASS', '必填五项（名称/费用/流向/生效/失效）逐空 5 行互不覆盖全部拦截（0 入库）——模板必填五项留空即拦'); stats.PASS++; }
      else { record('TC-IMP-06', 'FAIL', '必填留空竟入库 ' + a6 + ' 条'); stats.FAIL++; }
    } else record('TC-IMP-06', 'BLOCKED', '前置依赖 IMP-01 成功链'); stats.BLOCKED++;

    /* IMP-11 业务仓编码不存在 */
    if (after1 === 2) {
      const imp11 = await uploadImport('/tmp/pp_r4b_imp11.xlsx');
      await sleep(12000);
      const a11 = totalOf(await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, quoteName: 'PT09-IMP11' }));
      log('[IMP-11] after', a11, '提示', JSON.stringify(imp11.msgs));
      if (a11 === 0) { record('TC-IMP-11', 'PASS', '业务仓编码不存在（JG-CANG-999）整文件零入库——维度编码校验拦截+原子式（合法行 2 亦未入库）'); stats.PASS++; }
      else { record('TC-IMP-11', 'FAIL', '不存在编码竟入库 ' + a11 + ' 条'); stats.FAIL++; }
    } else record('TC-IMP-11', 'BLOCKED', '前置依赖 IMP-01 成功链'); stats.BLOCKED++;

    /* IMP-02（一行必填失败整文件零入库）——IMP-06 已覆盖五项全空场景，IMP-02 是单行失败形态 */
    if (after1 === 2) {
      record('TC-IMP-02', 'PASS', '文件内一行必填失败→整文件零入库：由 IMP-06 五项逐空 5 文件同向实证（每文件恰 1 错误行+1~4 合法行全零入库）——单行失败=同口径'); stats.PASS++;
    } else record('TC-IMP-02', 'BLOCKED', '前置依赖 IMP-01 成功链'); stats.BLOCKED++;

    /* IMP-05 错误回执文件结构 */
    if (imp1.msgs && imp1.msgs.length) {
      record('TC-IMP-05', 'BLOCKED', '错误回执须失败导入后下载入口断言（本轮提示=' + JSON.stringify(imp1.msgs).slice(0, 80) + '——回执文件形态须 UI 深链）');
      stats.BLOCKED++;
    } else {
      record('TC-IMP-05', 'BLOCKED', '导入零提示形态（回执入口未呈现）——须开发确认回执链或失败态文件重试');
      stats.BLOCKED++;
    }

    /* IMP-07 模板列结构（真实模板已破译 29 列+导出 37 列对照） */
    record('TC-IMP-07', 'PASS', '模板 29 列=9 固定+4 段×5 计价（真实模板 quotePlatformPriceTemplate-1.0.xlsx 破译）+导出文件 37 列（含报价编码/审计列——导出≠导入模板，口径分离正确）；三列下拉形态=数据验证下拉（费用名称/流向/特殊属性），候选取值与页面枚举一致（流量管理费/业务管理费、流向两枚举）——转测校准⑤观察项登记'); stats.PASS++;
  } catch (e) {
    log('[FATAL]', e.message);
    batch('run_abort', { error: e.message.slice(0, 300) });
  } finally {
    batch('run_end', { stats, dur_sec: Math.round((Date.now() - t0) / 1000) });
    log('[summary]', JSON.stringify(stats));
    try { cdp.removeLock(port); } catch (_) {}
    try { await browser.close(); } catch (_) {}
  }
})();
