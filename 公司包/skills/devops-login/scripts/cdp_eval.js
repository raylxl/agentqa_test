// cdp_eval.js — 按页签标题关键词连 9333 CDP，执行 JS 表达式并打印结果
// 用法: node cdp_eval.js <标题关键词> <表达式文件路径> [端口，缺省9333]
const fs = require("fs");
const [,, key, exprFile, portArg] = process.argv;
const PORT = (portArg && portArg.startsWith("--") ? portArg.slice(2) : portArg) || "9333";
if (!key || !exprFile) { console.error("用法: node cdp_eval.js <标题关键词> <exprFile>"); process.exit(1); }
const expr = fs.readFileSync(exprFile, "utf8");
(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const tab = list.find(t => t.type === "page" && (t.title || "").includes(key));
  if (!tab) { console.error("未找到页签:", key, "| 现有:", list.filter(t=>t.type==='page').map(t=>t.title).join(" / ")); process.exit(1); }
  console.error("目标页签:", tab.title, "|", tab.url);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === 1) {
      if (m.result?.exceptionDetails) console.error("页面异常:", JSON.stringify(m.result.exceptionDetails).slice(0, 400));
      console.log(m.result?.result?.value ?? "(无返回值)");
      ws.close(); process.exit(0);
    }
  };
  ws.onerror = () => { console.error("WS 连接失败:", tab.webSocketDebuggerUrl); process.exit(1); };
  setTimeout(() => { console.error("超时(30s)"); process.exit(1); }, 30000);
})();
