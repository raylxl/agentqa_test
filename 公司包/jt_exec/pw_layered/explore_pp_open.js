// explore_pp_open.js — 打开平台价格菜单（两候选路由，逐个试）dump 页面结构+接口
const path = require('path');
const cdp = require(path.join(__dirname, 'cdp_pool.js'));
const { ensureLogin } = require(path.join(__dirname, 'pw_login.js'));
const { ensureTenant, findJtPage } = require(path.join(__dirname, 'pw_tenant.js'));

const ROUTES = [
  { name: '仓链云仓-平台价格', url: 'http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice' },
  { name: '平台价格(phecda)', url: 'http://jt-ll.test.ztoeco.com/app/#/phecda/quote/platformprice' },
];

(async () => {
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335, 9336, 9337], purpose: '平台价格开菜单', verbose: true });
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${c.port}`);
  let page = null;
  try {
    const lg = await ensureLogin(c.port);
    console.log('[login]', String(lg));
    const t = await ensureTenant(browser, '智冷仓链', console.log);
    console.log('[tenant]', JSON.stringify(t));
    page = await findJtPage(browser) || (await browser.contexts()[0].newPage());

    const apiHits = [];
    page.on('response', async (res) => {
      try {
        const url = res.url();
        if (/gateway-ll|phecda|warehouse/i.test(url) && res.request().method() === 'POST' && res.status() === 200) {
          const body = await res.text().catch(() => '');
          if (body && body.length() < 50 || true) apiHits.push({ url: url.replace('http://gateway-ll.test.ztoeco.com', ''), status: res.status(), len: body.length, sample: body.slice(0, 300) });
        }
      } catch (e) {}
    });

    for (const r of ROUTES) {
      console.log(`\n===== 试路由: ${r.name} =====`);
      await page.goto(r.url, { timeout: 30000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(8000);
      const info = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button')).map(b => (b.innerText || '').trim()).filter(Boolean).slice(0, 25);
        const tables = document.querySelectorAll('.el-table').length;
        const formItems = Array.from(document.querySelectorAll('.el-form-item, .el-col')).slice(0, 40).map(c => (c.innerText || '').split('\n')[0].slice(0, 30)).filter(Boolean);
        const labels = Array.from(document.querySelectorAll('.el-form-item__label')).map(l => (l.innerText || '').trim()).slice(0, 25);
        const empty = document.querySelector('.el-empty, [class*=empty]') ? true : false;
        const loading = document.querySelector('.el-loading-mask') ? true : false;
        return { url: location.href.slice(0, 120), title: document.title.slice(0, 50), btns, tables, labels, formItems: formItems.slice(0, 20), empty, loading, bodyLen: document.body.innerText.length, bodyHead: document.body.innerText.slice(0, 200) };
      }).catch(e => ({ err: e.message.slice(0, 100) }));
      console.log('[page]', JSON.stringify(info, null, 1).slice(0, 1800));
      const shot = path.join(__dirname, 'shots', `open_${r.name.replace(/[^\w\u4e00-\u9fff]/g, '_')}_${Date.now()}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      console.log('[shot]', shot);
      if (info && info.tables > 0) break; // 有表格=正路由
    }
    console.log('\n[api]', JSON.stringify(apiHits.slice(0, 12), null, 1).slice(0, 2000));
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
    try { cdp.removeLock(c.port); } catch (_) {}
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
