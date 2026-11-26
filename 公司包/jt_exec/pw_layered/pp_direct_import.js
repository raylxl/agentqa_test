// pp_direct_import.js — 直连域名 multipart 导入探针（页面上下文 XHR）
const { chromium } = require('playwright');
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9337', { timeout: 10000 });
  const page = browser.contexts()[0].pages().find(p => p.url().includes('jt-ll'));
  if (!page) throw new Error('no jt-ll page');
  const b64 = fs.readFileSync('/tmp/pp_r4b_ok.xlsx').toString('base64');
  const result = await page.evaluate(async ({ b64, name }) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const file = new File([bytes], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const fd = new FormData();
    fd.append('file', file, name);
    const resp = await fetch('http://phecda-wbasic-service.ztll-cljs.ft.ztoeco.com/upload/basic/fileImport?importType=cloudPlatformPrice', { method: 'POST', headers: { Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: fd });
    const t = await resp.text();
    return { s: resp.status, t: t.slice(0, 300) };
  }, { b64, name: 'pp_r4b_ok.xlsx' }).catch(e => ({ err: e.message.slice(0, 200) }));
  console.log('直连上传:', JSON.stringify(result));
  // 等 30s 看落库
  await sleep(30000);
  const after = await page.evaluate(async () => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const r = await fetch('http://gateway-ll.test.ztoeco.com/phecda/api/cwbms/quotePlatformFee/getPageList', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify({ page: 1, pageSize: 10, quoteName: 'PT09-IMP01' }) });
    const j = await r.json();
    return { total: j.data ? j.data.total : -1 };
  });
  console.log('落库:', JSON.stringify(after));
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
