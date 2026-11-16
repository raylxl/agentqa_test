/**
 * 鲸天全租户遍历（Chrome 9333 · API 切换法）
 *
 * 流程：
 *   1. queryOwnershipTenant 拿全量租户
 *   2. 逐个：changeTenant → 新 token 写回 + 清缓存 → reload /dashboard
 *      → 抓取：选中租户、页头租户页签、侧边菜单（DOM 2 级 + localStorage 菜单树）、截图
 *   3. 结束切回冷链快运（tenantId=1）
 * 输出：tenant_tour_report.json + tenant_tour_<id>_<name>.png
 * 容错：单租户 API 失败记录后继续；页面跳 SSO（登录态断）则中止并报告。
 */
const path = require('path');
const fs = require('fs');
let chromium;
for (const p of ['playwright', path.join('d:', 'WorkBuddy-projects', 'testcase', 'node_modules', 'playwright')]) {
  try { chromium = require(p).chromium; if (chromium) break; } catch (_) {}
}
if (!chromium) { console.error('找不到 playwright 库'); process.exit(1); }

const OUT_DIR = __dirname;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const GW = 'http://gateway-ll.test.ztoeco.com';

async function findJtPage(browser) {
  return browser.contexts()[0].pages().find(p => {
    try { return p.url().includes('jt-ll.test.ztoeco.com'); } catch (_) { return false; }
  });
}

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  let page = await findJtPage(browser);
  if (!page) { console.error('未找到 jt-ll 页签，先跑登录脚本'); process.exit(2); }

  // 1) 全量租户
  const tenants = await page.evaluate(async (gw) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const resp = await fetch(gw + '/merak/user/queryOwnershipTenant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': token, 'authtoken': token, 'PlatformCode': 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' },
      body: JSON.stringify({ platformCode: 'ZTOCC_PLATFORM_001' })
    });
    const j = await resp.json();
    return j.data || [];
  }, GW).catch(e => { console.error('租户列表获取失败', e.message); process.exit(2); });
  console.log('[tenants]', tenants.length, tenants.map(t => `${t.tenantId}:${t.tenantName}`).join(' '));

  const results = [];
  const switchTo = async (t) => {
    const rec = { tenantId: t.tenantId, tenantCode: t.tenantCode, tenantName: t.tenantName, tenantType: t.tenantType, domain: t.domain, simpleName: t.simpleName };
    // 切换
    const api = await page.evaluate(async ({ gw, tenantId }) => {
      const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
      const resp = await fetch(gw + '/uas/auth/changeTenant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': token, 'authtoken': token, 'PlatformCode': 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' },
        body: JSON.stringify({ platformCode: 'ZTOCC_PLATFORM_001', tenantId })
      });
      const j = await resp.json().catch(() => ({}));
      return { code: j.code, msg: j.msg || j.message || '', token: j.data && j.data.token };
    }, { gw: GW, tenantId: t.tenantId }).catch(e => ({ err: e.message }));
    rec.apiCode = api.code !== undefined ? String(api.code) : 'ERR:' + api.err;
    if (String(api.code) !== '200' || !api.token) { rec.switchOk = false; rec.apiMsg = api.msg || api.err || ''; return rec; }
    rec.switchOk = true;
    // 写回 + 清缓存 + 跳 dashboard
    await page.evaluate((token) => {
      localStorage.setItem('MICRO_APP_MAIN_TOKEN_KEY', token);
      localStorage.removeItem('MICRO_APP_MAIN_MENU_LIST');
      localStorage.removeItem('MICRO_APP_MAIN_MICRO_ROUTES');
      location.href = 'http://jt-ll.test.ztoeco.com/dashboard';
    }, api.token);
    // 等渲染（菜单缓存重新拉取）
    await sleep(9000);
    page = await findJtPage(browser) || page; // navigation 可能换了页签对象
    const url = page.url();
    rec.url = url;
    if (/sso\.test\.ztoeco\.com/.test(url)) { rec.switchOk = false; rec.note = '跳到SSO，登录态断'; return rec; }
    // 抓状态
    const state = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.tenant-item'));
      const selected = items.find(e => e.querySelector('.selected-icon'));
      const active = document.querySelector('.tenant-item.active');
      const side = Array.from(document.querySelectorAll('.el-menu .el-sub-menu__title, .el-menu > .el-menu-item')).map(e => (e.innerText || '').trim().replace(/\s+/g, ' ')).filter(Boolean);
      // 二级菜单（已展开的）
      const subs = Array.from(document.querySelectorAll('.el-menu .el-menu-item')).map(e => (e.innerText || '').trim().replace(/\s+/g, ' ')).filter(Boolean);
      let menuTree = null;
      try {
        const raw = localStorage.getItem('MICRO_APP_MAIN_MENU_LIST');
        if (raw) {
          const arr = JSON.parse(raw);
          const walk = (nodes) => (Array.isArray(arr) ? nodes : []).map(n => ({ name: n.name || n.menuName || n.title, children: (n.children || n.childs || []).length }));
          menuTree = Array.isArray(arr) ? walk(arr) : Object.keys(arr);
        }
      } catch (_) {}
      return {
        selectedTenant: selected ? (selected.innerText || '').trim() : null,
        activeTenant: active ? (active.innerText || '').trim() : null,
        headerTabs: items.slice(0, 4).map(e => (e.innerText || '').trim()),
        sidebarTop: side.slice(0, 30),
        sidebarAll: subs.slice(0, 60),
        menuTreeCount: menuTree ? menuTree.length : null,
        user: (document.body.innerText || '').includes('陆潇雷')
      };
    }).catch(e => ({ err: e.message }));
    Object.assign(rec, { state });
    // localStorage 菜单树（前2级名字，压缩存储）
    const tree = await page.evaluate(() => {
      try {
        const arr = JSON.parse(localStorage.getItem('MICRO_APP_MAIN_MENU_LIST') || '[]');
        const pick = (n) => ({ n: n.name || n.menuName || n.title, c: (n.children || n.childs || []).map(pick) });
        return Array.isArray(arr) ? arr.map(pick) : [];
      } catch (_) { return null; }
    }).catch(() => null);
    rec.menuTree = tree;
    await page.screenshot({ path: path.join(OUT_DIR, `tenant_tour_${t.tenantId}.png`) }).catch(() => {});
    return rec;
  };

  for (const t of tenants) {
    console.log(`--- 切换 ${t.tenantId} ${t.tenantName} ---`);
    const rec = await switchTo(t);
    if (!rec.switchOk && /SSO/.test(rec.note || '')) { results.push(rec); break; }
    results.push(rec);
    console.log('[rec]', JSON.stringify({ ...rec, menuTree: rec.menuTree ? `${rec.menuTree.length} 顶级` : null, state: rec.state ? { selectedTenant: rec.state.selectedTenant, headerTabs: rec.state.headerTabs, sidebarTop: (rec.state.sidebarTop || []).slice(0, 8), user: rec.state.user } : null }));
  }

  // 3) 切回冷链快运
  const back = tenants.find(t => t.tenantId === 1);
  if (back) {
    console.log('--- 切回 冷链快运 ---');
    const rec = await switchTo(back);
    console.log('[final]', JSON.stringify({ ok: rec.switchOk, selected: rec.state && rec.state.selectedTenant }));
  }

  fs.writeFileSync(path.join(OUT_DIR, 'tenant_tour_report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), tenants: results }, null, 1));
  console.log('DONE, 报告: tenant_tour_report.json');
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(2); });
