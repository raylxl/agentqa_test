// pp_probe_tasks.js — 查最近导出任务
const { chromium } = require('playwright');
(async () => {
  const http = require('http');
  const probe = (port) => new Promise(res => { const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 2000 }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(true)); }); req.on('error', () => res(false)); req.on('timeout', () => { req.destroy(); res(false); }); });
  let port = null;
  for (const p of [9335, 9336, 9337]) if (await probe(p)) { port = p; break; }
  if (!port) { console.log('no instance'); process.exit(0); }
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 8000 });
  const page = browser.contexts()[0].pages().find(p => p.url().includes('jt-ll'));
  if (!page) { console.log('no jt page'); process.exit(0); }
  const j = await page.evaluate(async () => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const r = await fetch('http://gateway-ll.test.ztoeco.com/custom/excelTask/queryPage', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify({ condition: { fileName: null, status: null }, pageNum: 1, pageSize: 3 }) });
    return await r.json();
  });
  for (const t of ((j.result && j.result.items) || [])) console.log(String(t.gmtCreate).slice(11, 19), 'status=' + t.status, String(t.fileName).slice(0, 42), 'num=' + t.dataNum);
  await browser.close();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
