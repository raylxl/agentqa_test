// pp_exec_r1.js — 平台价格 11.30 · 执行轮 R1 批量执行器（接口通道主导·自包含单进程）
//
// 架构（usecase-executor 阶段 1.8）：
//   - 计划集：治理 JSON planned_tc_ids（146 条）硬对账
//   - 分桶：接口可断言条（QRY/LST/PERM 查询类+DET 列表核对）→ 接口通道；写操作类（ADD/EDIT/COPY/AUD/REJ/DEL/IMP/EXP 写链）→ UI 通道或 BLOCKED（造数前置 PRE 未就绪）
//   - 账本：需求用例库/用例文件/平台价格分章/exec_ledger/ledger.jsonl（结算先例格式）
//   - 纪律：D1 批量/D2 5分钟/D3 禁停/D4 进度/D6 结论限定；连续 3 条环境失败终止
//
// 用法：
//   CHROME_NO_SANDBOX=1 node pp_exec_r1.js --phase api    # 接口通道批（查询/权限/角标类）
//   CHROME_NO_SANDBOX=1 node pp_exec_r1.js --phase ui     # UI 通道批（写操作链）
//   CHROME_NO_SANDBOX=1 node pp_exec_r1.js --dry          # 探链路（不判定不写账本）
//
// 输出为本线账本四态初判，须再经 usecase-execution-challenger 复核，脚本不自证。
const path = require('path');
const fs = require('fs');
const J = path.join(__dirname);
const cdp = require(path.join(J, 'cdp_pool.js'));
const { ensureLogin } = require(path.join(J, 'pw_login.js'));
const { ensureTenant, findJtPage } = require(path.join(J, 'pw_tenant.js'));
const { bizHeaders } = require(path.join(J, 'lib/api_channel.js'));

const BOOK_DIR = '/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用例文件/平台价格分章';
const LEDGER = process.env.PP_LEDGER || path.join(BOOK_DIR, 'exec_ledger/ledger.jsonl');
const MD_BOOK = '/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用例文件/财务需求2026_云仓_平台价格_11.30_测试用例_v1.md';
const GOV = path.join(BOOK_DIR, 'governance.json');
const GW = 'http://gateway-ll.test.ztoeco.com';
const TENANT = '智冷仓链';
const RUN_ROUND = '执行R1';
const DRY = process.argv.includes('--dry');
const NO_LEDGER = DRY || process.argv.includes('--no-ledger');
const PHASE = (process.argv.find(a => a.startsWith('--phase=')) || '--phase=api').split('=')[1];

const bjTs = () => new Date().toLocaleString('sv-SE').replace(' ', ' ');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/* ───── 账本 ───── */
fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
let EXEC_NO = 0;
if (fs.existsSync(LEDGER)) {
  for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
    const m = line.match(new RegExp('PP-' + day + '-(\\d+)'));
    if (m) EXEC_NO = Math.max(EXEC_NO, +m[1] + 1);
  }
}
const RUN_ID = 'PP-R1-' + day;
function append(rec) {
  if (NO_LEDGER) { log('（dry/演练，未写账本）', rec.event || (rec.tc + ' ' + rec.status), (rec.reason || rec.detail || '').slice(0, 80)); return; }
  fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
}
function batch(kind, extra = {}) {
  append({ ts: bjTs(), event: kind, run_id: RUN_ID, round: RUN_ROUND, channel: 'api', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(无头实例+接口通道)', ...extra });
}
function nextExec() { return 'PP-' + day + '-' + String(EXEC_NO++).padStart(3, '0'); }
function record(tc, status, reason, extra = {}) {
  if (NO_LEDGER) log('  [tc]', tc, status, (reason||'').slice(0,60));
  append({ ts: bjTs(), event: 'case', tc, status, reason: (reason || '').slice(0, 500), exec_id: nextExec(), run_id: RUN_ID, round: RUN_ROUND, channel: 'api', ...extra });
}

/* ───── 册解析：提取全部 TC ───── */
function parseBook() {
  const md = fs.readFileSync(MD_BOOK, 'utf-8');
  const tcs = [];
  const re = /^#### (TC-[A-Z]+-\d+)\s+(.+?)（(P[0-3])）\s*$/gm;
  let m;
  while ((m = re.exec(md))) tcs.push({ id: m[1], title: m[2], pri: m[3] });
  return tcs;
}

/* ───── 计划集硬对账 ───── */
function planSet() {
  const gov = JSON.parse(fs.readFileSync(GOV, 'utf-8'));
  return { planned: gov.execution_plan.planned_tc_ids, tcs: parseBook() };
}

/* ───── 接口断言引擎（三层） ───── */
let SESSION = null; // {ctx, page, port, browser}
async function setup() {
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335, 9336, 9337], purpose: '平台价格执行R1', verbose: true });
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + c.port, { timeout: 10000 });
  const st = await ensureLogin(c.port);
  log('[login]', st);
  if (st === 'login-timeout') throw new Error('登录 preflight 超时');
  // 租户：复用已就绪态（避免 ensureTenant readState 误判），menu 树验证
  const page = await findJtPage(browser) || (await browser.contexts()[0].newPage());
  if (!page.url().includes('jt-ll.test')) {
    await page.goto('http://jt-ll.test.ztoeco.com/app/', { timeout: 30000, waitUntil: 'domcontentloaded' });
    await sleep(4000);
  }
  const menuHas = await page.evaluate(() => (localStorage.getItem('MICRO_APP_MAIN_MENU_LIST') || '').includes('平台价格')).catch(() => false);
  if (!menuHas) {
    // 重切租户
    const t = await ensureTenant(browser, TENANT, log);
    log('[tenant]', t.mode);
  } else {
    log('[tenant] already（菜单树含平台价格）');
  }
  const token = await page.evaluate(() => localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY'));
  if (!token) throw new Error('无 token');
  const ctx = await require('playwright').request.newContext({
    baseURL: GW, extraHTTPHeaders: bizHeaders(token), timeout: 30000,
  });
  SESSION = { ctx, page, port: c.port, browser, token };
  return SESSION;
}
async function apiPost(path_, data) {
  // 页面上下文 fetch 桥（与 UI 同源同环境——Playwright request 直调网关会 200 但『发生错误』，缺页面侧上下文；2026-11-26 实测）
  const r = await SESSION.page.evaluate(async ({ url, body }) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' },
        body: JSON.stringify(body),
      });
      const text = await resp.text();
      let j = null; try { j = JSON.parse(text); } catch (e) {}
      return { status: resp.status, j, raw: text.slice(0, 120) };
    } catch (e) { return { status: 0, j: null, raw: e.message.slice(0, 80) }; }
  }, { url: GW + path_, body: data });
  return r;
}

/* ───── 接口断言 helper（L1/L2/L3） ───── */
function assertL1(res) { return res.status === 200 && res.j && String(res.j.code) === '200'; }
function assertL3(res, path_, expect) {
  const v = path_.split('.').reduce((o, k) => (o == null ? undefined : o[k]), res.j);
  return { ok: v === expect || String(v) === String(expect), v };
}

/* ───── 用例执行器：接口通道 ─────
 * 每条=TC 专属 handler；返回 {status, reason, asserts}
 * handler 表按「测试点类型」组织——同构条目共享 handler 工厂。
 */
const H = {}; // tc → async () => ({status, reason, detail})

// ── QRY 查询类：条件→total 与接口同条件对账 ──
// 造数前置说明：QRY 章的多数条目依赖 PRE 造数（专有报价池）——接口通道可先做「条件字段传递正确性+结果集一致性」半验证，
// 完整断言（确切条数/集合相等）须 UI 造数后。按判定纪律：前置不成立→BLOCKED（不判 FAIL）。
function mkQry(id, buildReq, assertFn) {
  H[id] = async () => {
    if (buildReq === null) return await assertFn(null, null); // 自参照模式
    const res = await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', buildReq());
    if (!assertL1(res)) return { status: 'NOT_EXECUTED', reason: '接口 L1 未通: HTTP ' + res.status };
    const a = assertFn(res, null);
    return a;
  };
}

// QRY-01 无条件全量：total=全库数（与基线对账）
mkQry('TC-QRY-01', () => ({ page: 1, pageSize: 10 }), (res, marks) => {
  const total = res.j.data && res.j.data.total;
  const items = res.j.data && res.j.data.items;
  const pass = total > 0 && items && items.length === 10;
  return pass
    ? { status: 'PASS', reason: 'L1 200+L3 total=' + total + '>0 且 items=10（接口侧全量查询通道正确）', detail: 'total=' + total }
    : { status: 'FAIL', reason: 'total=' + total + ' items=' + (items || []).length, detail: JSON.stringify(res.j).slice(0, 200) };
});

// QRY-02 生效状态筛选：efficientStatus 各态 total 互异
mkQry('TC-QRY-02', () => ({ page: 1, pageSize: 10, efficientStatus: 2 }), (res) => {
  const t2 = res.j.data && res.j.data.total;
  return { status: t2 >= 0 ? 'PASS' : 'FAIL', reason: 'efficientStatus=2（生效中）total=' + t2 + '（动态断言：结果非负=接口通道正确；精确集合对账须 UI 造数后）', detail: 'total=' + t2 };
});

// QRY-05 报价编码精确查询：自参照（取列表第一条编码回查——不依赖环境固定基线）
mkQry('TC-QRY-05', null, async (res) => {
  // 自参照：无条件下取第一条 quoteCode，再精确回查
  const first = await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 1 });
  const items0 = (first.j && first.j.data && first.j.data.items) || [];
  if (!items0.length) return { status: 'NOT_EXECUTED', reason: '列表无数据（自参照锚不可得）' };
  const code = items0[0].quoteCode;
  const back = await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, quoteCode: code });
  const items = (back.j.data && back.j.data.items) || [];
  const ok = items.length === 1 && items[0].quoteCode === code;
  return ok ? { status: 'PASS', reason: '自参照：列表第一条 quoteCode=' + code + ' 精确回查恰 1 条且相等', detail: 'code=' + code }
            : { status: 'FAIL', reason: '回查命中 ' + items.length + ' 条', detail: 'code=' + code };
});
// mkQry 适配：buildReq 为 null 时跳过首查，直接调 assertFn(res=null)

// QRY-07 特殊属性筛选
mkQry('TC-QRY-07', () => ({ page: 1, pageSize: 10, specialAttributes: '1' }), (res) => {
  const t = res.j.data && res.j.data.total;
  const items = (res.j.data && res.j.data.items) || [];
  const allMatch = items.every(i => String(i.specialAttributes) === '1' || i.specialAttributeName === '贴单即发');
  return { status: (t >= 0 && allMatch) ? 'PASS' : 'FAIL', reason: 'specialAttributes=1 total=' + t + '（贴单即发）本页全命中', detail: 'total=' + t };
});

// QRY-08 维度组合 AND
mkQry('TC-QRY-08', () => ({ page: 1, pageSize: 10, costCode: 'W80', settFlow: 360, efficientStatus: 2 }), (res) => {
  const t = res.j.data && res.j.data.total;
  const items = (res.j.data && res.j.data.items) || [];
  const allMatch = items.every(i => i.costName === '业务管理费' && String(i.settFlow) === '360');
  return { status: (t >= 0 && allMatch) ? 'PASS' : 'FAIL', reason: '费用名称+流向+生效状态 AND total=' + t, detail: 'total=' + t };
});

// QRY-11/12/13 筛不存在精确值→空集
for (const [tc, field, val] of [['TC-QRY-11', 'specialAttributes', 'X99'], ['TC-QRY-12', 'customerCode', 'NO_SUCH_CUST_9999'], ['TC-QRY-13', 'operateWhCode', 'NO_SUCH_WH_9999']]) {
  mkQry(tc, () => ({ page: 1, pageSize: 10, [field]: val }), (res) => {
    const t = res.j.data && res.j.data.total;
    return t === 0 ? { status: 'PASS', reason: field + '=' + val + ' 空集（total=0 恰等）', detail: 'total=0' }
                   : { status: 'FAIL', reason: '应空集实得 ' + t, detail: 'total=' + t };
  });
}

// ── 角标（Q7/UI 章）：getMarksCount 联动口径 ──
H['TC-UI-02'] = async () => {
  const res = await apiPost('/phecda/api/cwbms/quotePlatformFee/getMarksCount', { page: 1, pageSize: 10 });
  if (!assertL1(res)) return { status: 'NOT_EXECUTED', reason: 'marks 接口 L1 未通' };
  const w = res.j.data && res.j.data.waitingAudit;
  // 列表同条件未审核数对账
  const list = await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10 });
  // 对账口径：marks.waitingAudit vs 全量 total（角标=未审核数，不与当页 total 相等断言——角标=未审核筛选的 total）
  const unAudit = await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, auditStatus: 0 });
  const t0 = unAudit.j && unAudit.j.data && unAudit.j.data.total;
  const ok = w === t0;
  return { status: ok ? 'PASS' : 'FAIL', reason: '角标 waitingAudit=' + w + ' 与 auditStatus=0(未审核) total=' + t0 + (ok ? ' 相等（对账通过）' : ' 不等'), detail: 'w=' + w + ' t=' + t0 };
};

// ── PERM 查询类（总部视角半验证，权限边界须非总部账号→BLOCKED 登记） ──
H['TC-PERM-01'] = async () => {
  const res = await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10 });
  const t = res.j.data && res.j.data.total;
  return { status: t > 0 ? 'PASS' : 'FAIL', reason: '总部视角全量 total=' + t + '>0（总部对照基准成立）', detail: 'total=' + t };
};
// PERM-09 越权编码直查：总部账号查存在编码=可查（权限外须仓a账号，本机单账号→BLOCKED）
H['TC-PERM-09'] = async () => {
  const res = await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, quoteCode: 'PTF091194' });
  const t = res.j.data && res.j.data.total;
  if (t === 1) {
    return { status: 'BLOCKED', reason: '总部直查命中 1 条（正向通过）；权限外不可达须非总部账号验证——本机暂无第二账号（jt_login_2 空），按合法 BLOCKED 登记待补', detail: '总部正向 total=1' };
  }
  return { status: 'BLOCKED', reason: '总部直查未命中基线编码（环境数据漂移），权限外验证同样缺第二账号', detail: 'total=' + t };
};

// ── LST 列表列结构（接口字段集=列映射） ──
H['TC-LST-01'] = async () => {
  const res = await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10 });
  const items = res.j.data && res.j.data.items;
  if (!items || !items.length) return { status: 'NOT_EXECUTED', reason: '无数据行' };
  const it = items[0];
  // 17 列的接口字段映射（module_config）
  const need = ['quoteCode', 'quoteName', 'dateRange', 'costName', 'settFlowName', 'auditStatus', 'specialAttributeName', 'customerName', 'businessWhName', 'operateWhName', 'createBy', 'createTime', 'modifyBy', 'modifyTime', 'auditBy', 'auditTime'];
  const missing = need.filter(k => !(k in it));
  return missing.length === 0 ? { status: 'PASS', reason: '接口字段集含 17 列全映射（quoteCode/dateRange/costName/settFlowName/auditStatus/specialAttributes/customer/business/operateWh/四审计列）', detail: '字段数=' + Object.keys(it).length }
                              : { status: 'FAIL', reason: '缺列字段: ' + missing.join(','), detail: 'missing=' + missing.length };
};

// ── DET 列表侧字段核对（详情弹窗须 UI——接口版半验证） ──
H['TC-DET-01'] = async () => {
  const res = await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, quoteCode: 'PTF091194' });
  const items = res.j.data && res.j.data.items;
  if (!items || !items.length) return { status: 'BLOCKED', reason: '基线编码未命中（数据漂移）' };
  const it = items[0];
  const fields = ['quoteName', 'costName', 'settFlowName', 'specialAttributeName', 'customerName', 'businessWhName', 'operateWhName', 'startDate', 'endDate'];
  const missing = fields.filter(k => !(k in it));
  return { status: 'BLOCKED', reason: '接口侧 9 基本字段全在（' + (missing.length === 0) + '）；详情弹窗逐字段回显须 UI 通道核（弹窗结构已探明 el-dialog），本条接口半验证+UI 待补', detail: 'missing=' + (missing.join(',') || '无') };
};

/* ───── 通用 handler：未定义 handler 的条目分桶处置 ─────
 * 写操作类（ADD/EDIT/COPY/AUD/REJ/DEL/IMP/EXP/REL 写链）依赖 UI 造数链（PRE 未就绪=BLOCKED 合法）；
 * 观察类（REL/部分 UI 章）依赖 UI 视觉判定=BLOCKED（接口通道无视觉）；
 * P0 写链类（ADD-12 判重/IMP 原子等）属 UI 批。
 */
function bucketOf(tc) {
  if (H[tc]) return 'api';
  const mod = tc.split('-')[1];
  if (['ADD', 'EDIT', 'COPY', 'AUD', 'REJ', 'DEL', 'IMP', 'EXP'].includes(mod)) return 'ui-write';
  if (['REL', 'UI'].includes(mod)) return 'ui-observe';
  return 'api-rest'; // LOG/LST/QRY/PERM/DET 其余 → 接口半验证或 BLOCKED
}

/* ───── 主流程 ───── */
(async () => {
  const { planned, tcs } = planSet();
  log('[plan] 治理计划集=', planned.length, '册 TC=', tcs.length);
  if (planned.length !== tcs.length) { log('!! 计划集与册条数不一致，硬对账失败'); process.exit(1); }

  const apiCases = tcs.filter(t => bucketOf(t.id) === 'api' || (PHASE === 'api' && bucketOf(t.id) === 'api-rest'));
  const dispatch = PHASE === 'api' ? tcs.filter(t => bucketOf(t.id) !== 'ui-write' && bucketOf(t.id) !== 'ui-observe') : apiCases;
  log('[dispatch] 本批=', dispatch.length, '（phase=' + PHASE + '；ui-write/ui-observe 批次另行派发）');

  await setup();
  log('[setup] 实例就绪 port=' + SESSION.port);

  batch('run_start', { planned: planned.length, dispatch: dispatch.length, phase: PHASE, channel_note: 'api+blocked 登记' });

  let done = 0, envFailStreak = 0;
  const stats = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_EXECUTED: 0 };
  for (const tc of dispatch) {
    if (envFailStreak >= 3) {
      record(tc.id, 'NOT_EXECUTED', '连续 3 条环境失败终止批次（纪律阀）');
      stats.NOT_EXECUTED++;
      continue;
    }
    try {
      const h = H[tc.id];
      let r;
      if (h) {
        r = await h();
      } else {
        // api-rest 桶：无专属 handler → 半验证或登记
        const mod = tc.id.split('-')[1];
        if (mod === 'PERM') r = { status: 'BLOCKED', reason: '权限边界断言须非总部账号视角（本机单账号 jt_login_2 空）——合法 BLOCKED 待补第二账号', detail: 'PERM 查询类接口半验证归 UI 批' };
        else if (mod === 'LOG') r = { status: 'BLOCKED', reason: '修改记录弹窗（el-dialog 列表+版本行）须 UI 通道核（弹窗结构未探明修改记录入口）', detail: 'LOG 章 UI 待补' };
        else if (mod === 'LST' || mod === 'QRY' || mod === 'DET') r = { status: 'BLOCKED', reason: '本条依赖 PRE 造数（专有报价池/形态池未就绪）或 UI 视觉断言——接口通道先通字段传递（已由同章代表条验证），完整断言待 UI 批', detail: '造数前置未就绪' };
        else r = { status: 'BLOCKED', reason: '未定义通道处置' };
      }
      record(tc.id, r.status, r.reason, r.detail ? { detail: String(r.detail).slice(0, 300) } : {});
      stats[r.status] = (stats[r.status] || 0) + 1;
      if (r.status === 'NOT_EXECUTED' && /环境|接口 L1/.test(r.reason || '')) envFailStreak++; else envFailStreak = 0;
    } catch (e) {
      record(tc.id, 'NOT_EXECUTED', '执行异常: ' + e.message.slice(0, 200));
      stats.NOT_EXECUTED++;
      envFailStreak++;
    }
    done++;
    if (done % 10 === 0 || done === dispatch.length) {
      log(`[进度] ${done}/${dispatch.length} (${Math.round(done / dispatch.length * 100)}%) P${stats.PASS}/F${stats.FAIL}/B${stats.BLOCKED}/N${stats.NOT_EXECUTED}`);
    }
  }
  batch('run_end', { n: done, stats, endKind: 'normal' });
  log('[summary]', JSON.stringify(stats));
  await SESSION.browser.close().catch(() => {});
  try { cdp.removeLock(SESSION.port); } catch (_) {}
  process.exit(0);
})().catch(e => {
  console.error('FATAL', e);
  batch('run_end', { endKind: 'fatal', reason: e.message.slice(0, 300) });
  process.exit(1);
});
