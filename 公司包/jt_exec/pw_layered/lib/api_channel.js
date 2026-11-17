/**
 * 接口通道执行库（分层执行模式 · 双通道回归 —— Playwright request / APIRequestContext）
 * 拍板（2026-11-15 方案批准）：接口执行框架=Playwright request，与 UI 通道同框架同 runner 同账本，不另立接口框架
 *
 * 职责：
 *   bootstrapSession({tenant, port})  token 引导：独占实例借取（登录→切租户→读 localStorage token→建 APIRequestContext）
 *                                     实例仅引导期占用（持锁防他端切租户作废 token·G36），业务全程无页面
 *   assertL1 / assertL2 / assertL3    三层断言（接口用例标准 §3）：L1 状态 / L2 结构 / L3 值（数值相等 1000.5=1000.50）
 *   resolveVars / uniq                ${变量} 四类解析（固定值/唯一生成/上游产出/环境注入——标准 §5）；缺变量 fail-fast
 *   makeApiSpec(...)                  接口 spec 工厂：与 UI spec 同构 {id,title,tenant,run}→四态
 *
 * 四态映射（判定标准 v1 通道无关）：请求未发出/网络异常=阻塞；收到响应断言不符=待复核（拍板#3 脚本红回流 AI 定性）；全过=通过
 * 凭证红线：账密只从 JT_ACCOUNT/JT_SECRET 环境变量或 agent-secrets.json 取，缺凭证报错退出（模式照抄 chrome_jt_login.js）
 *
 * CLI：node lib/api_channel.js selftest   （断言助手/变量解析离线自检，不连任何环境）
 */
const fs = require('fs');
const path = require('path');

/* ── playwright 加载：部署器在部署根安装标准依赖，不读取发起人个人目录 ── */
let _pw;
function pw() {
  if (_pw) return _pw;
  try { _pw = require('playwright'); return _pw; }
  catch (_) { throw new Error('playwright 未安装：重跑部署器自动安装，或在部署根执行 npm i playwright'); }
}

/* ── 公司配置 / 凭证（改名免疫：逐级上溯找 agent-company.json / agent-secrets.json） ── */
function findUp(startDir, name, levels = 7) {
  let d = startDir;
  for (let i = 0; i < levels; i++) {
    for (const sub of ['', '公司包', path.join('agentqa_test', '公司包')]) {
      const f = path.join(d, sub, name);
      if (fs.existsSync(f)) return f;
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

function cfg() {
  // 环境块.接口 可配：接口网关 / token借取端口；缺省用现行网关（与 pw_tenant.js 同源）
  const base = { 接口网关: 'http://gateway-ll.test.ztoeco.com' };
  try {
    const f = findUp(__dirname, 'agent-company.json');
    if (f) {
      const e = (JSON.parse(fs.readFileSync(f, 'utf8'))['环境'] || {})['接口'] || {};
      return Object.assign(base, e);
    }
  } catch (_) {}
  return base;
}

function jtCred() {
  if (process.env.JT_ACCOUNT && process.env.JT_SECRET) {
    return { account: process.env.JT_ACCOUNT, secret: process.env.JT_SECRET, display: process.env.JT_DISPLAY || '', source: 'env' };
  }
  const f = findUp(__dirname, 'agent-secrets.json');
  if (f) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8')).jt_login;
      if (j && j.user && j.pass) return { account: j.user, secret: j.pass, display: j.display || '', source: f };
    } catch (_) {}
  }
  throw new Error('未取到鲸天账密：设 JT_ACCOUNT/JT_SECRET，或提供 agent-secrets.json 的 jt_login{user,pass}（api_channel）');
}

/* ── 三层断言助手（纯函数，可离线自检） ── */

/** 空值四分（标准 §3：null / 空串 / 0 / 空数组不得混写）+ 常规类型 */
function kindOf(v) {
  if (v === null) return 'null';
  if (v === '') return '空串';
  if (v === 0) return '零';
  if (Array.isArray(v)) return v.length === 0 ? '空数组' : 'array';
  if (v instanceof Object) return 'object';
  return typeof v;
}

/** L1 状态断言：HTTP 200 + 业务 code 成功（鲸天现行 code='200'，兼容 200/0/'0'） */
function assertL1(status, body, opts = {}) {
  const codeOk = opts.codeOk || (c => c === '200' || c === 200 || c === 0 || c === '0');
  const parts = [`HTTP=${status}`];
  let ok = status === 200;
  if (ok && body !== undefined && body !== null && 'code' in body) {
    ok = codeOk(body.code);
    parts.push(`code=${JSON.stringify(body.code)}`);
    if (body.msg || body.message) parts.push(`msg=${String(body.msg || body.message).slice(0, 80)}`);
  }
  return { ok, evidence: parts.join(' ') };
}

/** L2 结构断言：fields=[['data.list','array'],['data.total','number'],...]（path 缺 type=仅存在性） */
function assertL2(body, fields) {
  const bad = [];
  for (const [p, wantType] of fields) {
    const v = getPath(body, p);
    if (v === undefined) { bad.push(`${p}=缺失`); continue; }
    if (wantType) {
      const got = kindOf(v);
      const norm = { array: 'array', object: 'object', 空数组: 'array' }; // 空数组仍算 array 结构合法
      if ((norm[got] || got) !== wantType) bad.push(`${p}:${got}≠${wantType}`);
    }
  }
  return { ok: bad.length === 0, evidence: bad.length ? '结构不符: ' + bad.join('; ') : `结构${fields.length}项全过` };
}

/**
 * L3 值断言（数值相等优先：1000.5 = 1000.50 = '1000.50'，均按数值比；格式偏离走待确认不判失败——标准 §3）
 * mode: numeric（默认）| eq（深相等）| contains（数组含全部期望项/字符串含子串）| len（数组长度）
 */
function assertL3(actual, expected, mode = 'numeric') {
  if (mode === 'numeric') {
    const a = Number(actual), b = Number(expected);
    const ok = Number.isFinite(a) && Number.isFinite(b) && a === b;
    return { ok, evidence: `${json(actual)} ${ok ? '=' : '≠'} ${json(expected)}（数值比）` };
  }
  if (mode === 'eq') {
    const ok = deepEq(actual, expected);
    return { ok, evidence: `${ok ? '=' : '≠'}（深相等） actual=${json(actual).slice(0, 120)}` };
  }
  if (mode === 'contains') {
    let ok = false, what = 'contains';
    if (Array.isArray(actual)) {
      const items = Array.isArray(expected) ? expected : [expected];
      ok = items.every(e => actual.some(a => deepEq(a, e)));
      what = `集合含 ${items.length} 项`;
    } else if (typeof actual === 'string') {
      ok = actual.includes(String(expected));
      what = '字符串含子串';
    }
    return { ok, evidence: `${what} ${ok ? '✓' : '✗'}` };
  }
  if (mode === 'len') {
    const n = Array.isArray(actual) ? actual.length : -1;
    return { ok: n === Number(expected), evidence: `长度${n} ${n === Number(expected) ? '=' : '≠'} ${expected}` };
  }
  return { ok: false, evidence: `未知 mode=${mode}` };
}

function getPath(obj, p) {
  if (!p) return obj;
  return String(p).split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);
}
function json(v) { try { return JSON.stringify(v); } catch (_) { return String(v); } }
function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b) && Number.isFinite(Number(a));
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => deepEq(a[k], b[k]));
}

/* ── 变量四类解析（标准 §5）：固定值=字面量 / 唯一生成=uniq() / 上游产出=前步 exports / 环境注入=env ── */
function resolveVars(tpl, vars) {
  if (typeof tpl !== 'string') return tpl;
  const missing = [];
  const out = tpl.replace(/\$\{([^}]+)\}/g, (_, k) => {
    const key = k.trim();
    const num = key.startsWith('=');           // ${=唯一.fN} = 数值态保留（长数字 id 替换后 Number 回填，防 string/number 变型）
    const v = getPath(vars, num ? key.slice(1).trim() : key);
    if (v === undefined) { missing.push(key); return '${' + k + '}'; }
    if (num) {
      const n = Number(v);
      if (!Number.isFinite(n)) { missing.push(key + '(数值化失败)'); return '${' + k + '}'; }
      return String(n);
    }
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
  if (missing.length) throw new Error(`变量未提供（fail-fast 禁裸发）: ${[...new Set(missing)].join(', ')}`);
  return out;
}

/** 唯一生成（造数防污染）：前缀+时间戳+两位随机，与 created_names 登记口径一致由 spec 自行 record */
function uniq(prefix) {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 90 + 10)}`;
}

/* ── 请求头配方（照抄 pw_tenant.js L44 现行版；token 只从登录链来——G16） ── */
function bizHeaders(token, extra = {}) {
  return Object.assign({
    Authorization: token, authtoken: token,
    PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc',
  }, extra);
}

/* ── token 引导会话：独占实例借取 → 登录 → 切租户 → 读 token → APIRequestContext ── */
const TOKEN_KEY = 'MICRO_APP_MAIN_TOKEN_KEY';

async function bootstrapSession({ tenant, port, log = () => {} } = {}) {
  if (!tenant) throw new Error('bootstrapSession 需要 tenant（token 是租户域的——G36：先切租户后取 token）');
  const pool = require('../cdp_pool');
  const { ensureLogin } = require('../pw_login');
  const { ensureTenant, findJtPage, LIST_FN, SWITCH_FN } = require('../pw_tenant');

  const PURPOSE = 'api通道token引导';
  const gotAuto = !port;
  let portInfo;
  if (gotAuto) {
    portInfo = await pool.ensureExecPortExclusive({ purpose: PURPOSE, verbose: true }); // 9336+ 优先，避开 9335=AI 执行
  } else {
    portInfo = await pool.probe(parseInt(port, 10));
    if (!portInfo.alive) throw new Error('指定端口实例未运行: ' + port);
    const lk = pool.readLock(portInfo.port);
    if (lk && lk.purpose !== PURPOSE && !process.argv.includes('--force')) {
      throw new Error(`端口 ${portInfo.port} 被「${lk.purpose}」持锁，拒绝借 token；确需强用加 --force`);
    }
    pool.writeLock(portInfo.port, PURPOSE);
  }
  const P = portInfo.port;
  const bail = (msg) => { pool.removeLock(P); throw new Error(msg); };

  const st = await ensureLogin(P);
  log(`登录 preflight: ${st}`);
  if (st === 'login-timeout') bail('登录 preflight 超时（api 引导）');

  const browser = await pw().chromium.connectOverCDP('http://127.0.0.1:' + P, { timeout: 10000 });
  const t = await ensureTenant(browser, tenant, log);
  const token = await readToken(browser);
  if (!token) { await browser.close(); bail('localStorage 未取到 token（登录链异常）'); }
  log(`token 引导完成 tenant=${t.tenant} port=${P} len=${token.length}`);

  const session = {
    token, tenant: t.tenant, port: P, gw: cfg().接口网关,
    async ctx() {
      if (session._ctx) return session._ctx;
      session._ctx = await pw().request.newContext({
        baseURL: session.gw,
        extraHTTPHeaders: bizHeaders(session.token),
        timeout: 30000,
      });
      return session._ctx;
    },
    /** 401 重登一次：强制 changeTenant 同租户重发 token（token 只从登录链来——G16），重建 ctx */
    async refresh() {
      const page = await findJtPage(browser);
      if (!page) throw new Error('refresh: 无鲸天页签（引导页签被关）');
      const res = await page.evaluate(async ({ gw, tenantName, listSrc, switchSrc }) => {
        const tk = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
        const H = { 'Content-Type': 'application/json', Authorization: tk, authtoken: tk, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' };
        const list = await (await fetch(gw + '/merak/user/queryOwnershipTenant', { method: 'POST', headers: H, body: JSON.stringify({ platformCode: 'ZTOCC_PLATFORM_001' }) })).json();
        const me = ((list && list.data) || []).find(x => x.tenantName === tenantName);
        if (!me) return { err: 'refresh: 租户列表未匹配 ' + tenantName };
        const sw = await (await fetch(gw + '/uas/auth/changeTenant', { method: 'POST', headers: H, body: JSON.stringify({ platformCode: 'ZTOCC_PLATFORM_001', tenantId: me.tenantId }) })).json();
        if (String(sw.code) !== '200' || !(sw.data && sw.data.token)) return { err: 'refresh: changeTenant 失败 ' + JSON.stringify(sw).slice(0, 120) };
        localStorage.setItem('MICRO_APP_MAIN_TOKEN_KEY', sw.data.token);
        return { token: sw.data.token };
      }, { gw: session.gw, tenantName: t.tenant, listSrc: '', switchSrc: '' }).catch(e => ({ err: String(e.message || e) }));
      if (res.err) throw new Error(res.err);
      session.token = res.token;
      if (session._ctx) await session._ctx.dispose().catch(() => {});
      session._ctx = null;
      log(`token 已刷新 len=${res.token.length}`);
      return session.ctx();
    },
    async close() {
      if (session._ctx) await session._ctx.dispose().catch(() => {});
      await browser.close(); // 只断 CDP 连接不关浏览器（红线）
      if (gotAuto) pool.removeLock(P);
    },
  };
  return session;
}

async function readToken(browser) {
  const { findJtPage } = require('../pw_tenant');
  const page = await findJtPage(browser);
  if (!page) return null;
  try { return await page.evaluate(k => localStorage.getItem(k), TOKEN_KEY); } catch (_) { return null; }
}

/* ── 接口 spec 工厂：steps=[{name, method, url, headers?, body?, asserts?, exports?}] → 四态 ──
 * asserts: [{layer:'L1', codeOk?}] | [{layer:'L2', fields:[path,type][]}] | [{layer:'L3', path, expect, mode?, note?}]
 * exports: { 变量名: 'data.orderId' }（上游产出→注入后续步骤 vars）
 * draft:true = 候选基准草稿（§7.2.5 基准确认拍板前禁执行，run 直接阻塞）
 */
function makeApiSpec(meta, runBody) {
  return Object.assign({ channel: 'api' }, meta, { run: runBody });
}

/** 步骤执行器（runner 与 spec 共用）：单步请求+断言；网络异常 throw（runner 记阻塞），断言不符返回待复核 */
async function runSteps({ steps, vars = {}, ctx, log = () => {}, draft }) {
  if (draft) return { status: '阻塞', reason: '候选基准草稿：基准确认拍板前禁执行（标准 §7.2.5）' };
  const V = Object.assign({}, vars);
  const evids = [];
  for (const st of steps) {
    const url = resolveVars(st.url, V);
    const headers = st.headers ? JSON.parse(resolveVars(JSON.stringify(st.headers), V)) : undefined;
    let body = st.body;
    if (body !== undefined && typeof body === 'string') { try { body = JSON.parse(resolveVars(body, V)); } catch (_) { body = resolveVars(body, V); } }
    else if (body !== undefined) body = JSON.parse(resolveVars(JSON.stringify(body), V));
    const opts = { method: (st.method || 'POST').toUpperCase(), headers };
    if (opts.method !== 'GET' && opts.method !== 'DELETE' && body !== undefined) opts.data = body;

    const resp = await ctx.fetch(url, opts); // ctx=APIRequestContext 本体（request.newContext 的返回值）；网络异常向上抛 → 阻塞
    const status = resp.status();
    let jbody = null;
    try { jbody = await resp.json(); } catch (_) { /* 非 JSON：L1 只看 HTTP */ }

    for (const a of (st.asserts || [])) {
      let r;
      if (a.layer === 'L1') r = assertL1(status, jbody, { codeOk: a.codeOk });
      else if (a.layer === 'L2') r = assertL2(jbody, a.fields);
      else if (a.layer === 'L3') {
        const actual = getPath(jbody, a.path);
        r = assertL3(actual, typeof a.expect === 'string' ? resolveVars(a.expect, V) : a.expect, a.mode || 'numeric');
        if (a.note) r.evidence = a.note + ' ' + r.evidence;
      } else r = { ok: false, evidence: '未知 layer=' + a.layer };
      if (!r.ok) {
        return { status: '待复核', reason: `[${st.name}] ${a.layer}断言不符: ${r.evidence}; 响应=${json(jbody).slice(0, 220)}` };
      }
      evids.push(`[${st.name}]${a.layer}✓ ${r.evidence}`);
    }
    if (st.exports) {
      for (const [k, p] of Object.entries(st.exports)) {
        const v = getPath(jbody, p);
        if (v === undefined) return { status: '待复核', reason: `[${st.name}] exports.${k} 取值失败: ${p}` };
        V[k] = v;
      }
    }
    log(`[${st.name}] ${opts.method} ${url.slice(0, 90)} → ${status}`);
  }
  return { status: '通过', evidence: evids.join('；').slice(0, 800), vars: V };
}

/* ── 离线自检 ── */
function selftest() {
  const t = (name, cond) => { if (!cond) { console.error('SELFTEST-FAIL:', name); process.exit(1); } console.log('✓', name); };
  // L1
  t('L1 200+code200', assertL1(200, { code: '200' }).ok);
  t('L1 401 拦', !assertL1(401, { code: '200' }).ok);
  t('L1 code-500 拦', !assertL1(200, { code: 500, msg: 'x' }).ok);
  // L2 + 空值四分
  t('L2 类型过', assertL2({ data: { list: [1], total: 2 } }, [['data.list', 'array'], ['data.total', 'number']]).ok);
  t('L2 缺失拦', !assertL2({ data: {} }, [['data.list', 'array']]).ok);
  t('L2 空串≠null', kindOf('') === '空串' && kindOf(null) === 'null' && kindOf(0) === '零' && kindOf([]) === '空数组');
  // L3
  t('L3 数值相等 1000.5=1000.50', assertL3(1000.5, '1000.50').ok);
  t('L3 数值不等拦', !assertL3(1000.5, 1000.51).ok);
  t('L3 深相等', assertL3({ a: 1, b: 'x' }, { b: 'x', a: 1 }, 'eq').ok);
  t('L3 集合含', assertL3([{ n: 'A' }, { n: 'B' }], [{ n: 'B' }], 'contains').ok);
  t('L3 长度', assertL3([1, 2, 3], 3, 'len').ok);
  // 变量
  t('resolveVars 嵌套取值', resolveVars('/x/${a.b}/y', { a: { b: 7 } }) === '/x/7/y');
  t('resolveVars 数值态 ${=}', resolveVars('{"id":${=唯一.f1}}', { 唯一: { f1: '1234567890123' } }) === '{"id":1234567890123}');
  let numFail = false; try { resolveVars('${=唯一.f2}', { 唯一: { f2: 'abc' } }); } catch (_) { numFail = true; }
  t('resolveVars 数值化失败拦', numFail);
  let threw = false; try { resolveVars('${nope}', {}); } catch (_) { threw = true; }
  t('resolveVars 缺变量 fail-fast', threw);
  t('uniq 不重', uniq('TEST_') !== uniq('TEST_'));
  // 头配方
  const h = bizHeaders('tk1'); t('头配方四件', h.Authorization === 'tk1' && h.authtoken === 'tk1' && h.PlatformCode === 'ZTOCC_PLATFORM_001' && h['client-Type'] === 'pc');
  // makeApiSpec 同构
  const s = makeApiSpec({ id: 'API-TEST-001', title: '自检' }, async () => ({ status: '通过' }));
  t('spec 同构 {id,title,run,channel}', s.id === 'API-TEST-001' && typeof s.run === 'function' && s.channel === 'api');
  console.log('SELFTEST-PASS: api_channel 全绿');
}

module.exports = { pw, cfg, jtCred, findUp, kindOf, assertL1, assertL2, assertL3, getPath, resolveVars, uniq, bizHeaders, bootstrapSession, makeApiSpec, runSteps, selftest };

if (require.main === module) {
  if (process.argv[2] === 'selftest') { selftest(); process.exit(0); }
  console.error('用法: node lib/api_channel.js selftest');
  process.exit(2);
}
