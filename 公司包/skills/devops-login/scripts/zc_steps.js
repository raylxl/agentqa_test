// zc_steps.js — 按页签标题连 CDP：对 loc 定位元素派发真实鼠标点击 / 执行 eval
// 用法: node zc_steps.js <标题关键词> <steps.json>
// steps: [{loc:"<expr→[x,y]>", click:true, wait:ms} | {eval:"<expr>", out:true, wait:ms}]
const fs = require("fs");
const [, , key, stepsFile] = process.argv;
const steps = JSON.parse(fs.readFileSync(stepsFile, "utf8"));
function ev(ws, id, params) {
  return new Promise((res, rej) => {
    const onMsg = (evd) => {
      const m = JSON.parse(evd.data);
      if (m.id === id) { ws.removeEventListener("message", onMsg); m.result?.exceptionDetails ? rej(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 300))) : res(m.result?.result?.value); }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: params.expression, returnByValue: true, awaitPromise: true } }));
  });
}
function mouse(ws, id, x, y, type) {
  return new Promise((res, rej) => {
    const onMsg = (evd) => { const m = JSON.parse(evd.data); if (m.id === id) { ws.removeEventListener("message", onMsg); m.error ? rej(new Error(JSON.stringify(m.error))) : res(); } };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Input.dispatchMouseEvent", params: { type, x, y, button: "left", clickCount: 1 } }));
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
  const tab = list.find(t => t.type === "page" && (t.title || "").includes(key));
  if (!tab) { console.error("未找到页签"); process.exit(1); }
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const outs = [];
  let idc = 10;
  try {
    for (const st of steps) {
      if (st.wait) await sleep(st.wait);
      if (st.loc) {
        const co = await ev(ws, idc++, { expression: st.loc });
        if (!Array.isArray(co) || typeof co[0] !== "number") { outs.push({ locErr: String(JSON.stringify(co)).slice(0, 200), loc: st.loc.slice(0, 80) }); continue; }
        await mouse(ws, idc++, co[0], co[1], "mousePressed");
        await sleep(70);
        await mouse(ws, idc++, co[0], co[1], "mouseReleased");
      }
      if (st.eval) {
        const v = await ev(ws, idc++, { expression: st.eval });
        if (st.out) outs.push(v);
      }
      if (st.waitAfter) await sleep(st.waitAfter);
    }
  } catch (e) { outs.push({ stepErr: String(e.message || e).slice(0, 400) }); }
  console.log(JSON.stringify(outs, null, 1));
  ws.close(); process.exit(0);
})().catch(e => { console.error("fatal:", e.message); process.exit(1); });
