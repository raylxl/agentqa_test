// zbase_login.js — ZBASE（一体化运管平台）登录：Chrome 9338 实例
// 流程：找/开 ZBASE 页签 → 判登录态 → OAuth 授权页一键登录卡 CDP 真实点击 → 等宝盒确认回跳
// 用法: node zbase_login.js
// RESULT: already-logged-in | login-success | need-user-scan | login-timeout | open-failed
// 红线：打出 NOTIFY 后必须立即提醒用户在「电脑宝盒/手机宝盒」确认（一键登录非全自动，用户 2026-11-17 拍板）
const PORT = process.env.ZBASE_PORT || '9338';
const ZBASE_URL = 'https://zbase.dev.ztoeco.com/#/user/product/view?productCode=prddefhov';

function ev(ws, id, expression) {
  return new Promise((res, rej) => {
    const onMsg = (evd) => {
      const m = JSON.parse(evd.data);
      if (m.id === id) { ws.removeEventListener("message", onMsg); m.result?.exceptionDetails ? rej(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 300))) : res(m.result?.result?.value); }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
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
const listTabs = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
const openWs = tab => new Promise((r, j) => { const ws = new WebSocket(tab.webSocketDebuggerUrl); ws.onopen = () => r(ws); ws.onerror = j; });

async function openZbaseTab() {
  // 两步法（/json/new 经常只建 about:blank 不导航，属正常）：①建空白页签 ②对它发 location 导航
  try { await fetch(`http://127.0.0.1:${PORT}/json/new`, { method: 'PUT' }); } catch { }
  const tabs = await listTabs();
  const blank = tabs.find(t => t.type === 'page' && (t.url === 'about:blank' || t.url === ''));
  if (!blank) return null;
  const ws = await openWs(blank);
  await ev(ws, 1, `location.href=${JSON.stringify(ZBASE_URL)}; "navigating"`);
  ws.close();
  await sleep(6000); // 等 SSO 重定向落定
  return true;
}

(async () => {
  // ① 找 ZBASE 页签，没有就开
  let tab = (await listTabs()).find(t => t.type === 'page' && (t.url || '').includes('zbase.dev.ztoeco.com'));
  if (!tab) {
    if (!(await openZbaseTab())) { console.log('RESULT: open-failed'); process.exit(1); }
    tab = (await listTabs()).find(t => t.type === 'page' && ((t.url || '').includes('zbase.dev.ztoeco.com') || (t.url || '').includes('connect.zto.com')));
  }
  if (!tab) { console.log('RESULT: open-failed（页签未建起）'); process.exit(1); }

  const ws = await openWs(tab);
  let idc = 10;
  const state = () => ev(ws, idc++, 'JSON.stringify({url:location.href,title:document.title})').then(JSON.parse);

  // ② 已登录直达（ssoRedirect 中间态等它落定，最多 ~10s）
  let s;
  for (let i = 0; i < 6; i++) {
    s = await state();
    if (s.url.includes('zbase.dev.ztoeco.com') && !s.url.includes('ssoRedirect')) { console.log('RESULT: already-logged-in'); ws.close(); process.exit(0); }
    if (s.url.includes('connect.zto.com')) break;
    await sleep(2000);
  }

  // ③ OAuth 授权页：等一键登录卡渲染（最多 ~10s）
  const probeCard = () => ev(ws, idc++, `(()=>{const e=[...document.querySelectorAll('*')].filter(x=>x.offsetParent&&x.children.length===0&&(x.innerText||'').trim()==='一键登录')[0];if(!e)return JSON.stringify({card:false,scan:/扫一扫/.test(document.body.innerText)});const r=e.getBoundingClientRect();return JSON.stringify({card:true,x:r.x+r.width/2,y:r.y+r.height/2});})()`).then(JSON.parse);
  let card = null;
  for (let i = 0; i < 5; i++) { card = await probeCard(); if (card.card) break; await sleep(2000); }
  if (!card.card) {
    console.log('RESULT: need-user-scan（纯扫码态，无一键登录卡——请用户开电脑宝盒后重跑，或用「中通宝盒」App 扫码）');
    ws.close(); process.exit(2);
  }

  // ④ 真实点击一键登录（合成 click 无效，必须 Input 派发最内层元素中心）
  await mouse(ws, idc++, card.x, card.y, 'mousePressed');
  await sleep(70);
  await mouse(ws, idc++, card.x, card.y, 'mouseReleased');
  console.log('NOTIFY: 已点击「一键登录」——请用户在电脑宝盒/手机宝盒确认（回跳要 15s+，别急着重试）');

  // ⑤ 轮询等宝盒确认后回跳（最多 45s；导航中 evaluate 失败属正常，continue）
  for (let i = 0; i < 15; i++) {
    await sleep(3000);
    try { s = await state(); } catch { continue; }
    if (s.url.includes('zbase.dev.ztoeco.com') && !s.url.includes('ssoRedirect') && !s.url.includes('connect.zto.com')) {
      console.log('RESULT: login-success |', s.title);
      ws.close(); process.exit(0);
    }
  }
  console.log('RESULT: login-timeout（宝盒未确认或回跳超时——提醒用户确认后重跑本脚本）');
  ws.close(); process.exit(2);
})().catch(e => { console.error('fatal:', e.message); process.exit(1); });
