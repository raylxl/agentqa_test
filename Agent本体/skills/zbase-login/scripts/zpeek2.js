// zpeek2.js — 连 9338 页签，Target.setAutoAttach(flatten) 进 OOPIF iframe 的独立 session 执行表达式
// 用法: node zpeek2.js <标题关键词> <域名过滤> <expr文件>
const fs = require("fs");
const [, , key, domain, exprFile] = process.argv;
const EXPR = fs.readFileSync(exprFile, "utf8").trim();
const pending = new Map(); const ctxs = []; let idc = 1; let ws;
function send(method, params, sessionId, contextId) {
  return new Promise((res, rej) => {
    const id = idc++; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params: { ...params, ...(contextId ? { contextId } : {}) }, ...(sessionId ? { sessionId } : {}) }));
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const list = await (await fetch("http://127.0.0.1:9338/json/list")).json();
  const tab = list.find(t => t.type === "page" && (t.title || "").includes(key));
  if (!tab) { console.error("未找到页签"); process.exit(1); }
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.addEventListener("message", evd => {
    const m = JSON.parse(evd.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error || m.result?.exceptionDetails ? p.rej(new Error(JSON.stringify(m.error || m.result.exceptionDetails).slice(0, 200))) : p.res(m.result?.result?.value); }
    else if (m.method === "Target.attachedToTarget") {
      const ti = m.params.targetInfo, sid = m.params.sessionId;
      ctxs.push({ sid, origin: ti.url, ctxId: null, type: ti.type });
      send("Runtime.enable", {}, sid).catch(() => { });
    }
    else if (m.method === "Runtime.executionContextCreated") {
      const c = m.params.context;
      if (!c.auxData || !c.auxData.isDefault) return;
      const sid = m.sessionId || null;
      let hit = ctxs.find(x => (x.sid || null) === sid && !x.ctxId);
      if (hit) { hit.ctxId = c.id; if (!hit.origin || hit.type === 'iframe') hit.origin = c.origin || hit.origin; }
      else ctxs.push({ sid, origin: c.origin || 'main', ctxId: c.id, type: 'page' });
    }
  });
  await send("Runtime.enable", {});
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await sleep(1500);
  console.log("targets: " + ctxs.map(x => `[${x.type}] ${String(x.origin).slice(0, 60)} sid=${String(x.sid).slice(0, 8)} ctx=${x.ctxId}`).join(" ; "));
  for (const x of ctxs) {
    if (domain && !String(x.origin).includes(domain)) continue;
    if (!x.ctxId) continue;
    try { const r = await send("Runtime.evaluate", { expression: EXPR, returnByValue: true, awaitPromise: true }, x.sid, x.ctxId); console.log(`---- ${String(x.origin).slice(0, 60)}\n` + (typeof r === "string" ? r : JSON.stringify(r))); }
    catch (e) { console.log(`失败 ${String(x.origin).slice(0, 40)}: ${e.message.slice(0, 120)}`); }
  }
  ws.close(); process.exit(0);
})().catch(e => { console.error("fatal:", e.message); process.exit(1); });
