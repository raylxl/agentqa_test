// 一次性验证：真实键盘通道（insertText+Enter，带 sessionId 进 OOPIF）能否让查询条件生效
const pending = new Map(); const targets = []; let idc = 1; let ws;
function send(method, params, sessionId, contextId) {
  return new Promise((res, rej) => { const id = idc++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params: { ...params, ...(contextId ? { contextId } : {}) }, ...(sessionId ? { sessionId } : {}) })); });
}
const ev = (sid, ctx, expression) => send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sid, ctx).then(r => r?.result?.value);
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const list = await (await fetch("http://127.0.0.1:9338/json/list")).json();
  const tab = list.find(t => t.type === "page" && (t.title || "").includes("一体化"));
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.addEventListener("message", evd => {
    const m = JSON.parse(evd.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error || m.result?.exceptionDetails ? p.rej(new Error(JSON.stringify(m.error || m.result.exceptionDetails).slice(0, 200))) : p.res(m.result); }
    else if (m.method === "Target.attachedToTarget") { targets.push({ sid: m.params.sessionId, url: m.params.targetInfo.url, ctxId: null }); send("Runtime.enable", {}, m.params.sessionId).catch(() => { }); }
    else if (m.method === "Runtime.executionContextCreated") { const c = m.params.context; if (!c.auxData || !c.auxData.isDefault) return; const sid = m.sessionId || null; const hit = targets.find(x => (x.sid || null) === sid && !x.ctxId); if (hit) hit.ctxId = c.id; else targets.push({ sid, url: c.origin, ctxId: c.id }); }
  });
  await send("Runtime.enable", {});
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await sleep(2000);
  const z = targets.find(x => String(x.url).includes("zbase-zlog") && x.ctxId);
  // ① 真实鼠标点击搜索框聚焦（iframe 视口内坐标，带 sessionId 进 OOPIF 进程）
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 501, y: 40, button: "left", clickCount: 1 }, z.sid);
  await sleep(70);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 501, y: 40, button: "left", clickCount: 1 }, z.sid);
  await sleep(500);
  console.log("focus:", await ev(z.sid, z.ctx, "(()=>{const a=document.activeElement;return a?a.tagName+':'+(a.placeholder||''):'NONE'})()"));
  // ② 真实键盘输入（insertText 到焦点元素，走 OOPIF session）
  await send("Input.insertText", { text: "zlog_probe_zzz_notexist123" }, z.sid);
  await sleep(800);
  console.log("value:", await ev(z.sid, z.ctx, "document.activeElement&&document.activeElement.value"));
  // ③ 真实 Enter
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, z.sid);
  await sleep(40);
  await send("Input.dispatchKeyEvent", { type: "char", text: "\r", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, z.sid);
  await sleep(40);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, z.sid);
  await sleep(6000);
  // ④ 抓结果：不存在词 total=0 才证明查询条件生效
  console.log("result:", await ev(z.sid, z.ctx, "JSON.stringify({kw:(()=>{const i=[...document.querySelectorAll('input')].find(e=>e.offsetParent&&e.placeholder==='搜索...');return i?i.value:'?'})(),head:document.body.innerText.slice(0,180)})()"));
  ws.close(); process.exit(0);
})().catch(e => { console.error("fatal:", e.message); process.exit(1); });
