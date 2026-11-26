// pp_probe_91283.js — 查 PTF091283 占位条键构成
const { chromium } = require('playwright');
(async () => {
  const http = require('http');
  const probe = (port) => new Promise(res => { const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 2000 }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(true)); }); req.on('error', () => res(false)); req.on('timeout', () => { req.destroy(); res(false); }); });
  let port = null;
  for (const p of [9335, 9336, 9337]) if (await probe(p)) { port = p; break; }
  if (!port) { console.log('no instance'); process.exit(0); }
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 8000 });
  const page = browser.contexts()[0].pages().find(p => p.url().includes('jt-ll'));
  if (!page) { console.log('no page'); process.exit(0); }
  const r2 = await page.evaluate(async () => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const resp = await fetch('http://gateway-ll.test.ztoeco.com/phecda/api/cwbms/quotePlatformFee/getPageList', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify({ page: 1, pageSize: 3, quoteCode: 'PTF091283' }) });
    const j = await resp.json();
    return (j.data.items || []).map(i => ({ n: i.quoteName, cost: i.costCode || i.costName, flow: i.settFlow, sa: i.specialAttributes, s: i.effectStartTime || i.startDate, e: i.effectEndTime || i.endDate }));
  });
  console.log('PTF091283:', JSON.stringify(r2));
  await browser.close();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
