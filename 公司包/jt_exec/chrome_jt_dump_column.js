/**
 * 鲸天一级栏目菜单树导出（通用，Chrome 9333）
 * 用法：node chrome_jt_dump_column.js <一级栏目名> [输出文件名]
 * 数据源：localStorage.MICRO_APP_MAIN_MENU_LIST（当前租户）
 * 字段：分组 categoryName / 叶子 chilePlatformMenuList[].menuName+uri
 */
const path = require('path');
const fs = require('fs');
let chromium;
for (const p of ['playwright', path.join('d:', 'WorkBuddy-projects', 'testcase', 'node_modules', 'playwright')]) {
  try { chromium = require(p).chromium; if (chromium) break; } catch (_) {}
}
const COLUMN = process.argv[2];
const OUT = process.argv[3] || ('column_' + (COLUMN || '') + '_tree.json');
if (!COLUMN) { console.error('用法: node chrome_jt_dump_column.js <一级栏目名> [输出文件名]'); process.exit(2); }

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const page = browser.contexts()[0].pages().find(p => {
    try { return p.url().includes('jt-ll.test.ztoeco.com'); } catch (_) { return false; }
  });
  const target = await page.evaluate((column) => {
    const arr = JSON.parse(localStorage.getItem('MICRO_APP_MAIN_MENU_LIST') || '[]');
    const find = (nodes, name) => {
      for (const n of nodes) {
        if ((n.categoryName || '') === name) return n;
        const r = find(n.childPlatformCategoryList || [], name);
        if (r) return r;
      }
      return null;
    };
    const t = find(arr, column);
    if (!t) return null;
    const simplify = (n, level) => ({
      name: n.categoryName, code: n.categoryCode, uri: n.uri || null, id: n.id, level,
      kids: (n.childPlatformCategoryList || []).map(c => simplify(c, level + 1)),
      leafs: (n.chilePlatformMenuList || []).map(m => ({ name: m.menuName || m.displayName, uri: m.uri || null, code: m.menuCode || null, id: m.id, filePath: m.filePath || null, frameSrc: m.frameSrc || null }))
    });
    return simplify(t, 0);
  }, COLUMN);
  if (!target) { console.log('NOT FOUND ' + COLUMN + '（当前租户菜单树内）'); process.exit(1); }
  fs.writeFileSync(path.join(__dirname, OUT), JSON.stringify(target, null, 1));

  const lines = [];
  const walk = (n, ind) => {
    lines.push(ind + n.name + (n.uri ? '  [' + n.uri + ']' : '') + (n.leafs.length ? ' {leaf x' + n.leafs.length + '}' : ''));
    n.kids.forEach(k => walk(k, ind + '  '));
    n.leafs.forEach(l => lines.push(ind + '  · ' + l.name + (l.uri ? '  [' + l.uri + ']' : '')));
  };
  walk(target, '');
  console.log(lines.join('\n'));
  const cnt = n => n.leafs.length + n.kids.reduce((s, k) => s + cnt(k), 0);
  console.log('\n[统计] 二级分组', target.kids.length, '个；叶子菜单总数', cnt(target), '个；已写', OUT);
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(2); });
