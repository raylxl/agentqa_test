// 抓 zlog iframe 的网络请求：Network.enable(OOPIF session) → 点搜索 → 收集请求/响应
const pending = new Map(); const targets = []; const reqs = []; let idc = 1; let ws;
function send(method, params, sessionId) {
  return new Promise((res, rej) => { const id = idc++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
}
const ev = (sid, ctx, expression) => send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sid).then(r => r?.result?.value);
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const list = await (await fetch("http://127.0.0.1:9338/json/list")).json();
  const tab = list.find(t => t.type === "page" && (t.title || "").includes("一体化"));
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.addEventListener("message", evd => {
    const m = JSON.parse(evd.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error).slice(0, 150))) : p.res(m.result); }
    else if (m.method === "Target.attachedToTarget") { targets.push({ sid: m.params.sessionId, url: m.params.targetInfo.url, ctxId: null }); send("Runtime.enable", {}, m.params.sessionId).catch(() => { }); }
    else if (m.method === "Runtime.executionContextCreated") { const c = m.params.context; if (!c.auxData || !c.auxData.isDefault) return; const sid = m.sessionId || null; const hit = targets.find(x => (x.sid || null) === sid && !x.ctxId); if (hit) hit.ctxId = c.id; else targets.push({ sid, url: c.origin, ctxId: c.id }); }
    else if (m.method === "Network.requestWillBeSent" && m.sessionId) { const r = m.params.request; reqs.push({ url: (r.url || "").slice(0, 160), method: r.method, post: (r.postData || "").slice(0, 300), ts: m.params.timestamp }); }
    else if (m.method === "Network.webSocketCreated" && m.sessionId) { reqs.push({ wsCreate: (m.params.url || "").slice(0, 160), ts: m.params.timestamp }); }
    else if (m.method === "Network.webSocketFrameSent" && m.sessionId) { reqs.push({ sent: (m.params.response || {}).payloadData.slice(0, 500), ts: m.params.timestamp }); }
    else if (m.method === "Network.webSocketFrameReceived" && m.sessionId) { const p = (m.params.response || {}).payloadData || ""; if (reqs.filter(r => r.recv).length < 3) reqs.push({ recv: p.slice(0, 700), ts: m.params.timestamp }); }
  });
  await send("Runtime.enable", {});
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await sleep(1500);
  for (const t of targets) { try { await send("Network.enable", {}, t.sid); console.log("Network.enable -> " + String(t.url).slice(0, 60)); } catch (e) { } }
  const z = targets.find(x => String(x.url).includes("zbase-zlog") && x.ctxId);
  await ev(z.sid, z.ctx, "(()=>{const i=[...document.querySelectorAll('input')].find(e=>e.offsetParent&&e.placeholder==='搜索...');if(i){i.value='';}const b=[...document.querySelectorAll('button')].find(b=>b.offsetParent&&(b.innerText||'').trim()==='搜索');if(b)b.click();return 'clicked'})()");
  await sleep(10000);
  console.log("requests:\n" + reqs.map(r => JSON.stringify(r)).join("\n"));
  ws.close(); process.exit(0);
})().catch(e => { console.error("fatal:", e.message); process.exit(1); });
