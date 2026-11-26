// explore_pp_menu.js — 从菜单树提取「平台价格」节点（复用已登录实例）
const path = require('path');
const cdp = require(path.join(__dirname, 'cdp_pool.js'));
(async () => {
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335, 9336, 9337], purpose: '平台价格菜单提取', verbose: true });
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${c.port}`);
  let page = null;
  try {
    page = (await require(path.join(__dirname, 'pw_tenant.js')).findJtPage(browser)) || (await browser.contexts()[0].newPage());
    if (!/jt-ll\.test\.ztoeco\.com/.test(page.url())) {
      await page.goto('http://jt-ll.test.ztoeco.com/app/', { timeout: 30000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);
    } else if (!page.url().includes('/app/')) {
      await page.goto('http://jt-ll.test.ztoeco.com/app/', { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(3000);
    }
    const nodes = await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('MICRO_APP_MAIN_MENU_LIST') || '[]');
      const out = [];
      const walk = (arr, trail) => {
        for (const n of (arr || [])) {
          const name = n.menuName || n.categoryName || '';
          const t = trail.concat(name);
          if (/平台价格/.test(name)) {
            out.push({ trail: t.join(' > '), id: n.id, uri: n.uri, type: n.type, hasPermission: n.hasPermission, isDisplay: n.isDisplay, filePath: n.filePath, sortOrder: n.sortOrder, raw: JSON.stringify(n).slice(0, 300) });
          }
          walk(n.chilePlatformMenuList || n.childPlatformCategoryList || [], t);
        }
      };
      walk(raw, []);
      return out;
    });
    console.log(JSON.stringify(nodes, null, 1));
    // 同时找路由表里的对应微应用页
    const routes = await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('MICRO_APP_MAIN_MICRO_ROUTES') || '[]');
      const out = [];
      const walk = (arr) => { for (const r of (arr || [])) { if (/平台价格/.test(r.title || '')) out.push({ title: r.title, path: r.path, realPath: r.realPath, microPageName: r.microPageName, microEntry: r.microEntry, hasPermission: r.hasPermission }); walk(r.children || r.routes || []); } };
      walk(raw);
      return out;
    });
    console.log('[routes]', JSON.stringify(routes, null, 1));
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
    try { cdp.removeLock(c.port); } catch (_) {}
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
