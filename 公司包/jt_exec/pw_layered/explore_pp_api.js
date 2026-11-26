// explore_pp_api.js — 在微应用 frame（phecda-web）上下文里监听（列表接口是 iframe 内 XHR）
const path = require('path');
const cdp = require(path.join(__dirname, 'cdp_pool.js'));
const { ensureLogin } = require(path.join(__dirname, 'pw_login.js'));
const { ensureTenant, findJtPage } = require(path.join(__dirname, 'pw_tenant.js'));
(async () => {
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335, 9336, 9337], purpose: '平台价格api', verbose: true });
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${c.port}`);
  let page = null;
  try {
    await ensureLogin(c.port);
    await ensureTenant(browser, '智冷仓链', () => {});
    page = await findJtPage(browser) || (await browser.contexts()[0].newPage());
    // CDP 级网络监听（Playwright page.on('response') 对 iframe 也生效，但需在 frame 加载前挂）——先挂再导航
    const biz = [];
    page.on('response', async (res) => {
      try {
        const url = res.url();
        if (!/gateway-ll/.test(url)) return;
        if (/uas\/|merak\/|echo\/|smartOffice/.test(url)) return;
        const reqBody = (res.request().postData() || '').slice(0, 600);
        const body = (await res.text().catch(() => '')).slice(0, 600);
        biz.push({ url: url.replace('http://gateway-ll.test.ztoeco.com', 'GW'), method: res.request().method(), status: res.status(), req: reqBody, res: body });
      } catch (e) {}
    });
    await page.goto('http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice', { timeout: 30000, waitUntil: 'domcontentloaded' });
    // 等微应用 frame 出现且表格渲染
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(2000);
      const ok = await page.evaluate(() => {
        const f = document.querySelector('iframe[name="phecda-web"]');
        if (!f) return false;
        try { return f.contentDocument.querySelectorAll('.el-table__header-wrapper th').length > 3; } catch (e) { return false; }
      }).catch(() => false);
      if (ok) { console.log('[ready] iframe table rendered at iter', i); break; }
    }
    // 在 frame 内点查询（phecda-web frame locator）
    const frame = page.frames().find(f => f.name() === 'phecda-web');
    if (frame) {
      await frame.locator('button:has-text("查询")').first().click({ timeout: 10000 }).catch(e => console.log('[click-fail]', e.message.slice(0, 80)));
      await page.waitForTimeout(6000);
    }
    console.log('[biz](' + biz.length + ')');
    for (const b of biz) console.log(JSON.stringify(b));
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
    try { cdp.removeLock(c.port); } catch (_) {}
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
