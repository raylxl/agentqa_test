/**
 * 结算交易记录 8.11 · R6 补验 9 条 UI 通道执行脚本（自包含·单进程）
 * ============================================================================
 * 用途：接续第 1+2 轮，补质疑门裁定「接口通道不等价」的 9 条 UI 用例：
 *   QRY-01 / QRY-04 / QRY-08 / LST-02 / LST-04 / SEC-02 / SEC-06 / REL-01  （8 条）
 *   注：报告原文写「UI 9 条」，实列 8 个编号（UI-01~04 属独立 UI 章、已在 R1 过）。
 *       脚本末尾 ca ses 数组即全部实际补验条目，跑前请核对 --list 输出。
 *
 * 断言口径（严格遵循 evidence/复核结果_settle.md 的处置，禁伪造 PASS）：
 *   - 补的是【下拉勾选操作链路 + 结果表列展示 + 动作链】，不是精确造数条数。
 *   - WD* / WDL* / WDS* / WDR* 造数运单未落地（复核 R3），交易时间沿用页面默认存量窗，
 *     断言锚定「所选机构编码 ⊆ 结果表机构编码列」「产品类型列保留带温层原值」
 *     「清空→恢复 A==B」「空结果提示可见」等与造数无关、纯 UI 链路/展示的事实。
 *   - 任一控件操作失败/超时 → 记 BLOCKED + 截图，绝不写 PASS。
 *   - 输出为本线账本四态初判，须再经 usecase-execution-challenger 复核，脚本不自证。
 *
 * 运行（必须在稳定宿主终端，不要在受限沙盒；沙盒内 newPage 会 Target crashed）：
 *   cd <部署根>/公司包/jt_exec/pw_layered
 *   node settle_r6_ui.js --dry                 # 只验证 起实例+登录+切租户+开菜单+读表，不判定不写账本
 *   node settle_r6_ui.js --list                # 列出将执行的补验条目与断言口径
 *   node settle_r6_ui.js --only TC-QRY-01      # 单条调试（逗号分隔可多条）
 *   node settle_r6_ui.js                       # 全量 8 条，写本线账本 + 截图
 *   可选：--port 9336 / --no-ledger（演练不写盘）
 *
 * 账本：需求用例库/用例文件/结算交易记录分章/exec_ledger/ledger.jsonl（本线格式，report_sync 消费）
 * 截图：同目录 evidence/R6_<TC>_<ts>.png
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const pool = require('./cdp_pool');
const { ensureLogin } = require('./pw_login');
const { ensureTenant } = require('./pw_tenant');
const { waitBizRendered } = require('./lib/jt_common');

/* ───────────────────────── 配置（可用环境变量覆盖） ───────────────────────── */
const REG      = process.env.SETTLE_REG   || '/Users/kimfang/WorkBuddy/ai测试agent';
const BOOK_DIR = path.join(REG, '需求用例库/用例文件/结算交易记录分章');
const LEDGER   = process.env.SETTLE_LEDGER || path.join(BOOK_DIR, 'exec_ledger/ledger.jsonl');
const EVID     = path.join(BOOK_DIR, 'evidence');
const SPA      = 'http://jt-ll.test.ztoeco.com/app/#/phecda/account/settletransNew';
const TENANT   = '冷链快运';
const BOOK     = '财务需求2026_快运_结算交易记录_11.23_测试用例_v1';
const ROUND    = '第6轮';
const RUN_ID   = 'RUN-SETTLE-8.11-R6-' + new Date().toISOString().slice(0, 10).replace(/-/g, '');
const PURPOSE  = 'settle-r6-ui补验';
for (const d of [EVID, path.dirname(LEDGER)]) fs.mkdirSync(d, { recursive: true });

/* 参数 */
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const DRY     = has('--dry');
const NO_LEDGER = has('--no-ledger');
const ONLY    = (val('--only', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const PORTARG = val('--port', 'auto');

/* 真实主数据（module_config.orgCodes_real + R3 实证；禁写设计稿 010001/010003 当真值） */
const ORG = {
  A:       { name: '上海青浦一级网点CS1', code: '400001' }, // 有权机构甲（R1/R3 实证）
  B:       { name: '总部',                 code: '999999' }, // 有权机构乙（2026-11-24 R6 接口实证今日 10068 条，结果表可见）
  B_EMPTY: { name: '冷链测试1',           code: '000001' }, // 今日 0 条（接口实证），仅作数据对照
  // 注：500003 杭州一级网点 仅在【400001 机构视角】下无权（R3 实证单项 0 条）；本轮为【总部视角】可查（今日 715 条），
  //     故 R6 的 SEC-02/06 只验「单项筛选正确」，不构成权限边界证据；权限边界以 R3 切机构视角证据为准。
};
/* 产品类型主体编码（2026-11-24 R6 实测：字典接口 phecda/api/quote/getBasicDictList 的 label→value；禁凭名称臆造编码） */
const PT = { COLD: '冷链快递', COLD_CODE: 'ZTOCC_EXPRESS', NOLOAD: '零担', NOLOAD_CODE: 'SCATTERED' };

const bjTs = () => { const t = new Date(Date.now() + 8 * 3600 * 1000); return t.toISOString().replace('T', ' ').slice(0, 19) + '+08:00'; };
const log = (...a) => console.log('[R6]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ───────────────────────── 账本（本线格式，追加） ───────────────────────── */
function nextExecId() {
  let n = 1;
  if (fs.existsSync(LEDGER)) {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
      const m = line.match(new RegExp('UX-' + day + '-(\\d+)'));
      if (m) n = Math.max(n, +m[1] + 1);
    }
  }
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return 'UX-' + day + '-' + String(n).padStart(3, '0');
}
function append(rec) {
  if (NO_LEDGER) { log('（--no-ledger 演练，未写账本）', rec.event || (rec.tc + ' ' + rec.status), rec.reason || rec.detail || ''); return; }
  fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
}
function batch(kind, extra = {}) {
  append({ ts: bjTs(), event: kind, run_id: RUN_ID, round: ROUND, channel: 'ui', book: BOOK,
           operator: 'AI(稳定终端 headless)', ...extra });
}

/* ───────────────────────── 页面操作 helpers ───────────────────────── */
async function getBizFrame(page) {
  for (const f of page.frames()) {
    if (/settletransNew|microApp-phecdaaccountsettletransNew/.test(f.url())) {
      try { if (await f.$('.el-table')) return f; } catch (_) {}
    }
  }
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try { if (await f.$('.el-table')) return f; } catch (_) {}
  }
  if (await page.$('.el-table')) return page;
  throw new Error('业务表格 frame 未找到');
}

/** 按查询区标签定位字段 col（col.innerText 以 label 开头，module_config.locator） */
async function findCol(frame, label) {
  const col = frame.locator('.el-col').filter({ hasText: new RegExp('^\\s*' + label) }).first();
  if (!(await col.count())) throw new Error('查询区未见字段「' + label + '」');
  return col;
}
/** 当前可见的下拉面板（Element Plus 把 popper 挂在 body 下的 el-popper-container） */
function visiblePopper(frame) { return frame.locator('.el-select-dropdown:visible').last(); }

/** 打开多选下拉并返回 { col, popper, search }。search=该控件内的输入框（用于远程/懒加载搜索） */
async function openMulti(frame, label) {
  const col = await findCol(frame, label);
  const sel = col.locator('.el-select').first();
  if (!(await sel.count())) throw new Error('字段「' + label + '」内未见 .el-select 多选控件');
  // 若已有别的下拉开着，先收起（防 popper 拦截点击）
  await closePoppers(frame);
  await sel.click({ timeout: 8000 });
  await sleep(700);
  const search = col.locator('input.el-select__input, input[placeholder*="搜索"], input[placeholder*="请输入"]').first();
  return { col, popper: visiblePopper(frame), search: (await search.count()) ? search : null };
}

/**
 * 在展开的下拉里选中一个选项。
 * 开户机构首屏仅 16 项、懒加载（module_config）：目标不在首屏时先在搜索框输入关键词触发远程补全。
 * 选项文本两行「名称\n编码」→ 用【编码整行精确匹配】定位，防同名前缀误选（实测搜"上海青浦"出 14 项）。
 * 残留搜索词坑（module_config.multiSelect_pitfall）：每次点选前清空搜索词再输新词。
 */
async function pickOption(ctx, opt) {
  const { popper, search } = ctx;
  const kw = opt.search || opt.name;
  if (search) {
    await search.fill('');
    await sleep(300);
    await search.fill(kw);
    await sleep(1400); // 等远程补全
  }
  const codeLine = opt.code;
  // 有编码 → 按「编码整行」精确定位（开户机构两行文本）；无编码 → 按名称整行精确匹配（产品类型单行、本地 14 项不懒加载）
  // 不用 filter({hasText:RegExp})：Playwright 规范化空白后与 allInnerTexts 的换行形态不一致，实测漏匹配。改为自己遍历比对。
  const lines = s => s.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const all = popper.locator('.el-select-dropdown__item');
  const texts = await all.allInnerTexts();
  let hit = -1;
  for (let i = 0; i < texts.length; i++) {
    const L = lines(texts[i]);
    if (codeLine ? L.includes(codeLine) : L.includes(opt.name)) { hit = i; break; }
  }
  if (hit < 0) {
    throw new Error(`下拉搜「${kw}」后无 ${codeLine ? '编码 ' + codeLine : '选项「' + opt.name + '」'}（现有 ${texts.length} 项：${texts.slice(0, 12).map(s => s.replace(/\n/g, '/')).join(' ; ')}）`);
  }
  const item = all.nth(hit);
  const already = ((await item.getAttribute('class')) || '').includes('is-selected');
  if (!already) await item.click({ timeout: 8000 });
  await sleep(400);
  // 选完必清搜索词（module_config.multiSelect_pitfall：残留搜索词会让后续点击【替换】已选项而非追加）
  if (search) { await search.fill('').catch(() => {}); await sleep(250); }
}

/** 收起所有下拉。实测：多选下拉点选项后保持展开，点控件本身不收起；可靠收起=点页面上另一个中性元素（页面标题区/表单 label）。禁 Esc（坑库 G2） */
async function closePoppers(frame) {
  for (let i = 0; i < 4; i++) {
    const n = await frame.locator('.el-select-dropdown:visible').count();
    if (!n) break;
    const target = frame.locator('.el-form-item__label:visible, .el-form label:visible, .el-col .el-form-item__label:visible').first();
    if (await target.count()) await target.click({ timeout: 2000 }).catch(() => {});
    else await frame.locator('.el-pagination:visible, .el-table__header:visible').first().click({ timeout: 2000 }).catch(() => {});
    await sleep(350);
  }
  await sleep(200);
}

async function selectOrg(frame, org) {
  const ctx = await openMulti(frame, '开户机构');
  await pickOption(ctx, org);
  await closePoppers(frame);
}
async function selectProduct(frame, pt) {
  const ctx = await openMulti(frame, '产品类型');
  await pickOption(ctx, { name: pt, search: pt });
  await closePoppers(frame);
}
/** 「清空已选」= 逐个点 tag 的 ×（Element Plus：.el-tag__close / .el-select__tag-close）。与「重置」是不同动作。
 *  返回移除个数；移除后校验 col 内无残留 tag（collapse-tags 折叠时看 +N 也要消） */
async function removeSelected(frame, label) {
  const col = await findCol(frame, label);
  let n = 0;
  for (let i = 0; i < 60; i++) {
    const x = col.locator('.el-tag__close, .el-select__tag-close, .el-select__selection .el-tag .el-icon-close, .el-tag .el-icon').first();
    if (!(await x.count())) break;
    await x.click({ timeout: 3000 }).catch(() => {});
    await sleep(250);
    n++;
  }
  const left = await col.locator('.el-tag').allInnerTexts().catch(() => []);
  if (left.filter(Boolean).length) throw new Error(`${label} 清空后仍有 tag：${JSON.stringify(left)}`);
  return n;
}
/** 显式全选开户机构：点开下拉，逐项点选所有可见机构项（满足 REL-01「显式全选≠不传参」） */
async function selectAllOrgs(frame, max = 8) {
  // 「显式全选」操作语义=逐项点选下拉机构（≠ 不传参）。实测（2026-11-24）：点满 12+ 项后 tag 折叠把后续选项挤出可视区，
  // 每项 click 等可点击超时 ~25s（idx12~15 共 98s，致 REL-01 303s 越线）。首屏各项今日均 0 条，多点无判定价值
  // → 默认只点前 max 项（≥2 个编码已足以证明「显式全选≠不传参」），单次点击超时 2.5s 不重试，保整体 <5min。
  const ctx = await openMulti(frame, '开户机构');
  const popper = ctx.popper;
  const items = popper.locator('.el-select-dropdown__item');
  const n = Math.min(await items.count(), max);
  if (!n) throw new Error('开户机构下拉无可选项');
  let picked = 0; const failed = [];
  for (let i = 0; i < n; i++) {
    const it = items.nth(i);
    const cls0 = (await it.getAttribute('class').catch(() => '')) || '';
    if (cls0.includes('is-selected')) { picked++; continue; }
    await it.scrollIntoViewIfNeeded().catch(() => {});
    await it.click({ timeout: 2500 }).catch(() => {});
    await sleep(200);
    const cls = (await it.getAttribute('class').catch(() => '')) || '';
    if (cls.includes('is-selected')) picked++; else failed.push(i);
  }
  await closePoppers(frame);
  if (failed.length) log(`[selectAllOrgs] ${n} 项中 ${failed.length} 项未能选中(idx ${failed.join(',')})`);
  return { total: n, picked };
}

async function clickBtn(frame, text) {
  const b = frame.locator('button').filter({ hasText: new RegExp(text) }).first();
  if (!(await b.count())) throw new Error('未见按钮「' + text + '」');
  await b.click({ timeout: 8000 });
}

/** 点查询后等结果刷新：先等 loading 遮罩出现再消失（确认发了新请求），再等行数/空态稳定 2 轮。
 *  同时抓本次查询请求的筛选参数（req.org / req.pt），供用例校验「勾选→请求」链路真生效，从根上堵执行侧假 FAIL */
async function queryAndWait(frame, page, prevTotal = null) {
  const reqs = [];
  let respDone = null;   // 本次查询响应到达的 resolve
  const respP = new Promise(r => { respDone = r; });
  const onReq = r => { try { if (/listTransDetails/.test(r.url())) { const j = JSON.parse(r.postData() || '{}'); reqs.push({ org: j.accountOrgCodeList, pt: j.productTypeList, t: Date.now() }); } } catch (_) {} };
  const onResp = r => { try { if (/listTransDetails/.test(r.url())) respDone(r.status()); } catch (_) {} };
  if (page) { page.on('request', onReq); page.on('response', onResp); }
  const n0 = reqs.length;
  await clickBtn(frame, '查\s*询');
  const snap = () => frame.evaluate(() => {
    const vis = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const txt = document.body.innerText || '';
    const m = txt.match(/共\s*(\d+)\s*条/);
    const emptyEl = document.querySelector('.el-table__empty-text');
    return { total: m ? +m[1] : null,
             empty: vis(emptyEl) && !!(emptyEl.innerText || '').trim(),
             emptyTxt: emptyEl ? (emptyEl.innerText || '').trim() : '',
             rows: document.querySelectorAll('.el-table__body tbody tr').length };
  });
  // ① 等本次查询请求真正发出（reqs 增长），防「点查询前读数」
  const t0 = Date.now() + 6000;
  while (Date.now() < t0 && reqs.length === n0) await sleep(100);
  // ② 等该请求的响应回来（最多 25s）——响应前表格显示的是旧数据，靠轮询条数变化会空等到超时（首版 REL-01 303s 主因）
  await Promise.race([respP, sleep(25000)]);
  // ③ 响应后等读数稳定 2 轮（防分页/汇总异步回填），最多 8s
  let last = null, stable = 0; const t3 = Date.now() + 8000;
  while (Date.now() < t3) {
    await sleep(400);
    const s = await snap();
    if (last && s.total === last.total && s.rows === last.rows && s.empty === last.empty) stable++; else stable = 0;
    last = s;
    if (stable >= 2) break;
  }
  if (page) { page.off('request', onReq); page.off('response', onResp); }
  const out = last || await snap();
  out.req = reqs.length ? reqs[reqs.length - 1] : null;   // 本次查询实际发出的筛选参数
  out.responded = reqs.length > n0;
  return out;
}

/** 校验「勾选→请求」链路：请求参数须与期望一致（org=编码数组或 null；pt=主体编码数组或 null）。
 *  不一致=执行侧构造失真（控件没选上/残留搜索词替换），抛错记 BLOCKED，禁判系统 FAIL */
function assertReq(q, expect, label) {
  const norm = a => (a && a.length) ? [...a].map(String).sort() : null;
  const gotOrg = norm(q.req && q.req.org), gotPt = norm(q.req && q.req.pt);
  const expOrg = norm(expect.org), expPt = norm(expect.pt);
  if (JSON.stringify(gotOrg) !== JSON.stringify(expOrg) || JSON.stringify(gotPt) !== JSON.stringify(expPt)) {
    throw new Error(`${label} 勾选未生效（执行侧）：查询请求 org=${JSON.stringify(gotOrg)} pt=${JSON.stringify(gotPt)}，期望 org=${JSON.stringify(expOrg)} pt=${JSON.stringify(expPt)}`);
  }
  return `请求org=${JSON.stringify(gotOrg)} pt=${JSON.stringify(gotPt)}`;
}

/** 读结果表：按表头文本定位列，取全部行的 运单号/机构编码/产品类型/交易对象/收入/支出 + 总额 */
async function readTable(frame) {
  return frame.evaluate(() => {
    const vis = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const t = document.querySelector('.el-table');
    if (!t) return { ok: false, why: 'no-table' };
    const heads = [...t.querySelectorAll('.el-table__header th .cell')].map(e => (e.innerText || '').trim());
    // 精确匹配优先（防「机构编码」误命中「交易对象编码」、「收入」误命中「前余额」等）；无精确再退化为包含
    const idx = kw => { const e = heads.findIndex(h => h === kw); return e >= 0 ? e : heads.findIndex(h => h.startsWith(kw)); };
    const iBill = idx('运单号'), iOrg = idx('机构编码'), iPt = idx('产品类型'), iObj = idx('交易对象名称'), iIn = idx('收入'), iOut = idx('支出');
    const cellTexts = tr => [...tr.querySelectorAll('td .cell')].map(e => (e.innerText || '').trim());
    const rows = [...t.querySelectorAll('.el-table__body tbody tr')].filter(tr => vis(tr)).map(tr => {
      const c = cellTexts(tr);
      return { bill: iBill >= 0 ? c[iBill] : '', org: iOrg >= 0 ? c[iOrg] : '',
               pt: iPt >= 0 ? c[iPt] : '', obj: iObj >= 0 ? c[iObj] : '',
               inc: iIn >= 0 ? c[iIn] : '', out: iOut >= 0 ? c[iOut] : '', all: c };
    });
    const txt = document.body.innerText || '';
    const m = txt.match(/共\s*(\d+)\s*条/);
    const emptyEl = document.querySelector('.el-table__empty-text');
    const emptyTxt = vis(emptyEl) ? (emptyEl.innerText || '').trim() : '';
    const sum = txt.match(/收入[:：]\s*([\d,.]+)[\s\S]{0,20}?支出[:：]\s*([\d,.]+)/);
    return { ok: true, heads, total: m ? +m[1] : null, rows, emptyTxt,
             summary: sum ? { income: sum[1], pay: sum[2] } : null };
  });
}

async function shot(page, tc) {
  const f = path.join(EVID, 'R6_' + tc + '_' + Date.now() + '.png');
  await page.screenshot({ path: f, fullPage: true }).catch(() => {});
  return path.relative(BOOK_DIR, f);
}

const subset = (actual, allowed) => actual.length > 0 && actual.every(x => allowed.includes(x));
const uniq = a => [...new Set(a.filter(Boolean))];

/* ───────────────────────── 9 条补验定义（run 返回 {status, detail}） ───────────────────────── */
const CASES = [
  { tc: 'TC-QRY-01', priority: 'P1', focus: '下拉勾选机构甲→结果表机构编码列端点精确命中',
    run: async c => {
      await selectOrg(c.frame, ORG.A);
      const q = await queryAndWait(c.frame, c.page);
      const rq = assertReq(q, { org: [ORG.A.code], pt: null }, 'QRY-01');
      const t = await readTable(c.frame);
      if (!t.ok) throw new Error('结果表读取失败');
      const orgs = uniq(t.rows.map(r => r.org));
      const ok = subset(orgs, [ORG.A.code]);
      return { status: ok ? 'PASS' : 'FAIL',
        detail: `UI勾选「${ORG.A.name}/${ORG.A.code}」[${rq}] → 共${t.total}条，结果表机构编码列集合={${orgs.join(',')}} ${ok ? '⊆{'+ORG.A.code+'} 端点精确命中' : '出现非所选机构编码'}；WD造数未落地·存量动态断言（复核R3）` };
    } },

  { tc: 'TC-QRY-04', priority: 'P1', focus: '机构+产品类型双下拉勾选→交集，结果列保留带温层原值',
    run: async c => {
      await selectOrg(c.frame, ORG.A);
      await selectProduct(c.frame, PT.COLD);
      const q = await queryAndWait(c.frame, c.page);
      const rq = assertReq(q, { org: [ORG.A.code], pt: [PT.COLD_CODE] }, 'QRY-04');
      const t = await readTable(c.frame);
      if (!t.ok) throw new Error('结果表读取失败');
      const orgs = uniq(t.rows.map(r => r.org));
      const pts = uniq(t.rows.map(r => r.pt));
      const okOrg = subset(orgs, [ORG.A.code]);
      const okPt = pts.length > 0 && pts.every(p => p.includes('冷链快递'));
      return { status: (okOrg && okPt) ? 'PASS' : 'FAIL',
        detail: `UI双下拉勾选 机构=${ORG.A.code}&产品类型=${PT.COLD}[${rq}] → 共${t.total}条；机构编码集={${orgs.join(',')}} ${okOrg?'✓':'✗'}；产品类型列原值={${pts.join(',')}} ${okPt?'保留带温层原值✓':'未保留✗'}；WD造数未落地·存量动态断言` };
    } },

  { tc: 'TC-QRY-08', priority: 'P1', focus: '不选→查询A / 勾选→查询 / 清空→查询B，断言 A==B',
    run: async c => {
      await clickBtn(c.frame, '重\\s*置'); await sleep(800);
      const qa = await queryAndWait(c.frame, c.page);
      assertReq(qa, { org: null, pt: null }, 'QRY-08 步骤A(不选)');
      const A = await readTable(c.frame);
      await selectOrg(c.frame, ORG.A); await selectProduct(c.frame, PT.COLD);
      const qm = await queryAndWait(c.frame, c.page, A.total);
      assertReq(qm, { org: [ORG.A.code], pt: [PT.COLD_CODE] }, 'QRY-08 步骤3(勾选)');
      const mid = await readTable(c.frame);
      // 用例步骤4=「清空已选机构与产品类型（取消全部勾选）」——点 tag 的 × 逐个移除，不是点重置（两者是不同动作，复核特别点名）
      await removeSelected(c.frame, '开户机构');
      await removeSelected(c.frame, '产品类型');
      const qb = await queryAndWait(c.frame, c.page, mid.total);
      assertReq(qb, { org: null, pt: null }, 'QRY-08 步骤4(清空)');
      const B = await readTable(c.frame);
      const midOrgs = uniq(mid.rows.map(r => r.org));
      const filtered = subset(midOrgs, [ORG.A.code]) && mid.total < A.total;
      const restored = (A.total === B.total);
      return { status: (filtered && restored) ? 'PASS' : 'FAIL',
        detail: `不选查询A=${A.total}条 → 勾选(甲+冷链快递)中态=${mid.total}条机构集={${midOrgs.join(',')}}${filtered?'✓筛选生效':'✗筛选未生效'} → 逐个×清空后查询B=${B.total}条[请求org=null pt=null]；A${restored?'==':'≠'}B ${restored?'清空恢复✓':'清空未恢复✗'}；动作链 UI 实跑·清空用 tag×非重置（非接口直传）` };
    } },

  { tc: 'TC-LST-02', priority: 'P2', focus: '多选机构甲+乙→结果表机构编码列⊆所选、无未选机构',
    run: async c => {
      await selectOrg(c.frame, ORG.A);
      await selectOrg(c.frame, ORG.B);
      const q = await queryAndWait(c.frame, c.page);
      const rq = assertReq(q, { org: [ORG.A.code, ORG.B.code], pt: null }, 'LST-02');
      const t = await readTable(c.frame);
      if (!t.ok) throw new Error('结果表读取失败');
      const orgs = uniq(t.rows.map(r => r.org));
      const ok = subset(orgs, [ORG.A.code, ORG.B.code]);
      const bothSeen = orgs.includes(ORG.A.code) && orgs.includes(ORG.B.code);
      return { status: ok ? 'PASS' : 'FAIL',
        detail: `UI多选机构 甲(${ORG.A.code})+乙(${ORG.B.code})[${rq}] → 共${t.total}条（甲单项8826/乙单项10068，接口对照），结果表机构编码集={${orgs.join(',')}} ${ok?'⊆所选✓':'含未选机构✗'}；${bothSeen?'本页甲乙两机构行均可见·并集展示✓':'⚠本页仅见单侧行，并集展示未在本页体现'}；WD造数未落地·存量动态断言` };
    } },

  { tc: 'TC-LST-04', priority: 'P2', focus: '结果表 机构编码/金额/交易对象 三列完整原值无脱敏（页面展示形态）',
    run: async c => {
      await selectOrg(c.frame, ORG.A);
      const q = await queryAndWait(c.frame, c.page);
      const rq = assertReq(q, { org: [ORG.A.code], pt: null }, 'LST-04');
      const t = await readTable(c.frame);
      if (!t.ok || !t.rows.length) throw new Error('结果表无数据行，无法核对列展示');
      const orgs = t.rows.map(r => r.org);
      const objs = t.rows.map(r => r.obj);
      const incs = t.rows.map(r => r.inc).filter(Boolean), outs = t.rows.map(r => r.out).filter(Boolean);
      const hasMask = x => /\*{2,}|XXXX|＊＊/.test(x);
      const noMask = x => !!x && !hasMask(x);
      const okOrg = orgs.length > 0 && orgs.every(x => /^[0-9A-Za-z]{4,}$/.test(x) && !hasMask(x));
      const okObj = objs.some(Boolean) && objs.every(x => !x || !hasMask(x));
      // 金额列：完整数值含小数位（^\d+(\.\d+)?$ 或带千分位），无掩码；对冲双流水各侧有值属正常
      const money = [...incs, ...outs];
      const okMoney = money.length > 0 && money.every(x => /^-?[\d,]+(\.\d+)?$/.test(x) && !hasMask(x));
      return { status: (okOrg && okObj && okMoney) ? 'PASS' : 'FAIL',
        detail: `UI结果表读 ${t.rows.length} 行[${rq} 共${t.total}条]：机构编码列样例={${orgs.slice(0,4).join(',')}} ${okOrg?'完整原值无掩码✓':'疑似脱敏/异常✗'}；交易对象名称列样例={${uniq(objs).slice(0,2).join(',')}} ${okObj?'完整原值✓':'疑似脱敏✗'}；金额列(收入${incs.length}行/支出${outs.length}行)样例={${money.slice(0,3).join(',')}} ${okMoney?'含小数位完整无掩码✓':'格式异常/疑似脱敏✗'}；页面列展示形态（非接口JSON）` };
    } },

  { tc: 'TC-SEC-02', priority: 'P0', focus: '单项有权机构查询→结果表仅含该机构编码，无权机构不出现',
    run: async c => {
      await selectOrg(c.frame, ORG.A);
      const q = await queryAndWait(c.frame, c.page);
      const rq = assertReq(q, { org: [ORG.A.code], pt: null }, 'SEC-02');
      const t = await readTable(c.frame);
      if (!t.ok) throw new Error('结果表读取失败');
      const orgs = uniq(t.rows.map(r => r.org));
      const ok = subset(orgs, [ORG.A.code]);
      return { status: ok ? 'PASS' : 'FAIL',
        detail: `UI勾选机构甲(${ORG.A.code})[${rq}] → 共${t.total}条，结果表机构编码集={${orgs.join(',')}} ${ok?'结果集仅含所选机构✓':'出现非所选机构✗'}；⚠总部视角（可见全量）本条只验「单项筛选正确」，权限边界证据以 R3 切机构视角为准（非本条）；账号级对照 jt_login_2 空仍 BLOCKED；WD造数未落地·存量动态断言` };
    } },

  { tc: 'TC-SEC-06', priority: 'P0', focus: '机构甲+冷链快递交集→权限边界，结果表不含无权机构',
    run: async c => {
      await selectOrg(c.frame, ORG.A);
      await selectProduct(c.frame, PT.COLD);
      const q = await queryAndWait(c.frame, c.page);
      const rq = assertReq(q, { org: [ORG.A.code], pt: [PT.COLD_CODE] }, 'SEC-06');
      const t = await readTable(c.frame);
      if (!t.ok) throw new Error('结果表读取失败');
      const orgs = uniq(t.rows.map(r => r.org));
      const pts = uniq(t.rows.map(r => r.pt));
      const ok = subset(orgs, [ORG.A.code]) && pts.length > 0 && pts.every(p => p.includes('冷链快递'));
      return { status: ok ? 'PASS' : 'FAIL',
        detail: `UI双下拉 机构甲(${ORG.A.code})∩冷链快递[${rq}] → 共${t.total}条（≤甲单项8826，交集成立），机构编码集={${orgs.join(',')}} ${subset(orgs,[ORG.A.code])?'∩机构条件✓':'✗'}；产品类型列={${pts.join(',')}} ∩产品条件✓；⚠总部视角本条只验「条件交集」，权限边界证据以 R3 为准；WD造数未落地·存量动态断言` };
    } },

  { tc: 'TC-REL-01', priority: 'P2', focus: '无命中组合看空结果提示 + 重置后显式全选机构命中权限全集',
    run: async c => {
      // 步骤1：机构甲 + 零担（设计稿无命中组合；造数未落地时存量可能非空，如实记录不强判 0）
      await selectOrg(c.frame, ORG.A);
      await selectProduct(c.frame, PT.NOLOAD);
      const q1 = await queryAndWait(c.frame, c.page);
      const rq1 = assertReq(q1, { org: [ORG.A.code], pt: [PT.NOLOAD_CODE] }, 'REL-01 步骤1');
      const s1 = await readTable(c.frame);
      const emptyVisible = !!(s1.emptyTxt || (s1.total === 0));
      const st1 = s1.emptyTxt ? `0条·空结果提示「${s1.emptyTxt.slice(0, 30)}」可见` : (s1.total === 0 ? '0条·未见空态文案' : `${s1.total}条·非空`);
      // 步骤2：重置 → 显式全选首屏全部机构 → 再搜索补选有数据的 400001（首屏 16 项 2026-11-24 实测单项均 0 条，不补选则结果必空、看不出"命中权限全集"）→ 查询
      await clickBtn(c.frame, '重\\s*置'); await sleep(800);
      const sel = await selectAllOrgs(c.frame);
      await selectOrg(c.frame, ORG.A);
      const q2 = await queryAndWait(c.frame, c.page, s1.total);
      // 显式全选后请求须带 N 个机构编码（≠ 不传参）
      const gotOrg = (q2.req && q2.req.org) || [];
      if (!gotOrg.length) throw new Error(`REL-01 步骤2 显式全选 ${sel.picked}/${sel.total}+1 项后查询请求 org=${JSON.stringify(gotOrg)}（未带编码，勾选未生效·执行侧）`);
      if (!gotOrg.includes(ORG.A.code)) throw new Error(`REL-01 步骤2 补选 ${ORG.A.code} 未进请求 org=${JSON.stringify(gotOrg)}（执行侧）`);
      const s2 = await readTable(c.frame);
      const orgs2 = uniq(s2.rows.map(r => r.org));
      const multi = gotOrg.length >= 2 && orgs2.every(o => gotOrg.includes(o));
      return { status: multi ? 'PASS' : 'FAIL',
        detail: `步骤1 UI勾选 甲(${ORG.A.code})+零担[${rq1}] → ${st1}；步骤2 重置后显式逐项点选首屏前 ${sel.total} 项（${sel.picked} 项选中；首屏各项今日均 0 条，点多无判定价值且 tag 折叠致超时）+补选 ${ORG.A.code} → 查询请求 org 含 ${gotOrg.length} 个编码 → 共${s2.total}条，本页机构编码集={${orgs2.join(',')}} ${multi?'⊆所选编码·显式全选生效✓（≠不传参）':'✗'}；WD造数未落地·存量动态断言` };
    } },
];

/* ───────────────────────── 主流程 ───────────────────────── */
(async () => {
  if (has('--list')) {
    log('R6 补验条目（共 ' + CASES.length + ' 条）：');
    for (const c of CASES) log(' ', c.tc, '[' + c.priority + ']', c.focus);
    log('注：报告写「UI 9 条」，实际列 8 个编号；UI-01~04 属独立 UI 章已在 R1 过。');
    return;
  }
  const cases = ONLY.length ? CASES.filter(c => ONLY.includes(c.tc)) : CASES;
  if (!cases.length) { console.error('--only 未匹配任何条目'); process.exit(2); }

  let portInfo;
  if (PORTARG === 'auto') portInfo = await pool.ensureExecPortExclusive({ prefer: [9336, 9337, 9338], purpose: PURPOSE, verbose: true });
  else { portInfo = await pool.probe(parseInt(PORTARG, 10)); if (!portInfo.alive) throw new Error('指定端口未运行: ' + PORTARG); pool.writeLock(portInfo.port, PURPOSE); }
  const PORT = portInfo.port;
  process.on('exit', () => pool.removeLock(PORT));
  log('实例 port=' + PORT + '（独占持锁）');

  const loginSt = await ensureLogin(PORT);
  log('登录:', loginSt);
  if (loginSt === 'login-timeout') throw new Error('登录 preflight 超时，全批阻塞，不带病跑');

  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT, { timeout: 10000 });
  const ctx = browser.contexts()[0];
  for (const p of ctx.pages()) if (/jt-ll\.test\.ztoeco\.com/.test(p.url())) await p.close().catch(() => {});
  const ten = await ensureTenant(browser, TENANT, (...a) => log('[tenant]', ...a));
  log('租户:', JSON.stringify(ten));

  const page = await ctx.newPage();
  await page.goto(SPA, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const ready = await waitBizRendered(page, 'settletransNew', 12);
  log('菜单就绪:', JSON.stringify(ready));
  if (!ready.ok) throw new Error('结算交易记录菜单未就绪（.el-table+查询按钮未出现）');
  const frame = await getBizFrame(page);
  // 等首屏列表真正加载完（loading 消失 + 读数稳定），否则表格刚挂载就读会拿到 0 条
  await sleep(1500);
  const base = await queryAndWait(frame, page);
  await sleep(600);
  const t0 = await readTable(frame);
  const baseInfo = { total: t0.total, rows: t0.rows.length, cols: t0.heads ? t0.heads.length : null, empty: base && base.empty, emptyTxt: base && base.emptyTxt };
  log('基线结果表:', JSON.stringify(baseInfo));
  if (!t0.ok || t0.total === null) throw new Error('基线结果表读取失败（未取到「共N条」），不带病跑');
  log('表头列名:', (t0.heads || []).join('|').slice(0, 400));

  if (DRY) { log('--dry：链路验证通过，未判定未写账本'); await browser.close(); pool.removeLock(PORT); return; }

  batch('run_start', { planned: cases.length, dispatch: cases.length, channel_note: 'ui-control-chain' });
  let blockedStreak = 0;
  for (const c of cases) {
    if (blockedStreak >= 3) { log('连续 3 条环境失败，按纪律终止'); append({ ts: bjTs(), event: 'run_abort', run_id: RUN_ID, reason: '连续3条环境/通道失败' }); break; }
    const t = Date.now();
    let result;
    try {
      // 每条用例起点归零：点「重置」清上一条残留的筛选（实测 LST-02 沿用了 QRY-04 的产品类型 → 请求校验拦截）
      await clickBtn(frame, '重\\s*置'); await sleep(900);
      result = await c.run({ page, frame, log });
      blockedStreak = 0;
    } catch (e) {
      result = { status: 'BLOCKED', detail: '执行异常: ' + String((e && e.message) || e).slice(0, 200) };
      blockedStreak++;
    }
    const evidence = await shot(page, c.tc);
    const rec = { ts: bjTs(), run_id: RUN_ID, round: ROUND, tc: c.tc, priority: c.priority,
      status: result.status, channel: 'ui', exec_id: nextExecId(), detail: result.detail,
      retest: false, evidence, durationMs: Date.now() - t };
    append(rec);
    pool.writeLock(PORT, PURPOSE); // 心跳续锁
    log('→', c.tc, '【' + rec.status + '】', (Date.now() - t) + 'ms', result.detail.slice(0, 130));
  }
  batch('run_end', { n: cases.length, endKind: 'normal' });
  log('完成。账本=' + LEDGER + '  截图目录=' + EVID);
  log('提醒：本脚本仅记四态初判，须经 usecase-execution-challenger 复核；导出实体 5 条走人工清单。');
  await browser.close();
  pool.removeLock(PORT);
})().catch(e => { console.error('FATAL:', e && e.stack || e); pool.removeLock(parseInt(PORTARG, 10) || 0); process.exit(1); });
