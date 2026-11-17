// zlog_query.js — ZBASE 日志一条命令查询（Chrome 9338，须已登录=zbase-login 前置）
// 用法: node zlog_query.js <应用名> <关键字> [天数，默认1] [环境，默认fatlengliannew测试]
// 流程：主文档 hash 导航到日志页（iframe 重建）→ OOPIF session 进 zlog → 设时间(默认1天)→填词→点搜索→抓结果
// 输出 JSON: {app, kw, days, timeBar, total, sample}
const fs = require("fs");
const path = require("path");
const [, , appArg, kwArg, daysArg, envArg] = process.argv;
if (!appArg || !kwArg) { console.error("用法: node zlog_query.js <应用名> <关键字> [天数=1] [环境=fatlengliannew]；应用名查 app_map.json"); process.exit(1); }
const DAYS = String(daysArg || "1");
const ENV = envArg || "fatlengliannew";
const PORT = process.env.ZBASE_PORT || "9338";
const LOG_URL = `#/user/application/log?appId=${appArg}&env=${ENV}&productCode=prddefhov`;

const pending = new Map(); const targets = []; let idc = 1; let ws;
function send(method, params, sessionId, contextId) {
  return new Promise((res, rej) => {
    const id = idc++; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params: { ...params, ...(contextId ? { contextId } : {}) }, ...(sessionId ? { sessionId } : {}) }));
  });
}
const ev = (sid, ctx, expression) => send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sid, ctx).then(r => r?.result?.value);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// zlog iframe 内执行：设时间(N天)→填词→点搜索→等待→取结果（全 DOM 操作，内嵌态合成事件有效）
const QUERY_EXPR = `
(async()=>{
  const set=(el,v)=>{Object.getOwnPropertyDescriptor(el.tagName==='SELECT'?window.HTMLSelectElement.prototype:window.HTMLInputElement.prototype,'value').set.call(el,v)};
  // ① 时间范围：点开时间按钮→Relative 数字=天数→单位 Days ago→再点关面板（面板开着点搜索会被吞）
  let timeBar='';
  try{
    const tb=[...document.querySelectorAll('button')].find(b=>b.offsetParent&&/^Last/.test((b.innerText||'').trim()));
    if(tb){tb.click();await new Promise(r=>setTimeout(r,800));
      const num=document.querySelector('input[type=number]');
      if(num){set(num,'${DAYS}');num.dispatchEvent(new Event('input',{bubbles:true}));}
      const sel=[...document.querySelectorAll('select')].find(s=>s.offsetParent&&/^m$|^d$|^h$/.test(s.value));
      if(sel){const o=[...sel.options].find(o=>/Days ago/i.test(o.text));if(o){set(sel,o.value);sel.dispatchEvent(new Event('change',{bubbles:true}));}}
      await new Promise(r=>setTimeout(r,500));tb.click();await new Promise(r=>setTimeout(r,400));
    }
    const tb2=[...document.querySelectorAll('*')].find(e=>e.offsetParent&&e.children.length===0&&/^(Last|~)/.test((e.innerText||'').trim()));
    timeBar=tb2?(tb2.innerText||'').trim().slice(0,30):'';
  }catch(e){timeBar='ERR:'+e.message.slice(0,60)}
  // ② 填关键字（input+change 双事件——change 才把词写进查询模型，2026-11-17 监听用户操作实证；缺 change=提交空条件全量假查）
  const i=[...document.querySelectorAll('input')].find(e=>e.offsetParent&&e.placeholder==='搜索...');
  if(!i)return JSON.stringify({err:'NO_SEARCH_INPUT'});
  set(i,${JSON.stringify(kwArg)});i.dispatchEvent(new Event('input',{bubbles:true}));
  i.dispatchEvent(new Event('change',{bubbles:true}));
  await new Promise(r=>setTimeout(r,400));
  // ③ 点搜索
  const btn=[...document.querySelectorAll('button')].find(b=>b.offsetParent&&(b.innerText||'').trim()==='搜索');
  if(!btn)return JSON.stringify({err:'NO_SEARCH_BTN'});
  btn.click();
  await new Promise(r=>setTimeout(r,8000));
  // ④ 取结果
  const txt=document.body.innerText;
  let total='0';const k=txt.indexOf('共计');
  if(k>=0){let s='';for(let j=k+2;j<k+30;j++){const c=txt[j];if(/[0-9,]/.test(c))s+=c;else break}if(s)total=s.replace(/,$/,'')}
  return JSON.stringify({timeBar,total,sample:txt.slice(0,${Number(process.env.ZLOG_SAMPLE || 4000)})});
})()`;

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const tab = list.find(t => t.type === "page" && (t.title || "").includes("一体化"));
  if (!tab) { console.error(JSON.stringify({ err: "NO_TAB: 9338 无一体化页签，先跑 zbase-login" })); process.exit(2); }
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.addEventListener("message", evd => {
    const m = JSON.parse(evd.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error || m.result?.exceptionDetails ? p.rej(new Error(JSON.stringify(m.error || m.result.exceptionDetails).slice(0, 300))) : p.res(m.result); }
    else if (m.method === "Target.attachedToTarget") { targets.push({ sid: m.params.sessionId, url: m.params.targetInfo.url, ctxId: null }); send("Runtime.enable", {}, m.params.sessionId).catch(() => { }); }
    else if (m.method === "Runtime.executionContextCreated") {
      const c = m.params.context; if (!c.auxData || !c.auxData.isDefault) return;
      const sid = m.sessionId || null;
      const hit = targets.find(x => (x.sid || null) === sid && !x.ctxId);
      if (hit) { hit.ctxId = c.id; if (!hit.url || hit.url === 'about:blank') hit.url = c.origin; }
      else targets.push({ sid, url: c.origin, ctxId: c.id });
    }
  });
  await send("Runtime.enable", {});
  // ① 主文档导航到目标日志页（hash 变化触发 iframe 重建）
  const cur = await ev(null, null, "location.hash");
  if (String(cur) !== LOG_URL) {
    await ev(null, null, `location.hash='${LOG_URL}'; 'nav'`);
    await sleep(6000);
  } else { await sleep(1500); }
  // ② attach OOPIF 找 zlog iframe
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await sleep(2000);
  const zlog = targets.find(x => String(x.url).includes("zbase-zlog") && x.ctxId);
  if (!zlog) { console.error(JSON.stringify({ err: "NO_ZLOG_IFRAME", targets: targets.map(t => String(t.url).slice(0, 60)) })); process.exit(3); }
  // ③ 查询
  const raw = await ev(zlog.sid, zlog.ctxId, QUERY_EXPR);
  let r; try { r = JSON.parse(raw); } catch { r = { err: "PARSE_FAIL", raw: String(raw).slice(0, 300) }; }
  console.log(JSON.stringify({ app: appArg, kw: kwArg, days: DAYS, env: ENV, ...r }, null, 1));
  ws.close(); process.exit(0);
})().catch(e => { console.error(JSON.stringify({ err: "fatal", msg: e.message.slice(0, 300) })); process.exit(1); });
