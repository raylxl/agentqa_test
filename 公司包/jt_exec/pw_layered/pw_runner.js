/**
 * 分层执行模式 · 双通道回归运行器（2026-11-15 接口通道立：UI=Playwright CDP / 接口=Playwright request）
 *
 * 用法：
 *   UI 通道（现行为；采集升级为七元组落 apicap/ —— 接口用例标准 §7.2 沉淀素材，通过与否都落）：
 *     node pw_runner.js --specs tc138,tc001 [--port auto|9335] [--channel ui]
 *   接口通道（token 引导=独占实例借取，业务全程无浏览器；api 通道不占实例锁只占数据锁）：
 *     node pw_runner.js --channel api --specs cn_add28,cn_p1query18
 *   双通道：--channel all（同名 spec 两边都有的先 UI 后接口；单边缺文件即跳过该通道）
 *   轮次标签：--run-label <册短码>-R<轮次>（批次行携带人读轮次；不填=纯机器号 R<时间戳>）
 * spec 形态：UI=specs/spec_<name>.js；接口=api_specs/<name>.api.spec.js（makeApiSpec；_pending/ 草稿禁执行 §7.2.5）
 *
 * 流程（UI）：实例池独占取用 → 登录/租户 preflight → 逐 spec 新页签执行 → 断言红=「待复核」（拍板#3）→
 *            环境异常=「阻塞」→ ledger.jsonl（LX-*）+ apicap/<execId>.jsonl + 汇总 last_summary.json
 * 流程（api）：租户分组 → bootstrapSession 借 token（401 refresh 重试一次）→ 逐 spec 三层断言 → ledger（AX- 前缀/channel:'api'）
 * 证据：通过=断言摘要；待复核/阻塞(UI)=截图 shots/ + 网络流 netlog/；api 无页面无截图，evidence/reason 即证据
 */
const fs = require('fs');
const path = require('path');
/* playwright 三级 fallback（裸 require → ai-test-bench → WorkBuddy，同 lib/api_channel；2026-11-15 去硬编码，同事机可解析） */
function _loadPw() {
  const cands = [];
  try { cands.push(require.resolve('playwright')); } catch (_) {}
  cands.push(path.join('D:', 'ZCodetest', 'ai-test-bench', 'node_modules', 'playwright'));
  cands.push(path.join('D:', 'WorkBuddy-projects', 'testcase', 'node_modules', 'playwright'));
  for (const p of cands) { try { return require(p); } catch (_) {} }
  throw new Error('playwright 未找到（fallback：裸 require → ai-test-bench → WorkBuddy）');
}
const { chromium } = _loadPw();
const pool = require('./cdp_pool');
const { ensureLogin } = require('./pw_login');
const { ensureTenant } = require('./pw_tenant');

const LEDGER = path.join(__dirname, 'ledger.jsonl');
const SHOTS = path.join(__dirname, 'shots');
const NETLOG = path.join(__dirname, 'netlog');
const APICAP = path.join(__dirname, 'apicap');
for (const d of [SHOTS, NETLOG, APICAP]) fs.mkdirSync(d, { recursive: true });

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : def; }
const p2 = n => String(n).padStart(2, '0');

/* ── 批次行（执行细则 §十五 v1.11，2026-11-16 拍板：每轮必落 run_start/run_end；时间=北京时间年月日时分秒）── */
function bjTs(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);   // 显式 +8 换算，跑在任意时区机器上口径一致
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())} ${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}:${p2(t.getUTCSeconds())}+08:00`;
}
const RUN_LABEL = arg('run-label', '');   // 人读轮次标签，如 XS-R7（不填=纯机器号）
function writeBatch(kind, runId, extra = {}) {
  const rec = Object.assign({ type: kind, runId, channel: CHANNEL, ts: bjTs(), label: RUN_LABEL }, extra);
  fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
  console.log(`[batch] ${kind} runId=${runId}${RUN_LABEL ? ' label=' + RUN_LABEL : ''} ${rec.ts}`);
}
/* 批次行兜底：异常退出也补 run_end（§十五"中途终止也必须落"；process.exit/未捕获异常均触发 exit） */
const g_openRuns = new Map();   // runId -> { tRun }
process.on('exit', () => { for (const [rid, info] of g_openRuns) writeBatch('run_end', rid, { n: 0, ms: Date.now() - info.tRun, endKind: 'crashed' }); });
const CHANNEL = (arg('channel', 'ui') || 'ui').toLowerCase();
if (!['ui', 'api', 'all'].includes(CHANNEL)) { console.error('--channel 只支持 ui|api|all'); process.exit(2); }

function nextExecId(prefix = 'LX') {
  const d = new Date();
  const day = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
  let n = 1;
  if (fs.existsSync(LEDGER)) {
    for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
      const m = line.match(new RegExp(`"execId":"${prefix}-${day}-(\\d+)"`));
      if (m) n = Math.max(n, +m[1] + 1);
    }
  }
  return `${prefix}-${day}-${String(n).padStart(3, '0')}`;
}

/* ── UI 通道采集（七元组：接口用例标准 §7.2；request/response 用 Request 对象精确配对） ── */
const CAP_RE = new RegExp(process.env.CAP_RE || 'gateway-ll\\.test\\.ztoeco\\.com/(phecda|uas|merak)');
function maskAuth(h = {}) {
  const o = {};
  for (const [k, v] of Object.entries(h)) o[k] = /authorization|authtoken|token|cookie/i.test(k) ? '***' : v;
  return o;
}
function attachCapture(page, spec, execId) {
  const reqMap = new Map(); // playwright Request 对象 → 条目（同 URL 多次请求不错配）
  const cap = [];
  page.on('request', r => { try {
    if (!CAP_RE.test(r.url())) return;
    const e = { seq: cap.length + 1, t: Date.now(), method: r.method(), url: r.url(),
      reqHeaders: maskAuth(r.headers()), reqBody: (r.postData() || '').slice(0, 8000),
      ctx: { tag: 'ui', tc: spec.id, execId } };
    cap.push(e); reqMap.set(r, e);
  } catch (_) {} });
  page.on('response', r => { try {
    if (!CAP_RE.test(r.url())) return;
    const e = reqMap.get(r.request()); if (!e) return;
    e.respStatus = r.status(); e.mime = r.headers()['content-type'] || '';
    r.text().then(b => { e.respBody = b.slice(0, 20000); }).catch(() => { e.respBodyErr = 'body不可得'; });
  } catch (_) {} });
  return cap;
}

/* ── UI 通道批次（行为同旧版，采集从"失败才记 netlog 摘要"升级为"全量七元组落 apicap"） ── */
async function runUiBatch(specs) {
  const PURPOSE = 'pw_layered脚本回归';
  const portArg = arg('port', 'auto');
  let portInfo;
  if (portArg === 'auto') {
    portInfo = await pool.ensureExecPortExclusive({ purpose: PURPOSE, verbose: true });
  } else {
    const p = parseInt(portArg, 10);
    portInfo = await pool.probe(p);
    if (!portInfo.alive) throw new Error('指定端口实例未运行: ' + portArg);
    const lk = pool.readLock(p);
    if (lk && lk.purpose !== PURPOSE && !process.argv.includes('--force')) throw new Error(`端口 ${p} 被「${lk.purpose}」持锁（${lk.ts}），拒绝共用；确需强用加 --force`);
    pool.writeLock(p, PURPOSE);
  }
  const LOCKED = portInfo.port;
  process.on('exit', () => pool.removeLock(LOCKED)); // 异常退出也解锁（被强杀则靠 60 分钟过期）
  console.log(`[runner] 实例 port=${LOCKED}（独占持锁）`);

  const loginSt = await ensureLogin(portInfo.port); // 登录 preflight（过期自动重登；超时=全批阻塞，不带病跑）
  console.log('[runner] 登录:', loginSt);
  const runId = 'R' + Date.now();
  const tRun = Date.now();
  writeBatch('run_start', runId, { n: specs.length });
  g_openRuns.set(runId, { tRun });

  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + portInfo.port, { timeout: 10000 });
  const ctx = browser.contexts()[0];
  for (const p of ctx.pages()) if (/phecda|quantityPolicy|warehouseOperationPrice|warehouse-menu/.test(p.url())) await p.close().catch(() => {}); // 清旧业务页签（2026-11-15 补新路由：菜单改版后 URL=warehouse-menu/…，旧正则漏清致实例被误判占用）

  const results = [];
  for (const spec of specs) {
    const execId = nextExecId();
    const log = (...a) => console.log(`[${execId} ${spec.id}]`, ...a);
    const t0 = Date.now();
    let rec;
    // 沉淀期已知缺陷跳过：spec 标记 blocked=原因 → 不执行，台账记「阻塞·blocked」
    if (spec.blocked) {
      rec = { execId, runId, tc: spec.id, title: spec.title, channel: 'script', port: portInfo.port, tenant: spec.tenant,
        status: '阻塞', reason: 'blocked: ' + spec.blocked, durationMs: Date.now() - t0, ts: new Date().toISOString() };
      fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
      pool.writeLock(LOCKED, PURPOSE);
      console.log(`→ ${spec.id} 【阻塞·blocked 跳过】 ${spec.blocked}`);
      results.push(rec);
      continue;
    }
    try {
      if (loginSt === 'login-timeout') throw new Error('登录 preflight 超时（见 shots/login_timeout）');
      const ten = await ensureTenant(browser, spec.tenant, log); // 租户 preflight（幂等，不对自动切）
      const page = await ctx.newPage();
      const cap = attachCapture(page, spec, execId);
      const net = []; // 失败取证摘要（保留旧 netlog 口径）
      page.on('request', r => { try { if (CAP_RE.test(r.url())) net.push({ ev: 'req', t: Date.now(), m: r.method(), u: r.url().slice(0, 160), body: (r.postData() || '').slice(0, 300) }); } catch (_) {} });
      page.on('response', r => { try { if (CAP_RE.test(r.url())) net.push({ ev: 'resp', t: Date.now(), s: r.status(), u: r.url().slice(0, 160) }); } catch (_) {} });
      // 导航到目标业务页（spec 依赖页面已渲染；下例=某租户默认页钩子，各域自定）
      if (spec.tenant === '智冷仓链') {
        await page.goto('http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/warehouseOperationPrice', { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(6000);
      }
      let out;
      try { out = await spec.run({ page, log, stamp: undefined, sleep: require('./helpers').sleep }) || {}; }
      catch (e) { out = { status: '阻塞', reason: '执行异常: ' + String((e && e.message) || e).slice(0, 220) }; }
      // 证据：非通过→截图+网络流（page 关闭前）
      let shot = '';
      if ((out.status || '通过') !== '通过') {
        shot = path.join(SHOTS, execId + '.png');
        await page.screenshot({ path: shot, fullPage: true }).catch(() => { shot = ''; });
        fs.writeFileSync(path.join(NETLOG, execId + '.jsonl'), net.map(x => JSON.stringify(x)).join('\n') || '');
      }
      // 七元组采集落盘（通过与否都落——接口沉淀素材，标准 §7.2；depose_api.js 消费）
      await page.waitForTimeout(300).catch(() => {}); // 末尾响应体 flush 余量
      const capFile = path.join(APICAP, execId + '.jsonl');
      fs.writeFileSync(capFile, cap.map(x => JSON.stringify(x)).join('\n') + (cap.length ? '\n' : ''));
      await page.close().catch(() => {});
      rec = { execId, runId, tc: spec.id, title: spec.title, channel: 'script', port: portInfo.port, tenant: ten.tenant,
        status: out.status || '通过', evidence: out.evidence || '', reason: out.reason || '', cleanup: out.cleanup || '',
        durationMs: Date.now() - t0, ts: new Date().toISOString() };
      if (shot) rec.shot = shot;
      if (cap.length) rec.apicap = capFile;
    } catch (e) {
      rec = { execId, runId, tc: spec.id, title: spec.title, channel: 'script', port: portInfo.port, tenant: spec.tenant,
        status: '阻塞', reason: 'preflight失败: ' + String((e && e.message) || e).slice(0, 220),
        durationMs: Date.now() - t0, ts: new Date().toISOString() };
    }
    fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
    pool.writeLock(LOCKED, PURPOSE); // 心跳续锁（长批次不因 60 分钟过期被他人取走）
    console.log(`→ ${spec.id} 【${rec.status}】 ${rec.durationMs}ms  ${(rec.reason || rec.evidence || '').slice(0, 160)}${rec.apicap ? ' cap=' + rec.apicap.split(path.sep).pop() + '(' + (fs.readFileSync(rec.apicap, 'utf8').split('\n').filter(Boolean).length) + '条)' : ''}`);
    results.push(rec);
  }
  await browser.close();
  pool.removeLock(LOCKED);
  console.log(`[pool] 解锁 ${LOCKED}`);
  writeBatch('run_end', runId, { n: results.length, ms: Date.now() - tRun, endKind: 'normal' });
  g_openRuns.delete(runId);
  return results;
}

/* ── 接口通道批次（token 引导=独占实例借取·持锁防他端切租户作废 token；业务全程无页面） ── */
async function runApiBatch(specs) {
  const { bootstrapSession } = require('./lib/api_channel');

  // api 数据锁（防双跑互写同租户数据；与 cdp_pool 锁同格式，60 分钟 TTL）
  const locksDir = path.join(__dirname, 'locks');
  fs.mkdirSync(locksDir, { recursive: true });
  const apiLock = path.join(locksDir, 'api-channel.lock');
  if (fs.existsSync(apiLock)) {
    try {
      const lk = JSON.parse(fs.readFileSync(apiLock, 'utf8'));
      if (Date.now() - new Date(lk.ts).getTime() < 60 * 60 * 1000 && lk.pid !== process.pid) {
        throw new Error(`api 通道被 PID ${lk.pid} 持锁（${lk.ts}），拒绝并行写数；确认无人在跑可删 ${apiLock}`);
      }
    } catch (e) { if (String(e.message).includes('持锁')) throw e; }
  }
  fs.writeFileSync(apiLock, JSON.stringify({ purpose: 'api通道回归', ts: new Date().toISOString(), pid: process.pid }));
  process.on('exit', () => { try { fs.unlinkSync(apiLock); } catch (_) {} });
  console.log('[runner] api 通道数据锁已取（无浏览器实例占用）');

  // 按租户分组各建一个引导会话（token 是租户域的——G36：先切租户后取 token）
  const byTenant = new Map();
  for (const s of specs) {
    const t = s.tenant || '(spec未填tenant)';
    if (!byTenant.has(t)) byTenant.set(t, []);
    byTenant.get(t).push(s);
  }
  const runId = 'R' + Date.now();
  const tRun = Date.now();
  writeBatch('run_start', runId, { n: specs.length });
  g_openRuns.set(runId, { tRun });
  const results = [];
  for (const [tenant, list] of byTenant) {
    const ap = (...a) => console.log(`[api:${tenant}]`, ...a);
    if (tenant === '(spec未填tenant)') {
      for (const spec of list) {
        const rec = { execId: nextExecId('AX'), runId, tc: spec.id, title: spec.title, channel: 'api', port: '', tenant,
          status: '阻塞', reason: 'spec.tenant 未填（token 是租户域的，禁缺省）', durationMs: 0, ts: new Date().toISOString() };
        fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
        console.log(`→ ${spec.id} 【阻塞】 spec.tenant 未填`);
        results.push(rec);
      }
      continue;
    }
    let session;
    try {
      session = await bootstrapSession({ tenant, log: ap });
    } catch (e) {
      for (const spec of list) {
        const rec = { execId: nextExecId('AX'), runId, tc: spec.id, title: spec.title, channel: 'api', port: '', tenant,
          status: '阻塞', reason: 'token引导失败: ' + String((e && e.message) || e).slice(0, 200), durationMs: 0, ts: new Date().toISOString() };
        fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
        console.log(`→ ${spec.id} 【阻塞】 token引导失败 ${String(e.message || e).slice(0, 120)}`);
        results.push(rec);
      }
      continue;
    }
    ap(`引导完成 port=${session.port} gw=${session.gw}`);
    let ctx = await session.ctx();
    for (const spec of list) {
      const execId = nextExecId('AX');
      const log = (...a) => console.log(`[${execId} ${spec.id}]`, ...a);
      const t0 = Date.now();
      let out;
      if (spec.draft) {
        out = { status: '阻塞', reason: '候选基准草稿禁执行（标准 §7.2.5）：基准确认拍板后迁出 _pending/ 并置 draft:false' };
      } else {
        try {
          out = (await spec.run({ ctx, log, vars: {} })) || {};
          // 401 重登一次：refresh（changeTenant 同租户重发 token——G16 token 只从登录链来）后重试
          if (out.status === '待复核' && /HTTP=401/.test(out.reason || '')) {
            log('401 → refresh token 重试一次');
            ctx = await session.refresh();
            out = (await spec.run({ ctx, log, vars: {} })) || {};
            out.evidence = (out.evidence || '') + '；401后refresh重试';
          }
        } catch (e) {
          out = { status: '阻塞', reason: '网络异常: ' + String((e && e.message) || e).slice(0, 220) };
        }
      }
      const rec = { execId, runId, tc: spec.id, title: spec.title, channel: 'api', port: session.port, tenant,
        status: out.status || '通过', evidence: out.evidence || '', reason: out.reason || '', cleanup: out.cleanup || '',
        durationMs: Date.now() - t0, ts: new Date().toISOString() };
      fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
      console.log(`→ ${spec.id} 【${rec.status}】 ${rec.durationMs}ms  ${(rec.reason || rec.evidence || '').slice(0, 160)}`);
      results.push(rec);
    }
    await session.close();
    ap(`会话关闭（实例锁已还）`);
  }
  writeBatch('run_end', runId, { n: results.length, ms: Date.now() - tRun, endKind: 'normal' });
  g_openRuns.delete(runId);
  return results;
}

(async () => {
  const specNames = (arg('specs', '') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!specNames.length) { console.error('用法: node pw_runner.js [--channel ui|api|all] --specs tc138,cn_add28,...'); process.exit(2); }

  const loadOr = f => { try { return require(f); } catch (_) { return null; } };
  let uiSpecs = [], apiSpecs = [];
  if (CHANNEL === 'ui' || CHANNEL === 'all') {
    uiSpecs = specNames.map(n => loadOr(path.join(__dirname, 'specs', 'spec_' + n + '.js')));
    if (uiSpecs.some(s => !s)) { console.error('缺 UI spec: ' + specNames.filter((n, i) => !uiSpecs[i]).join(',')); process.exit(2); }
  }
  if (CHANNEL === 'api' || CHANNEL === 'all') {
    apiSpecs = specNames.map(n => loadOr(path.join(__dirname, 'api_specs', n + '.api.spec.js')));
    const missing = specNames.filter((n, i) => !apiSpecs[i]);
    if (missing.length && CHANNEL === 'api') { console.error('缺 api spec: ' + missing.join(',') + '（api_specs/<name>.api.spec.js）'); process.exit(2); }
    if (missing.length && CHANNEL === 'all') console.log('[runner] 以下名字无 api spec，仅跑 UI: ' + missing.join(','));
    apiSpecs = apiSpecs.filter(Boolean);
  }

  const results = [];
  if (uiSpecs.length) results.push(...await runUiBatch(uiSpecs));
  if (apiSpecs.length) results.push(...await runApiBatch(apiSpecs));

  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  const summary = { runId: 'R' + Date.now(), channel: CHANNEL, total: results.length, counts, results, finishedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(__dirname, 'last_summary.json'), JSON.stringify(summary, null, 1));
  console.log('=== 汇总 ===', JSON.stringify(counts), `台账=${LEDGER}`);
})().catch(e => { console.error('FATAL:', (e && e.stack || e).slice ? String(e.stack || e).slice(0, 500) : e); process.exit(1); });
