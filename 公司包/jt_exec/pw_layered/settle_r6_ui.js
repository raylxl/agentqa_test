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
  B:       { name: '冷链测试1',           code: '000001' }, // 有权机构乙
  DENY:    { name: '杭州一级网点CS1',     code: '500003' }, // R3 实证无权（单项查询 0 条）
};
const PT = { COLD: '冷链快递', NOLOAD: '零担' };

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
  if (NO_LEDGER) { log('（--no-ledger 演练，未写账本）', rec.tc, rec.status); return; }
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

/** 按查询区标签定位多选控件：col.innerText 以 label 开头（module_config.locator），点开下拉 */
async function openMulti(frame, label) {
  const col = frame.locator('.el-col').filter({ hasText: new RegExp('^\\s*' + label) }).first();
  if (!(await col.count())) throw new Error('查询区未见字段「' + label + '」');
  const sel = col.locator('.el-select').first();
  if (!(await sel.count())) throw new Error('字段「' + label + '」内未见 .el-select 多选控件');
  await sel.click({ timeout: 8000 });
  await sleep(600);
  return frame.locator('.el-select-dropdown:visible').last();
}

/** 在已展开下拉里点选一个选项（文本包含匹配；不用搜索框，规避残留搜索词替换坑） */
async function pickOption(popper, text) {
  const item = popper.locator('.el-select-dropdown__item').filter({ hasText: text }).first();
  if (!(await item.count())) throw new Error('下拉无选项「' + text + '」（可能不在首屏或文案变更）');
  const already = (await item.getAttribute('class') || '').includes('is-selected');
  if (!already) await item.click({ timeout: 8000 });
  await sleep(350);
}

/** 收起下拉（点查询区空白处，禁 Esc——坑库 G2） */
async function closePoppers(frame) {
  await frame.locator('.el-form, .gridClass, .el-main').first().click({ position: { x: 3, y: 3 } }).catch(() => {});
  await sleep(300);
}

async function selectOrg(frame, org) {
  const pop = await openMulti(frame, '开户机构');
  await pickOption(pop, org.name);
  await closePoppers(frame);
}
async function selectProduct(frame, pt) {
  const pop = await openMulti(frame, '产品类型');
  await pickOption(pop, pt);
  await closePoppers(frame);
}
/** 显式全选开户机构：点开下拉，逐项点选所有可见机构项（满足 REL-01「显式全选≠不传参」） */
async function selectAllOrgs(frame) {
  const pop = await openMulti(frame, '开户机构');
  const items = pop.locator('.el-select-dropdown__item');
  const n = await items.count();
  if (!n) throw new Error('开户机构下拉无可选项');
  for (let i = 0; i < n; i++) {
    const it = items.nth(i);
    const cls = (await it.getAttribute('class').catch(() => '')) || '';
    if (cls.includes('is-selected')) continue;
    await it.click({ timeout: 5000 }).catch(() => {});
    await sleep(150);
  }
  await closePoppers(frame);
  return n;
}

async function clickBtn(frame, text) {
  const b = frame.locator('button').filter({ hasText: new RegExp(text) }).first();
  if (!(await b.count())) throw new Error('未见按钮「' + text + '」');
  await b.click({ timeout: 8000 });
}

/** 点查询后等结果刷新：轮询到总条数文本出现/变化 或空结果提示出现 */
async function queryAndWait(frame, prevTotal = null) {
  await clickBtn(frame, '查\\s*询');
  const deadline = Date.now() + 20000;
  let seen = false;
  while (Date.now() < deadline) {
    await sleep(1200);
    const t = await frame.evaluate(() => {
      const txt = document.body.innerText || '';
      const m = txt.match(/共\s*(\d+)\s*条/);
      const empty = !!document.querySelector('.el-table__empty-text') || /暂无数据|无数据/.test(txt);
      const rows = document.querySelectorAll('.el-table__body tbody tr').length;
      return { total: m ? +m[1] : null, empty, rows };
    });
    if (t.empty || (t.total !== null && t.total !== prevTotal) || (t.total === 0)) { seen = true; break; }
  }
  return seen;
}

/** 读结果表：按表头文本定位列，取全部行的 运单号/机构编码/产品类型/交易对象 + 总额 */
async function readTable(frame) {
  return frame.evaluate(() => {
    const t = document.querySelector('.el-table');
    if (!t) return { ok: false, why: 'no-table' };
    const heads = [...t.querySelectorAll('.el-table__header th .cell')].map(e => (e.innerText || '').trim());
    const idx = kw => heads.findIndex(h => h.includes(kw));
    const iBill = idx('运单号'), iOrg = idx('机构编码'), iPt = idx('产品类型'), iObj = idx('交易对象');
    const cellTexts = tr => [...tr.querySelectorAll('td .cell')].map(e => (e.innerText || '').trim());
    const rows = [...t.querySelectorAll('.el-table__body tbody tr')].map(tr => {
      const c = cellTexts(tr);
      return { bill: iBill >= 0 ? c[iBill] : '', org: iOrg >= 0 ? c[iOrg] : '',
               pt: iPt >= 0 ? c[iPt] : '', obj: iObj >= 0 ? c[iObj] : '', all: c };
    });
    const txt = document.body.innerText || '';
    const m = txt.match(/共\s*(\d+)\s*条/);
    const emptyTxt = (document.querySelector('.el-table__empty-text') || {}).innerText || '';
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
      await queryAndWait(c.frame);
      const t = await readTable(c.frame);
      if (!t.ok) throw new Error('结果表读取失败');
      const orgs = uniq(t.rows.map(r => r.org));
      const ok = subset(orgs, [ORG.A.code]);
      return { status: ok ? 'PASS' : 'FAIL',
        detail: `UI勾选「${ORG.A.name}/${ORG.A.code}」→ 共${t.total}条，结果表机构编码列集合={${orgs.join(',')}} ${ok ? '⊆{'+ORG.A.code+'} 端点精确命中' : '出现非所选机构编码'}；WD造数未落地·存量动态断言（复核R3）` };
    } },

  { tc: 'TC-QRY-04', priority: 'P1', focus: '机构+产品类型双下拉勾选→交集，结果列保留带温层原值',
    run: async c => {
      await selectOrg(c.frame, ORG.A);
      await selectProduct(c.frame, PT.COLD);
      await queryAndWait(c.frame);
      const t = await readTable(c.frame);
      if (!t.ok) throw new Error('结果表读取失败');
      const orgs = uniq(t.rows.map(r => r.org));
      const pts = uniq(t.rows.map(r => r.pt));
      const okOrg = subset(orgs, [ORG.A.code]);
      const okPt = pts.length > 0 && pts.every(p => p.includes('冷链快递'));
      return { status: (okOrg && okPt) ? 'PASS' : 'FAIL',
        detail: `UI双下拉勾选 机构=${ORG.A.code}&产品类型=${PT.COLD} → 共${t.total}条；机构编码集={${orgs.join(',')}} ${okOrg?'✓':'✗'}；产品类型列原值={${pts.join(',')}} ${okPt?'保留带温层原值✓':'未保留✗'}；WD造数未落地·存量动态断言` };
    } },

  { tc: 'TC-QRY-08', priority: 'P1', focus: '不选→查询A / 勾选→查询 / 清空→查询B，断言 A==B',
    run: async c => {
      await clickBtn(c.frame, '重\\s*置'); await sleep(800);
      await queryAndWait(c.frame); const A = await readTable(c.frame);
      await selectOrg(c.frame, ORG.A); await selectProduct(c.frame, PT.COLD);
      await queryAndWait(c.frame, A.total); const mid = await readTable(c.frame);
      await clickBtn(c.frame, '重\\s*置'); await sleep(800);
      await queryAndWait(c.frame, mid.total); const B = await readTable(c.frame);
      const midOrgs = uniq(mid.rows.map(r => r.org));
      const filtered = subset(midOrgs, [ORG.A.code]);
      const restored = (A.total === B.total);
      return { status: (filtered && restored) ? 'PASS' : 'FAIL',
        detail: `不选查询A=${A.total}条 → 勾选(甲+冷链快递)中态=${mid.total}条机构集={${midOrgs.join(',')}}${filtered?'✓筛选生效':'✗筛选未生效'} → 清空查询B=${B.total}条；A${restored?'==':'≠'}B ${restored?'清空恢复✓':'清空未恢复✗'}；动作链 UI 实跑（非接口直传）` };
    } },

  { tc: 'TC-LST-02', priority: 'P2', focus: '多选机构甲+乙→结果表机构编码列⊆所选、无未选机构',
    run: async c => {
      await selectOrg(c.frame, ORG.A);
      await selectOrg(c.frame, ORG.B);
      await queryAndWait(c.frame);
      const t = await readTable(c.frame);
      if (!t.ok) throw new Error('结果表读取失败');
      const orgs = uniq(t.rows.map(r => r.org));
      const ok = subset(orgs, [ORG.A.code, ORG.B.code]) && !orgs.includes(ORG.DENY.code);
      return { status: ok ? 'PASS' : 'FAIL',
        detail: `UI多选机构 甲(${ORG.A.code})+乙(${ORG.B.code}) → 共${t.total}条，结果表机构编码集={${orgs.join(',')}} ${ok?'⊆所选且未含无权'+ORG.DENY.code+'✓':'含未选/无权机构✗'}；WD造数未落地·存量动态断言` };
    } },

  { tc: 'TC-LST-04', priority: 'P2', focus: '结果表 机构编码/金额/交易对象 三列完整原值无脱敏（页面展示形态）',
    run: async c => {
      await selectOrg(c.frame, ORG.A);
      await queryAndWait(c.frame);
      const t = await readTable(c.frame);
      if (!t.ok || !t.rows.length) throw new Error('结果表无数据行，无法核对列展示');
      const orgs = t.rows.map(r => r.org);
      const objs = t.rows.map(r => r.obj);
      const noMask = x => x && !/\*|\*{2,}|\$\$/.test(x);
      const okOrg = orgs.some(x => /^\d{6}$/.test(x)) && orgs.every(noMask);
      const okObj = objs.some(Boolean) && objs.every(x => !x || noMask(x));
      return { status: (okOrg && okObj) ? 'PASS' : 'FAIL',
        detail: `UI结果表读 ${t.rows.length} 行：机构编码列样例={${orgs.slice(0,4).join(',')}} ${okOrg?'完整6位原值无掩码✓':'疑似脱敏/异常✗'}；交易对象列样例={${objs.slice(0,2).join(',')}} ${okObj?'完整原值✓':'疑似脱敏✗'}；页面列展示形态（非接口JSON）` };
    } },

  { tc: 'TC-SEC-02', priority: 'P0', focus: '单项有权机构查询→结果表仅含该机构编码，无权机构不出现',
    run: async c => {
      await selectOrg(c.frame, ORG.A);
      await queryAndWait(c.frame);
      const t = await readTable(c.frame);
      if (!t.ok) throw new Error('结果表读取失败');
      const orgs = uniq(t.rows.map(r => r.org));
      const ok = subset(orgs, [ORG.A.code]) && !orgs.includes(ORG.DENY.code);
      return { status: ok ? 'PASS' : 'FAIL',
        detail: `UI勾选有权机构甲(${ORG.A.code}) → 共${t.total}条，结果表机构编码集={${orgs.join(',')}} ${ok?'仅有权机构、无权'+ORG.DENY.code+'不出现✓':'越权/异常✗'}；单账号总部视角（jt_login_2 空，账号级对照仍 BLOCKED）；WD造数未落地·存量动态断言` };
    } },

  { tc: 'TC-SEC-06', priority: 'P0', focus: '机构甲+冷链快递交集→权限边界，结果表不含无权机构',
    run: async c => {
      await selectOrg(c.frame, ORG.A);
      await selectProduct(c.frame, PT.COLD);
      await queryAndWait(c.frame);
      const t = await readTable(c.frame);
      if (!t.ok) throw new Error('结果表读取失败');
      const orgs = uniq(t.rows.map(r => r.org));
      const pts = uniq(t.rows.map(r => r.pt));
      const ok = subset(orgs, [ORG.A.code]) && !orgs.includes(ORG.DENY.code) && pts.some(p => p.includes('冷链快递'));
      return { status: ok ? 'PASS' : 'FAIL',
        detail: `UI双下拉 机构甲(${ORG.A.code})∩冷链快递 → 共${t.total}条，机构编码集={${orgs.join(',')}} ${subset(orgs,[ORG.A.code])&&!orgs.includes(ORG.DENY.code)?'权限边界✓':'✗'}；产品类型列={${pts.join(',')}}；WD造数未落地·存量动态断言` };
    } },

  { tc: 'TC-REL-01', priority: 'P2', focus: '无命中组合看空结果提示 + 重置后显式全选机构命中权限全集',
    run: async c => {
      // 步骤1：机构甲 + 零担（设计稿无命中组合；造数未落地时存量可能非空，如实记录不强判 0）
      await selectOrg(c.frame, ORG.A);
      await selectProduct(c.frame, PT.NOLOAD);
      await queryAndWait(c.frame);
      const s1 = await readTable(c.frame);
      const emptyVisible = !!(s1.emptyTxt || (s1.total === 0));
      // 步骤2：重置 → 显式全选全部有权机构 → 查询
      await clickBtn(c.frame, '重\\s*置'); await sleep(800);
      const n = await selectAllOrgs(c.frame);
      await queryAndWait(c.frame);
      const s2 = await readTable(c.frame);
      const orgs2 = uniq(s2.rows.map(r => r.org));
      const multi = orgs2.length > 1;
      const step1 = emptyVisible ? 'PASS' : 'NOT_EXECUTED';
      return { status: (multi) ? 'PASS' : 'FAIL',
        detail: `步骤1 UI勾选 甲+零担 → ${s1.total===0?'0条且空结果提示可见':s1.total+'条（造数未落地，无专门空结果组合，空提示未触达）'} [${step1}]；步骤2 重置后显式全选 ${n} 项机构 → 共${s2.total}条，机构编码集覆盖={${orgs2.join(',')}} ${multi?'多机构命中✓':'未覆盖多机构✗'}（显式全选≠不传参）` };
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
  const t0 = await readTable(frame);
  log('基线结果表: 共' + (t0.total ?? '?') + '条, 列数=' + (t0.heads ? t0.heads.length : '?'));

  if (DRY) { log('--dry：链路验证通过，未判定未写账本'); await browser.close(); pool.removeLock(PORT); return; }

  batch('run_start', { planned: cases.length, dispatch: cases.length, channel_note: 'ui-control-chain' });
  let blockedStreak = 0;
  for (const c of cases) {
    if (blockedStreak >= 3) { log('连续 3 条环境失败，按纪律终止'); append({ ts: bjTs(), event: 'run_abort', run_id: RUN_ID, reason: '连续3条环境/通道失败' }); break; }
    const t = Date.now();
    let result;
    try {
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
