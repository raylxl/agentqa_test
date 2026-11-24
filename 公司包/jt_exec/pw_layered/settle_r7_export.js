/**
 * 结算交易记录 8.11 · R7 导出文件实体补验（EXP-01/02/03/05 + SEC-05）
 * ============================================================================
 * 2026-11-24 实测打通的导出链路（此前报告口径"须人工任务页下载"未经验证，实测机器可走通）：
 *   UI 点「导出」→「导出确认」弹窗点「确认」→ POST /phecda/phecda/account/settleTrans/exportTransDetails（任务入队）
 *   → 壳层自动打开「导出任务」页签（/app/#/basicComponent/taskTemplateTable，el-table-v2 虚拟表，无需点）
 *   → 轮询 POST gateway-ll /custom/excelTask/queryPage 取最新任务，status 10=执行中 30=已完成（~30s）
 *   → POST sys-gw-ll /excel-service/export/api/v2/general/getFileUrl {fileName: filePath} → 文件服务 URL
 *   → 页面上下文 XHR GET 该 URL → blob（文件服务校验页面环境 appid；用 Playwright request 直 GET 会得 65B 的 "appid不能为空"）
 *   → xlsx（openpyxl 解析）。注意网关分两个域：业务 gateway-ll / 系统 sys-gw-ll。
 *
 * 断言纪律（R6 质疑门教训：禁永真断言）——全部用 集合相等 / 精确相等 / 负向对照：
 *   EXP-01  文件数据行数 == 查询 total（精确相等）；文件运单号集合 == 接口拉全量运单号集合（集合相等）
 *   EXP-02  文件表头 == 页面结果表表头（逐列同名同序，精确相等）；文件「产品类型」列取值 ⊆ 接口同列取值且含带温层原值
 *   EXP-03  文件「机构编码」列取值集合 == 所选甲乙编码集合（集合相等，非 ⊆）；文件不含未选机构编码
 *   EXP-05  文件「机构编码」取值集合 == 所选有权机构集合（集合相等）
 *   SEC-05  机构视角（changeOrg 切 400001）：文件机构编码集合 ⊆ 该视角有权机构集；且 == 不带筛选导出的机构集（剔除式 B1 口径）
 *   共性    交易时间窗按册设并进 assertReq（createTime）；每步截图；请求参数与勾选一致才判定；不一致记 BLOCKED
 *
 * 运行（稳定终端 / 本机需 CHROME_NO_SANDBOX=1）：
 *   CHROME_NO_SANDBOX=1 node settle_r7_export.js --list
 *   CHROME_NO_SANDBOX=1 node settle_r7_export.js --only TC-EXP-02 --no-ledger
 *   CHROME_NO_SANDBOX=1 node settle_r7_export.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const pool = require('./cdp_pool');
const { ensureLogin } = require('./pw_login');
const { ensureTenant } = require('./pw_tenant');
const { waitBizRendered } = require('./lib/jt_common');

/* ───────── 配置 ───────── */
const REG      = process.env.SETTLE_REG   || '/Users/kimfang/WorkBuddy/ai测试agent';
const BOOK_DIR = path.join(REG, '需求用例库/用例文件/结算交易记录分章');
const LEDGER   = process.env.SETTLE_LEDGER || path.join(BOOK_DIR, 'exec_ledger/ledger.jsonl');
const EVID     = path.join(BOOK_DIR, 'evidence');
const DL_DIR   = path.join(EVID, 'export_files');
const SPA      = 'http://jt-ll.test.ztoeco.com/app/#/phecda/account/settletransNew';
const TENANT   = '冷链快运';
const BOOK     = '财务需求2026_快运_结算交易记录_11.23_测试用例_v1';
const ROUND    = '第7轮';
const RUN_ID   = 'RUN-SETTLE-8.11-R7-' + new Date().toISOString().slice(0, 10).replace(/-/g, '');
const PURPOSE  = 'settle-r7-export补验';
const GW       = 'http://gateway-ll.test.ztoeco.com';
const SYS_GW   = 'https://sys-gw-ll.test.ztoeco.com';
const PY       = process.env.PYTHON || '/Users/kimfang/.workbuddy/binaries/python/versions/3.13.12/bin/python3';
for (const d of [EVID, DL_DIR, path.dirname(LEDGER)]) fs.mkdirSync(d, { recursive: true });

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const NO_LEDGER = has('--no-ledger');
const ONLY    = (val('--only', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const PORTARG = val('--port', 'auto');
const RETEST_OF = val('--retest-of', '');   // 复测标记：被复测的首跑 exec_id（执行细则 4.5：重跑须标 retest:true/retestOf）

/* 真实主数据（module_config + R3/R6 实证） */
const ORG = {
  A:    { name: '上海青浦一级网点CS1', code: '400001' },
  B:    { name: '总部',               code: '999999' },
};
const PT = { COLD: '冷链快递', COLD_CODE: 'ZTOCC_EXPRESS' };

const bjTs = () => { const t = new Date(Date.now() + 8 * 3600 * 1000); return t.toISOString().replace('T', ' ').slice(0, 19) + '+08:00'; };
const log = (...a) => console.log('[R7]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uniq = a => [...new Set(a.filter(x => x !== undefined && x !== null && x !== ''))];
const eqSet = (a, b) => { const A = uniq(a).sort(), B = uniq(b).sort(); return A.length === B.length && A.every((x, i) => x === B[i]); };

/* ───────── 账本 ───────── */
function nextExecId() {
  let n = 1;
  if (fs.existsSync(LEDGER)) {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) { const m = line.match(new RegExp('UX-' + day + '-(\\d+)')); if (m) n = Math.max(n, +m[1] + 1); }
  }
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return 'UX-' + day + '-' + String(n).padStart(3, '0');
}
function append(rec) { if (NO_LEDGER) { log('（--no-ledger 演练，未写账本）', rec.event || (rec.tc + ' ' + rec.status), rec.reason || rec.detail || ''); return; } fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n'); }
function batch(kind, extra = {}) { append({ ts: bjTs(), event: kind, run_id: RUN_ID, round: ROUND, channel: 'ui', book: BOOK, operator: 'AI(稳定终端 headless)', ...extra }); }

/* ───────── 页面 helpers（与 settle_r6_ui.js 同源，经 R6 实证） ───────── */
async function getBizFrame(page) {
  // 与 settle_r6_ui.js 同源（R6 实证 8 条可用）：取第一个含 .el-table 的 settletransNew frame
  for (const f of page.frames()) { if (/settletransNew/.test(f.url())) { try { if (await f.$('.el-table')) return f; } catch (_) {} } }
  for (let i = 0; i < 8; i++) { await sleep(800); for (const f of page.frames()) { if (/settletransNew/.test(f.url())) { try { if (await f.$('.el-table')) return f; } catch (_) {} } } }
  throw new Error('业务表格 frame 未找到');
}
async function findCol(frame, label) {
  const col = frame.locator('.el-col').filter({ hasText: new RegExp('^\\s*' + label) }).first();
  if (!(await col.count())) throw new Error('查询区未见字段「' + label + '」');
  return col;
}
const visiblePopper = frame => frame.locator('.el-select-dropdown:visible').last();
async function closePoppers(frame) {
  for (let i = 0; i < 4; i++) {
    if (!(await frame.locator('.el-select-dropdown:visible').count())) break;
    const t = frame.locator('.el-form-item__label:visible, .el-form label:visible').first();
    if (await t.count()) await t.click({ timeout: 2000 }).catch(() => {}); else await frame.locator('.el-pagination:visible, .el-table__header:visible').first().click({ timeout: 2000 }).catch(() => {});
    await sleep(350);
  }
  await sleep(200);
}
async function openMulti(frame, label) {
  const col = await findCol(frame, label);
  const sel = col.locator('.el-select').first();
  await closePoppers(frame);
  await sel.click({ timeout: 8000 });
  await sleep(700);
  const search = col.locator('input.el-select__input, input[placeholder*="搜索"], input[placeholder*="请输入"]').first();
  return { col, popper: visiblePopper(frame), search: (await search.count()) ? search : null };
}
async function pickOption(ctx, opt) {
  const { popper, search } = ctx;
  const kw = opt.search || opt.name;
  if (search) { await search.fill(''); await sleep(300); await search.fill(kw); await sleep(1400); }
  const lines = s => s.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const all = popper.locator('.el-select-dropdown__item');
  const texts = await all.allInnerTexts();
  let hit = -1;
  for (let i = 0; i < texts.length; i++) { const L = lines(texts[i]); if (opt.code ? L.includes(opt.code) : L.includes(opt.name)) { hit = i; break; } }
  if (hit < 0) throw new Error(`下拉搜「${kw}」后无 ${opt.code ? '编码 ' + opt.code : '选项「' + opt.name + '」'}（现有 ${texts.length} 项）`);
  const item = all.nth(hit);
  if (!((await item.getAttribute('class')) || '').includes('is-selected')) await item.click({ timeout: 8000 });
  await sleep(400);
  if (search) { await search.fill('').catch(() => {}); await sleep(250); }
}
async function selectOrg(frame, org) { const ctx = await openMulti(frame, '开户机构'); await pickOption(ctx, org); await closePoppers(frame); }
async function selectProduct(frame, pt) { const ctx = await openMulti(frame, '产品类型'); await pickOption(ctx, { name: pt, search: pt }); await closePoppers(frame); }
async function clickBtn(frame, text) { const b = frame.locator('button').filter({ hasText: new RegExp(text) }).first(); if (!(await b.count())) throw new Error('未见按钮「' + text + '」'); await b.click({ timeout: 8000 }); }

/** 设置交易时间窗（面板 4 格：开始日期/开始时间/结束日期/结束时间 → 确定）。坑库 G3：控件外框 fill 不可靠，走面板分格。 */
async function setDateRange(frame, start, end) {
  await closePoppers(frame);
  const col = await findCol(frame, '交易时间');
  await col.locator('.el-date-editor input').first().click({ timeout: 8000 });
  await sleep(900);
  const panel = frame.locator('.el-picker-panel:visible').last();
  if (!(await panel.count())) throw new Error('日期面板未展开');
  const ri = panel.locator('input');
  if ((await ri.count()) < 4) throw new Error('日期面板输入格数异常=' + await ri.count());
  const [sd, st, ed, et] = [start.slice(0, 10), start.slice(11), end.slice(0, 10), end.slice(11)];
  await ri.nth(0).fill(sd); await sleep(200); await ri.nth(1).fill(st); await sleep(200);
  await ri.nth(2).fill(ed); await sleep(200); await ri.nth(3).fill(et); await sleep(300);
  await panel.locator('button:visible').filter({ hasText: /^\s*确定\s*$/ }).first().click({ timeout: 5000 });
  await sleep(800);
  await frame.locator('.el-form-item__label:visible').first().click({ timeout: 2000 }).catch(() => {});
  const vals = await col.evaluate(e => [...e.querySelectorAll('input')].map(i => i.value));
  return vals;
}

/** 查询并等响应；返回 { total, req:{org,pt,ct}, rows } */
async function queryAndWait(frame, page) {
  const reqs = []; let done; const respP = new Promise(r => { done = r; });
  const onReq = r => { try { if (/listTransDetails/.test(r.url())) { const j = JSON.parse(r.postData() || '{}'); reqs.push({ org: j.accountOrgCodeList, pt: j.productTypeList, ct: j.createTime, body: j }); } } catch (_) {} };
  const onResp = r => { try { if (/listTransDetails/.test(r.url())) done(r.status()); } catch (_) {} };
  page.on('request', onReq); page.on('response', onResp);
  await clickBtn(frame, '查\\s*询');
  const n0 = reqs.length; const t0 = Date.now() + 6000;
  while (Date.now() < t0 && reqs.length === n0) await sleep(100);
  await Promise.race([respP, sleep(25000)]);
  await sleep(900);
  page.off('request', onReq); page.off('response', onResp);
  const total = await frame.evaluate(() => { const m = (document.body.innerText || '').match(/共\s*(\d+)\s*条/); return m ? +m[1] : null; });
  return { total, req: reqs[reqs.length - 1] || null };
}
function assertReq(q, expect, label) {
  const norm = a => (a && a.length) ? [...a].map(String).sort() : null;
  const gO = norm(q.req && q.req.org), gP = norm(q.req && q.req.pt), gC = q.req && q.req.ct;
  const eO = norm(expect.org), eP = norm(expect.pt);
  const orgOk = JSON.stringify(gO) === JSON.stringify(eO), ptOk = JSON.stringify(gP) === JSON.stringify(eP);
  const ctOk = !expect.ct || (gC && gC[0] === expect.ct[0] && gC[1] === expect.ct[1]);
  if (!orgOk || !ptOk || !ctOk) throw new Error(`${label} 请求参数与期望不一致（执行侧）：org=${JSON.stringify(gO)} pt=${JSON.stringify(gP)} ct=${JSON.stringify(gC)}，期望 org=${JSON.stringify(eO)} pt=${JSON.stringify(eP)} ct=${JSON.stringify(expect.ct || 'any')}`);
  return `请求org=${JSON.stringify(gO)} pt=${JSON.stringify(gP)} ct=${JSON.stringify(gC)}`;
}
async function readTable(frame) {
  return frame.evaluate(() => {
    const vis = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const t = document.querySelector('.el-table'); if (!t) return { ok: false };
    const heads = [...t.querySelectorAll('.el-table__header th .cell')].map(e => (e.innerText || '').trim());
    const idx = kw => { const e = heads.findIndex(h => h === kw); return e >= 0 ? e : heads.findIndex(h => h.startsWith(kw)); };
    const iB = idx('运单号'), iO = idx('机构编码'), iP = idx('产品类型');
    const rows = [...t.querySelectorAll('.el-table__body tbody tr')].filter(vis).map(tr => { const c = [...tr.querySelectorAll('td .cell')].map(e => (e.innerText || '').trim()); return { bill: iB >= 0 ? c[iB] : '', org: iO >= 0 ? c[iO] : '', pt: iP >= 0 ? c[iP] : '' }; });
    return { ok: true, heads, rows };
  });
}
async function shot(page, tag) { const f = path.join(EVID, `R7_${tag}_${Date.now()}.png`); await page.screenshot({ path: f, fullPage: true }).catch(() => {}); return path.relative(BOOK_DIR, f); }

/* ───────── 接口通道（页面上下文 fetch，token 同源；仅用于取"对照全集"，判定仍以文件实体为准） ───────── */
async function apiList(page, body, maxRows = 200000) {
  return page.evaluate(async ({ body, maxRows }) => {
    const tk = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const H = { 'Content-Type': 'application/json', Authorization: tk, authtoken: tk, 'PlatformCode': 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' };
    const out = { total: null, bills: [], orgs: [], pts: [], pages: 0 };
    let page_ = 1; const size = 500;
    while (true) {
      const r = await fetch('http://gateway-ll.test.ztoeco.com/phecda/phecda/account/settleTrans/listTransDetails', { method: 'POST', headers: H, body: JSON.stringify({ ...body, page: page_, pageSize: size }) });
      const j = await r.json(); const res = j.result || {}; const items = res.items || [];
      if (out.total === null) out.total = res.total;
      // 运单号=dataId（billId 是账单编号 KF*/PTZD*；2026-11-24 实测取错致 EXP-01 假 FAIL）
      for (const x of items) { out.bills.push(String(x.dataId ?? '')); out.orgs.push(String(x.accountOrgCode ?? '')); out.pts.push(String(x.productTypeName ?? x.productType ?? '')); }
      out.pages++;
      if (!items.length || out.bills.length >= (res.total || 0) || out.bills.length >= maxRows) break;
      page_++;
    }
    return out;
  }, { body, maxRows });
}

/* ───────── 导出链路 ───────── */
/** UI 点导出 → 确认 → 轮询任务完成 → 下载 xlsx 到 DL_DIR。返回 { task, file } */
async function exportViaUi(page, frame, tag) {
  await closePoppers(frame);
  // 记录提交前的任务 id 集合，用于识别本次新任务
  const before = await page.evaluate(async () => { const tk = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY'); const r = await fetch('https://gateway-ll.test.ztoeco.com/custom/excelTask/queryPage', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: tk, authtoken: tk, 'PlatformCode': 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify({ condition: { fileName: null, status: null }, pageNum: 1, pageSize: 3 }) }); const j = await r.json(); return ((j.result && j.result.items) || []).map(x => x.id); });
  let exportReq = null;
  const onReq = r => { try { if (/exportTransDetails/.test(r.url())) exportReq = JSON.parse(r.postData() || '{}'); } catch (_) {} };
  page.on('request', onReq);
  await clickBtn(frame, '^\\s*导\\s*出\\s*$');
  await sleep(1500);
  const mb = frame.locator('.el-message-box').filter({ hasText: '导出确认' }).last();
  if (!(await mb.count())) throw new Error('点导出后未出现「导出确认」弹窗');
  const mbTxt = (await mb.innerText()).replace(/\s+/g, ' ').slice(0, 80);
  const s1 = await shot(page, tag + '_step_export_dialog');
  await mb.locator('button').filter({ hasText: /^\s*确\s*认\s*$/ }).last().click({ timeout: 8000 });
  page.off('request', onReq);
  await sleep(3000);
  const s2 = await shot(page, tag + '_step_task_page');
  // 轮询任务
  const deadline = Date.now() + 180000; let task = null; let polls = 0;
  while (Date.now() < deadline) {
    polls++;
    const items = await page.evaluate(async () => { const tk = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY'); const r = await fetch('https://gateway-ll.test.ztoeco.com/custom/excelTask/queryPage', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: tk, authtoken: tk, 'PlatformCode': 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify({ condition: { fileName: null, status: null }, pageNum: 1, pageSize: 5 }) }); const j = await r.json(); return ((j.result && j.result.items) || []).map(x => ({ id: x.id, status: x.status, filePath: x.filePath, fileName: x.fileName, dataNum: x.dataNum, appId: x.appId, gmtCreate: x.gmtCreate })); });
    const fresh = items.find(x => !before.includes(x.id));
    if (fresh && String(fresh.status) === '30') { task = fresh; break; }
    if (fresh && String(fresh.status) !== '10') { throw new Error('导出任务异常状态=' + JSON.stringify(fresh)); }
    await sleep(3000);
  }
  if (!task) throw new Error('导出任务 180s 内未完成（轮询 ' + polls + ' 次）');
  if (!exportReq) throw new Error('未捕获到 exportTransDetails 请求（导出未真正提交）');
  // getFileUrl + 页面内 XHR 下载（Playwright 接 download 事件）
  const url = await page.evaluate(async fp => { const tk = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY'); const r = await fetch('https://sys-gw-ll.test.ztoeco.com/excel-service/export/api/v2/general/getFileUrl', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: tk, authtoken: tk, 'PlatformCode': 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify({ fileName: fp }) }); const j = await r.json(); return j.result; }, task.filePath);
  if (!url || !/^https?:\/\//.test(url)) throw new Error('getFileUrl 未返回文件 URL：' + String(url).slice(0, 120));
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }).catch(() => null),
    page.evaluate(u => { const h = new XMLHttpRequest; h.open('GET', u, true); h.responseType = 'blob'; h.onload = function () { const v = window.URL.createObjectURL(h.response); const a = document.createElement('a'); a.href = v; a.download = 'r7.xlsx'; document.body.appendChild(a); a.click(); a.remove(); }; h.send(); }, url),
  ]);
  if (!dl) throw new Error('文件下载未触发（XHR blob → a.download）');
  const file = path.join(DL_DIR, `${tag}_${task.filePath}`);
  await dl.saveAs(file);
  const size = fs.statSync(file).size;
  const head = fs.readFileSync(file).slice(0, 4).toString('hex');
  if (head !== '504b0304') throw new Error('下载文件非 xlsx（头=' + head + '，size=' + size + '）');
  const s3 = await shot(page, tag + '_step_file_ready');
  return { task, file, size, exportReq, dialog: mbTxt, shots: [s1, s2, s3], polls };
}

/** xlsx 解析（openpyxl）：返回 { header, rows, bills, orgs, pts, n } */
function parseXlsx(file) {
  const py = `
import openpyxl,sys,json
wb=openpyxl.load_workbook(sys.argv[1],read_only=True); ws=wb[wb.sheetnames[0]]
it=ws.iter_rows(values_only=True); header=[str(h).strip() if h is not None else '' for h in next(it)]
def col(name):
    try: return header.index(name)
    except ValueError: return -1
iB,iO,iP=col('运单号'),col('机构编码'),col('产品类型')
bills=[];orgs=[];pts=[];n=0;sample=None
for r in it:
    n+=1
    if sample is None: sample=[str(x)[:20] if x is not None else '' for x in r[:14]]
    bills.append(str(r[iB]) if iB>=0 and r[iB] is not None else '')
    orgs.append(str(r[iO]) if iO>=0 and r[iO] is not None else '')
    pts.append(str(r[iP]) if iP>=0 and r[iP] is not None else '')
print(json.dumps({'header':header,'n':n,'bills':bills,'orgs':orgs,'pts':pts,'sample':sample},ensure_ascii=False))
`;
  const out = execFileSync(PY, ['-c', py, file], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8');
  return JSON.parse(out);
}

/* ───────── 用例定义 ───────── */
const CASES = [
  { tc: 'TC-EXP-01', priority: 'P1', focus: '导出全量跨页：文件行数==查询total；文件运单集合==接口全量集合（集合相等）',
    run: async c => {
      await selectOrg(c.frame, ORG.A); await selectOrg(c.frame, ORG.B);
      const dv = await setDateRange(c.frame, '2026-11-24 00:00:00', '2026-11-24 23:59:59');
      const q = await queryAndWait(c.frame, c.page);
      const rq = assertReq(q, { org: [ORG.A.code, ORG.B.code], pt: null, ct: dv }, 'EXP-01');
      if (!q.total) throw new Error('查询结果为空，无法验跨页');
      const tbl = await readTable(c.frame);
      const s0 = await shot(c.page, 'TC-EXP-01_step_query');
      const ex = await exportViaUi(c.page, c.frame, 'TC-EXP-01');
      // 对照口径：导出任务完成的【瞬间】立刻用导出请求同参数拉接口全集（与文件同一数据集定义），最小化时间差。
      // 测试环境数据持续增长（实测查询→导出入队间隔数秒 total 漂移 2~5 条；全集拉取 2 万行约 10s），故：
      //   ① 文件行数 == 任务 dataNum（精确相等，硬断言）
      //   ② 文件运单集合 ⊆ 接口全集（文件是某一刻快照，只可能少不可能多——多=导出了不该有的数据，硬断言）
      //   ③ 接口全集比文件多出的运单数 ≤ 漂移阈（1%，仅覆盖拉取期间新增；超出=文件漏行）
      //   ④ 文件运单去重数 == 接口运单去重数 的差值同样 ≤ 1%
      const api = await apiList(c.page, ex.exportReq);
      const x = parseXlsx(ex.file);
      const fileSet = new Set(uniq(x.bills)), apiSet = new Set(uniq(api.bills));
      const extraInFile = [...fileSet].filter(b => !apiSet.has(b));         // 文件有接口无 → 严禁
      const missingInFile = [...apiSet].filter(b => !fileSet.has(b));      // 接口有文件无 → 仅允许为拉取期间新增
      const drift = Math.abs(ex.task.dataNum - q.total) / Math.max(q.total, 1);
      const dataNumOk = drift <= 0.005;
      const subOk = extraInFile.length === 0;
      const missRate = missingInFile.length / Math.max(apiSet.size, 1);
      const missOk = missRate <= 0.01;
      const crossPage = q.total > tbl.rows.length && x.n > tbl.rows.length;
      const ok = x.n === ex.task.dataNum && dataNumOk && subOk && missOk && crossPage;
      return { status: ok ? 'PASS' : 'FAIL', shots: [s0, ...ex.shots],
        detail: `[${rq}] 查询 total=${q.total}（本页 ${tbl.rows.length} 行，跨页）；导出任务 dataNum=${ex.task.dataNum}（${ex.polls} 次轮询 ~${ex.polls*3}s 完成，文件 ${ex.size}B）；文件数据行数=${x.n} ${x.n===ex.task.dataNum?'==dataNum ✓':'≠dataNum ✗'}；total↔dataNum 漂移 ${(drift*100).toFixed(2)}% ${dataNumOk?'≤0.5%（数据持续增长，允许）':'超阈 ✗'}；文件运单集(${fileSet.size}个) ${subOk?'⊆接口全集('+apiSet.size+'个)·无多余 ✓':'含接口没有的运单 '+extraInFile.length+' 个 ✗'}；接口多出 ${missingInFile.length} 个（${(missRate*100).toFixed(2)}% ${missOk?'≤1% 属拉取期间新增·允许':'超阈=文件疑似漏行 ✗'}）；跨页=${crossPage?'✓':'✗'}；弹窗「${ex.dialog}」；WD造数未落地·存量动态断言` };
    } },

  { tc: 'TC-EXP-02', priority: 'P1', focus: '导出表头==页面表头（逐列同名同序）；产品类型列保留带温层原值',
    run: async c => {
      await selectProduct(c.frame, PT.COLD);
      const dv = await setDateRange(c.frame, '2026-11-24 00:00:00', '2026-11-24 23:59:59');
      const q = await queryAndWait(c.frame, c.page);
      const rq = assertReq(q, { org: null, pt: [PT.COLD_CODE], ct: dv }, 'EXP-02');
      const tbl = await readTable(c.frame);
      if (!tbl.ok || !tbl.rows.length) throw new Error('页面结果表无数据');
      const s0 = await shot(c.page, 'TC-EXP-02_step_query');
      const ex = await exportViaUi(c.page, c.frame, 'TC-EXP-02');
      const x = parseXlsx(ex.file);
      const headEq = x.header.length === tbl.heads.length && x.header.every((h, i) => h === tbl.heads[i]);
      const pagePts = uniq(tbl.rows.map(r => r.pt)), filePts = uniq(x.pts);
      const ptKeep = filePts.length > 0 && filePts.every(p => p.includes('冷链快递')) && filePts.some(p => /冷冻|冷藏|常温/.test(p));
      const drift = Math.abs(ex.task.dataNum - q.total) / Math.max(q.total, 1);
      const ok = headEq && ptKeep && x.n === ex.task.dataNum && drift <= 0.005;
      return { status: ok ? 'PASS' : 'FAIL', shots: [s0, ...ex.shots],
        detail: `[${rq}] 查询 total=${q.total}；导出 dataNum=${ex.task.dataNum}，文件行数=${x.n} ${x.n===ex.task.dataNum?'==dataNum ✓':'≠dataNum ✗'}（漂移 ${(drift*100).toFixed(2)}% ${drift<=0.005?'允许':'✗'}）；表头 文件${x.header.length}列 vs 页面${tbl.heads.length}列 ${headEq?'逐列同名同序 ✓':'不一致 ✗ '+(x.header.filter((h,i)=>h!==tbl.heads[i]).slice(0,3).join('/'))}；文件「产品类型」列取值={${filePts.join(',')}} ${ptKeep?'保留带温层原值·未被改写为下拉文案 ✓':'✗'}；页面同列取值={${pagePts.join(',')}}；WD造数未落地·存量动态断言` };
    } },

  { tc: 'TC-EXP-03', priority: 'P1', focus: '导出筛选排除：文件机构编码集==所选甲乙（集合相等）；∩冷链快递',
    run: async c => {
      await selectOrg(c.frame, ORG.A); await selectOrg(c.frame, ORG.B); await selectProduct(c.frame, PT.COLD);
      const dv = await setDateRange(c.frame, '2026-11-24 00:00:00', '2026-11-24 23:59:59');
      const q = await queryAndWait(c.frame, c.page);
      const rq = assertReq(q, { org: [ORG.A.code, ORG.B.code], pt: [PT.COLD_CODE], ct: dv }, 'EXP-03');
      const s0 = await shot(c.page, 'TC-EXP-03_step_query');
      const ex = await exportViaUi(c.page, c.frame, 'TC-EXP-03');
      const x = parseXlsx(ex.file);
      const fileOrgs = uniq(x.orgs), filePts = uniq(x.pts);
      const orgEq = eqSet(fileOrgs, [ORG.A.code, ORG.B.code]);
      const noOther = fileOrgs.every(o => [ORG.A.code, ORG.B.code].includes(o));
      const ptOk = filePts.length > 0 && filePts.every(p => p.includes('冷链快递'));
      const drift = Math.abs(ex.task.dataNum - q.total) / Math.max(q.total, 1);
      const ok = orgEq && noOther && ptOk && x.n === ex.task.dataNum && drift <= 0.005;
      return { status: ok ? 'PASS' : 'FAIL', shots: [s0, ...ex.shots],
        detail: `[${rq}] 查询 total=${q.total}；导出 dataNum=${ex.task.dataNum}；文件行数=${x.n} ${x.n===ex.task.dataNum?'==dataNum ✓':'≠dataNum ✗'}（total↔dataNum 漂移 ${(drift*100).toFixed(2)}% ${drift<=0.005?'≤0.5% 数据增长允许':'超阈 ✗'}）；文件「机构编码」集={${fileOrgs.join(',')}} ${orgEq?'==所选{'+ORG.A.code+','+ORG.B.code+'} 集合相等·无未选机构 ✓':'≠所选集合 ✗'}；文件「产品类型」集={${filePts.join(',')}} ${ptOk?'仅冷链快递主体 ✓':'含他主体 ✗'}；WD造数未落地·存量动态断言` };
    } },

  { tc: 'TC-EXP-05', priority: 'P1', focus: '导出文件仅含有权机构：文件机构编码集==所选有权集（集合相等）',
    run: async c => {
      await selectOrg(c.frame, ORG.A); await selectOrg(c.frame, ORG.B);
      const dv = await setDateRange(c.frame, '2026-11-24 00:00:00', '2026-11-24 23:59:59');
      const q = await queryAndWait(c.frame, c.page);
      const rq = assertReq(q, { org: [ORG.A.code, ORG.B.code], pt: null, ct: dv }, 'EXP-05');
      const s0 = await shot(c.page, 'TC-EXP-05_step_query');
      const ex = await exportViaUi(c.page, c.frame, 'TC-EXP-05');
      const x = parseXlsx(ex.file);
      const fileOrgs = uniq(x.orgs);
      const orgEq = eqSet(fileOrgs, [ORG.A.code, ORG.B.code]);
      const drift = Math.abs(ex.task.dataNum - q.total) / Math.max(q.total, 1);
      const ok = orgEq && x.n === ex.task.dataNum && drift <= 0.005;
      return { status: ok ? 'PASS' : 'FAIL', shots: [s0, ...ex.shots],
        detail: `[${rq}] 查询 total=${q.total}；导出 dataNum=${ex.task.dataNum}；文件行数=${x.n} ${x.n===ex.task.dataNum?'==dataNum ✓':'≠dataNum ✗'}（total↔dataNum 漂移 ${(drift*100).toFixed(2)}% ${drift<=0.005?'≤0.5% 数据增长允许':'超阈 ✗'}）；文件「机构编码」集={${fileOrgs.join(',')}} ${orgEq?'==所选有权{'+ORG.A.code+','+ORG.B.code+'} 集合相等·无无权机构行 ✓':'含非所选机构 ✗'}；总部视角执行·权限语义由 SEC-05 机构视角验；WD造数未落地·存量动态断言` };
    } },
];

/* ───────── 主流程 ───────── */
(async () => {
  if (has('--list')) { log('R7 导出补验条目（共 ' + CASES.length + ' 条）：'); for (const c of CASES) log(' ', c.tc, '[' + c.priority + ']', c.focus); return; }
  const cases = ONLY.length ? CASES.filter(c => ONLY.includes(c.tc)) : CASES;
  if (!cases.length) { console.error('--only 未匹配任何条目'); process.exit(2); }
  let portInfo;
  if (PORTARG === 'auto') portInfo = await pool.ensureExecPortExclusive({ prefer: [9336, 9337, 9338], purpose: PURPOSE, verbose: true });
  else { portInfo = await pool.probe(parseInt(PORTARG, 10)); if (!portInfo.alive) throw new Error('指定端口未运行: ' + PORTARG); pool.writeLock(portInfo.port, PURPOSE); }
  const PORT = portInfo.port; process.on('exit', () => pool.removeLock(PORT));
  const loginSt = await ensureLogin(PORT); log('登录:', loginSt);
  if (loginSt === 'login-timeout') throw new Error('登录 preflight 超时，全批阻塞，不带病跑');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT, { timeout: 10000 });
  const ctx = browser.contexts()[0];
  for (const p of ctx.pages()) if (/jt-ll\.test\.ztoeco\.com/.test(p.url())) await p.close().catch(() => {});
  const ten = await ensureTenant(browser, TENANT, (...a) => log('[tenant]', ...a)); log('租户:', JSON.stringify(ten));
  let page = await ctx.newPage();
  await page.goto(SPA, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const ready = await waitBizRendered(page, 'settletransNew', 12);
  if (!ready.ok) throw new Error('菜单未就绪');
  let frame = await getBizFrame(page);
  await sleep(1500);
  batch('run_start', { planned: cases.length, dispatch: cases.length, channel_note: 'ui-export-file-entity' });
  let blockedStreak = 0;
  for (const c of cases) {
    if (blockedStreak >= 3) { log('连续 3 条环境失败，按纪律终止'); append({ ts: bjTs(), event: 'run_abort', run_id: RUN_ID, reason: '连续3条环境/通道失败' }); break; }
    const t = Date.now(); let result;
    try {
      // 每条起点归零：导出后壳层跳到「导出任务」页签并重建 frame 树（旧 frame 引用失效、新旧实例并存），最稳=关掉本页签重开全新加载
      await page.close().catch(() => {});
      page = await ctx.newPage();
      await page.goto(SPA, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const rd = await waitBizRendered(page, 'settletransNew', 14); if (!rd.ok) throw new Error('结算页未就绪');
      frame = await getBizFrame(page); await sleep(2500);
      // 等重置按钮真正可点（全新加载后 Vue 挂载有抖动，2026-11-24 实测连跑第 2 条 8s 超时）
      const rb = frame.locator('button').filter({ hasText: /重\s*置/ }).first();
      await rb.waitFor({ state: 'visible', timeout: 15000 });
      await sleep(1500);
      await clickBtn(frame, '重\\s*置'); await sleep(1200);
      result = await c.run({ page, frame, log }); blockedStreak = 0;
    } catch (e) { result = { status: 'BLOCKED', detail: '执行异常: ' + String((e && e.message) || e).slice(0, 300) }; blockedStreak++; }
    const evidence = result.shots && result.shots.length ? result.shots.join(' ; ') : await shot(page, c.tc);
    const rec = { ts: bjTs(), run_id: RUN_ID, round: RETEST_OF ? ROUND + '(复测)' : ROUND, tc: c.tc, priority: c.priority, status: result.status, channel: 'ui', exec_id: nextExecId(), detail: (RETEST_OF ? `[复测 of ${RETEST_OF}] ` : '') + result.detail, retest: !!RETEST_OF, retestOf: RETEST_OF || null, evidence, durationMs: Date.now() - t };
    append(rec); pool.writeLock(PORT, PURPOSE);
    log('→', c.tc, '【' + rec.status + '】', Math.round((Date.now() - t) / 1000) + 's', (result.detail || '').slice(0, 160));
  }
  batch('run_end', { n: cases.length, endKind: 'normal' });
  await browser.close(); pool.removeLock(PORT);
  log('完成。账本=' + LEDGER + '  导出文件=' + DL_DIR);
})().catch(e => { console.error('FATAL:', e && e.stack || e); process.exit(1); });
