/**
 * 接口流量采集守护（UI 首测旁路录制 —— 接口用例标准 §7.2 采集管道）
 *
 * 挂到 AI 执行实例（默认 9335）被动监听全部页签（含执行中新开的页签，Target.setAutoAttach），
 * 落七元组 JSONL：{seq,t,method,url,reqHeaders(鉴权脱敏),reqBody,respStatus,respBody,mime,ctx:{tag}}
 * 步骤绑定在沉淀期由 AI 按用例步骤文本+时序对齐（depose_api.js），daemon 只管忠实采集。
 *
 * 用法：node netcap_daemon.js --port 9335 --tag 客户特定首测 [--out ../apicap] [--duration 600] [--domains ztoeco]
 *   duration 到点或 Ctrl+C → 补齐未取响应体（Network.getResponseBody，模式照抄 _netcap2.js）→ 追加 _done 行收尾
 *
 * 采集过滤（标准 §7.2.3 收/不收，可配项就地调）：域过滤 domains；排除静态资源/版本探测；
 *   埋点/轮询/binary 的终判在 depose_api（daemon 采集尽量全，宁多勿漏）。
 * 鉴权头脱敏存储（标准 §7.2.1）：authorization/authtoken/token/cookie → '***'
 */
const fs = require('fs');
const path = require('path');

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : def; }
const PORT = parseInt(arg('port', '9335'), 10);
const TAG = arg('tag', 'netcap');
const OUT = path.resolve(__dirname, arg('out', path.join(__dirname, 'apicap')));
const DURATION = parseInt(arg('duration', '600'), 10) * 1000;
const DOMAINS = new RegExp(arg('domains', 'ztoeco'), 'i');
const SKIP_RE = /\.(js|css|png|jpe?g|gif|svg|ico|woff2?|ttf|map)(\?|$)|\/version\.json|\/favicon/i;
const TELEMETRY_RE = /\/(monitor|collect|track|sentry|buried|logs?)\b/i;
const BODY_CAP = 20000, REQ_CAP = 8000;
const AUTH_RE = /authorization|authtoken|token|cookie/i;

function maskAuth(h = {}) {
  const out = {};
  for (const [k, v] of Object.entries(h)) out[k] = AUTH_RE.test(k) ? '***' : v;
  return out;
}
const p2 = n => String(n).padStart(2, '0');
const ts = new Date();
const FILE = path.join(OUT, `${TAG}_${ts.getFullYear()}${p2(ts.getMonth() + 1)}${p2(ts.getDate())}-${p2(ts.getHours())}${p2(ts.getMinutes())}${p2(ts.getSeconds())}.jsonl`);
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  if (typeof WebSocket === 'undefined') { console.error('本 Node 无全局 WebSocket（需 Node 21+）'); process.exit(1); }
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl); // 浏览器级连接 + flatten 会话路由（比 _netcap2 单页签更全）
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    const msg = { id: i, method, params };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
    setTimeout(() => { if (pending.has(i)) { pending.get(i).rej(new Error('CDP 超时 ' + method)); pending.delete(i); } }, 15000);
  });

  const entries = new Map();     // key = sessionId:requestId
  const order = [];
  let seq = 0, done = false;

  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id); return; }
    const sid = m.sessionId || '';
    if (m.method === 'Target.attachedToTarget') {
      const s2 = m.params.sessionId;
      send('Network.enable', {}, s2).catch(() => {});
      console.error(`[netcap] attach 目标 ${String(m.params.targetInfo && m.params.targetInfo.url).slice(0, 90)}`);
      return;
    }
    if (m.method === 'Network.requestWillBeSent') {
      const r = m.params.request;
      if (!DOMAINS.test(r.url) || SKIP_RE.test(r.url) || TELEMETRY_RE.test(r.url)) return;
      const key = sid + ':' + m.params.requestId;
      const e = { seq: ++seq, t: Date.now(), method: r.method, url: r.url, reqHeaders: maskAuth(r.headers), reqBody: (r.postData || '').slice(0, REQ_CAP), ctx: { tag: TAG } };
      entries.set(key, e); order.push(key);
      return;
    }
    if (m.method === 'Network.responseReceived') {
      const key = sid + ':' + m.params.requestId;
      const e = entries.get(key);
      if (e) { e.respStatus = m.params.response.status; e.mime = (m.params.response.headers || {})['content-type'] || (m.params.response.headers || {})['Content-Type'] || ''; }
      return;
    }
    if (m.method === 'Network.loadingFinished') {
      const key = sid + ':' + m.params.requestId;
      const e = entries.get(key);
      if (e) e._finished = Date.now();
      return;
    }
    if (m.method === 'Network.loadingFailed') {
      const key = sid + ':' + m.params.requestId;
      const e = entries.get(key);
      if (e) e._failed = String(m.params.errorText || 'loadingFailed');
    }
  };
  await new Promise((r, rej) => { ws.onopen = r; ws.onerror = e => rej(new Error('WS 连接失败：实例 ' + PORT + ' 未运行？')); });

  fs.appendFileSync(FILE, JSON.stringify({ meta: { file: path.basename(FILE), tag: TAG, port: PORT, startedAt: new Date().toISOString(), domains: String(DOMAINS) } }) + '\n');
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  // 已开页签也补挂（setAutoAttach 只对新目标；既有目标逐个 attach）
  const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page');
  for (const t of tabs) { try { await send('Target.attachToTarget', { targetId: t.id, flatten: true }); } catch (_) {} }
  console.error(`[netcap] 监听中 port=${PORT} tag=${TAG} 已有页签${tabs.length}个 → ${FILE}（${DURATION / 1000}s，Ctrl+C 提前收尾）`);

  const flushed = new Set();
  async function flushBatch() {
    let n = 0;
    for (const key of order) {
      if (done || n >= 25) break;
      const e = entries.get(key);
      if (!e || flushed.has(key) || e._failed) continue;
      if (!e._finished) continue;
      // 响应体（getResponseBody；binary/流式失败不拦采集——标 respBodyErr 交 depose 判）
      if (e.respBody === undefined && e.respStatus !== undefined) {
        try {
          const rb = await send('Network.getResponseBody', { requestId: key.split(':').slice(1).join(':') }, key.split(':')[0] || undefined);
          e.respBody = rb && rb.base64Encoded ? '[binary]' : ((rb && rb.body) || '').slice(0, BODY_CAP);
        } catch (err) { e.respBodyErr = String(err.message || err).slice(0, 60); }
      }
      if (e.respBody !== undefined || e.respBodyErr) { flushed.add(key); fs.appendFileSync(FILE, JSON.stringify(e) + '\n'); n++; }
    }
    return n;
  }
  const flushTimer = setInterval(() => { flushBatch().then(n => { if (n) console.error(`[netcap] 已落 ${flushed.size}/${order.length}`); }).catch(() => {}); }, 2000);

  let stopped = false;
  async function stop(sig) {
    if (stopped) return; stopped = true;
    done = true; clearInterval(flushTimer);
    try { for (let i = 0; i < 3; i++) { const n = await flushBatch(); if (!n) break; } } catch (_) {}
    fs.appendFileSync(FILE, JSON.stringify({ _done: { at: new Date().toISOString(), signal: sig || 'duration', captured: order.length, flushed: flushed.size } }) + '\n');
    console.error(`[netcap] 收尾：采集 ${order.length} 条，落盘 ${flushed.size} 条 → ${FILE}`);
    try { ws.close(); } catch (_) {}
    process.exit(0);
  }
  process.on('SIGINT', () => stop('sigint'));
  process.on('SIGTERM', () => stop('sigterm'));
  setTimeout(() => stop('duration'), DURATION);
})().catch(e => { console.error('FATAL:', String(e.message || e).slice(0, 300)); process.exit(1); });
