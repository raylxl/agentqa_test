/**
 * 鲸天框架公共层（lib/jt_common）· 2026-11-09 跨菜单泛化重构
 * 收录与具体菜单无关、任何鲸天业务页都能用的能力；菜单专属配方放 modules/<菜单>.js
 *   - sleep / p2 / ts / realClick / dismissPoppers：原 helpers.js 原样迁入
 *   - resolveMenu：菜单清单解析（照抄 jt_chrome/chrome_jt_open_menu.js 步骤3）
 *   - openMenuViaNav：新版菜单导航（2026-11 改版后实测：全部菜单页签→栏目→自研树），旧名 openMenuViaDrawer 为兼容别名
 *   - waitBizRendered：业务页「查询按钮+表格」渲染判定（frame 优先按 uri 末段匹配，防串到别的页签）
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

const p2 = n => String(n).padStart(2, '0');
function ts() {
  const d = new Date();
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

const JT = 'http://jt-ll.test.ztoeco.com';

async function realClick(page, x, y) {
  await page.mouse.click(x, y);
  await sleep(800);
}

/**
 * 驱散残留下拉浮层（多选 el-select 点选后不自动关；禁 Esc，改点弹窗标题空白处）
 */
async function dismissPoppers(page) {
  const spot = await page.evaluate(() => {
    const vis = el => !!(el.offsetParent || el.getClientRects().length);
    const hasPopper = [...document.querySelectorAll('.el-select-dropdown, .el-popper')].some(vis);
    if (!hasPopper) return null;
    const dlg = [...document.querySelectorAll('.el-dialog')].filter(vis).sort((a, b) => b.querySelectorAll('input').length - a.querySelectorAll('input').length)[0];
    const h = dlg && (dlg.querySelector('.el-dialog__title') || dlg.querySelector('.el-dialog__header'));
    if (h) { const r = h.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.max(10, r.height / 2)) }; }
    return { x: 30, y: 200 };
  }).catch(() => null);
  if (spot) { await page.mouse.click(spot.x, spot.y); await sleep(500); }
}

/**
 * 菜单解析（照抄 chrome_jt_open_menu.js 步骤3）：一级栏目子树内按菜单名定位 → {name, displayName, uri, trail}
 * 菜单清单字段：categoryName / childPlatformCategoryList / chilePlatformMenuList（原文拼写 chile）/ menuName / displayName
 * 须在 jt-ll 页面上下文调用（读 localStorage.MICRO_APP_MAIN_MENU_LIST）
 */
async function resolveMenu(page, column, menu) {
  return page.evaluate(({ column, menu }) => {
    const arr = JSON.parse(localStorage.getItem('MICRO_APP_MAIN_MENU_LIST') || '[]');
    const findCol = nodes => { for (const n of nodes) { if ((n.categoryName || '') === column) return n; const r = findCol(n.childPlatformCategoryList || []); if (r) return r; } return null; };
    const col = findCol(arr);
    if (!col) return { err: 'column-not-found' };
    const hits = [];
    const walk = (node, trail) => {
      for (const m of (node.chilePlatformMenuList || [])) {
        const nm = m.menuName || m.displayName || '';
        if (nm === menu) hits.push({ name: nm, displayName: m.displayName, uri: m.uri, trail: [...trail, node.categoryName].filter(Boolean) });
      }
      for (const c of (node.childPlatformCategoryList || [])) walk(c, [...trail, node.categoryName].filter(Boolean));
    };
    walk(col, []);
    return hits[0] || { err: 'menu-not-found' };
  }, { column, menu }).catch(e => ({ err: String((e && e.message) || e).slice(0, 100) }));
}

/**
 * 菜单导航开菜单 v2（2026-11 鲸天菜单改版后实测 diag15）——不经首页搜索、按栏目树导航打开菜单的通用能力（坑库 H1c）
 * 注：首页全局搜索对深层菜单功能正常（曾因脚本候选过滤误判"搜不到"，坑库 H1d）；用例规定走搜索的仍走搜索
 * 新版结构：侧栏页签「全部菜单 | 常用菜单」（.sidebar-tabs .tab-item，默认停常用菜单——为空时侧栏无任何栏目）
 *   →「全部菜单」下栏目=.el-menu-item .menu-item-title → 点栏目出自研树 .tree-node-row/.tree-node-label（非 el-tree）→ 逐级展开点叶子
 * 旧版 10-27 抽屉流程（.el-drawer + el-tree + 抽屉搜索联想，即 chrome_jt_open_menu.js）已随改版失效
 * 返回 { ok, via, target, why }
 */
async function openMenuViaNav(page, column, menu, log = () => {}) {
  if (!page.url().includes('/dashboard')) {
    await page.goto(JT + '/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  let ready = false;
  for (let i = 0; i < 12 && !ready; i++) {
    await sleep(1500);
    ready = await page.evaluate(() => [...document.querySelectorAll('.sidebar-tabs .tab-item')].some(e => (e.textContent || '').trim() === '全部菜单')).catch(() => false);
  }
  if (!ready) return { ok: false, why: '侧栏「全部菜单」页签未出现' };
  const target = await resolveMenu(page, column, menu);
  if (target.err) return { ok: false, why: `菜单清单解析失败:${target.err}` };
  log(`菜单链 ${target.trail.join(' > ')} > ${target.name}（displayName=${target.displayName}）`);
  const exact = t => new RegExp('^\\s*' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$');
  // ① 切「全部菜单」页签
  await page.locator('.sidebar-tabs .tab-item').filter({ hasText: exact('全部菜单') }).first().click({ timeout: 5000 });
  await sleep(1000);
  // ② 点栏目
  const colEl = page.locator('.el-menu-item .menu-item-title').filter({ hasText: exact(column) }).first();
  if (!(await colEl.count())) return { ok: false, why: `「全部菜单」下未见栏目「${column}」`, target };
  await colEl.click({ timeout: 5000 });
  await sleep(1500);
  // ③ 逐级展开：下一级已可见就不点本级（防把已展开的收起）
  const label = t => page.locator('.tree-node-label:visible').filter({ hasText: exact(t) }).first();
  const chain = [...target.trail.slice(1), target.name];
  for (let k = 0; k < chain.length - 1; k++) {
    if (await label(chain[k + 1]).count()) continue;
    const g = label(chain[k]);
    if (!(await g.count())) return { ok: false, why: `栏目树未见分组「${chain[k]}」`, target };
    await g.click({ timeout: 5000 });
    await sleep(800);
  }
  const leaf = label(target.name);
  if (!(await leaf.count())) return { ok: false, why: `栏目树展开后未见菜单「${target.name}」`, target };
  await leaf.click({ timeout: 5000 });
  // ④ 校验：页签含菜单名 或 出现 URL 含 uri 末段的业务 frame
  const hint = (target.uri || '').split('/').pop();
  for (let i = 0; i < 10; i++) {
    await sleep(1500);
    const tabOk = await page.evaluate(nm => [...document.querySelectorAll('.el-tabs__item, [class*=tab]')].some(e => e.getBoundingClientRect().width > 0 && (e.textContent || '').trim() === nm), target.name).catch(() => false);
    const frameOk = !!hint && page.frames().some(f => f.url().includes(hint));
    if (tabOk || frameOk) return { ok: true, via: '全部菜单→栏目树', target, tabOk, frameOk };
  }
  return { ok: false, why: '已点叶子但页签/业务 frame 均未出现', target };
}
const openMenuViaDrawer = openMenuViaNav; // 兼容旧名（抽屉流程已随改版失效，统一走新版导航）

/**
 * 业务页渲染判定：可见「查询」按钮 + 表格。hint=菜单 uri 末段时只认 URL 含 hint 的 frame（防串到同页其他页签），再看主文档 .el-main
 */
async function waitBizRendered(page, hint, rounds = 10) {
  const IN = () => {
    const vis = el => !!(el.offsetParent || el.getClientRects().length);
    return {
      hasQuery: [...document.querySelectorAll('button')].some(b => vis(b) && /查\s*询/.test(b.textContent)),
      hasTable: !!document.querySelector('.el-table, table'),
    };
  };
  for (let i = 0; i < rounds; i++) {
    const frames = page.frames().filter(f => f !== page.mainFrame() && (!hint || f.url().includes(hint)));
    for (const f of frames) {
      try { const s = await f.evaluate(IN); if (s.hasQuery && s.hasTable) return { ok: true, where: 'frame…' + f.url().slice(-48) }; } catch (_) {}
    }
    try {
      const s = await page.evaluate(() => {
        const main = document.querySelector('.el-main');
        if (!main) return null;
        const vis = el => !!(el.offsetParent || el.getClientRects().length);
        return { hasQuery: [...main.querySelectorAll('button')].some(b => vis(b) && /查\s*询/.test(b.textContent)), hasTable: !!main.querySelector('.el-table, table') };
      });
      if (s && s.hasQuery && s.hasTable) return { ok: true, where: 'main' };
    } catch (_) {}
    await sleep(2000);
  }
  return { ok: false };
}

module.exports = { sleep, p2, ts, JT, realClick, dismissPoppers, resolveMenu, openMenuViaNav, openMenuViaDrawer, waitBizRendered };
