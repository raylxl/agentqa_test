const fs=require("fs");const [,,port,key,exprFile,tm]=process.argv;
const expr=fs.readFileSync(exprFile,"utf8");const T=parseInt(tm||"120000");
(async()=>{const list=await(await fetch("http://127.0.0.1:"+port+"/json/list")).json();
 const tab=list.find(t=>t.type==="page"&&(t.title||"").includes(key));
 if(!tab){console.error("未找到页签:"+key);process.exit(1);}
 const ws=new WebSocket(tab.webSocketDebuggerUrl);let n=0;
 ws.onopen=()=>{ws.send(JSON.stringify({id:1,method:"Page.bringToFront"}));
  ws.send(JSON.stringify({id:9,method:"Emulation.setFocusEmulationEnabled",params:{enabled:true}}));
  ws.send(JSON.stringify({id:10,method:"Page.setWebLifecycleState",params:{state:"active"}}));};
 ws.onmessage=ev=>{const m=JSON.parse(ev.data);
   if(m.id===1){ws.send(JSON.stringify({id:2,method:"Runtime.evaluate",params:{expression:expr,returnByValue:true,awaitPromise:true}}));}
   if(m.id===2){if(m.result&&m.result.exceptionDetails)console.error("页面异常:",JSON.stringify(m.result.exceptionDetails).slice(0,300));console.log((m.result&&m.result.result&&m.result.result.value)??"(无返回值)");ws.close();process.exit(0);}};
 setTimeout(()=>{console.error("超时");process.exit(1)},T);})();
