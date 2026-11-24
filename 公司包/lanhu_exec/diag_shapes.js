#!/usr/bin/env node
/**
 * 诊断（只读）：打印 extractLanhuContent 识别出的几何表里"格子矩形"与"落入的文字件矩形"（视口坐标）。
 * 定位"正文被吞进表格"：看是哪一个文字件、以什么矩形落进了哪个格子。
 * 用法：node diag_shapes.js <端口> --menu "<树内菜单名>" [--table <序号>] [--out <json>]
 */
const fs = require('fs');
const { connectBrowser, getLanhuPages, enterPrototype, robustClickMenu, scrollToBottom, findContentFrame, Logger, extractLanhuContent } = require('./browser_utils');
const { resolveLanhuUrl } = require('./config_loader');
const A = {};
process.argv.slice(2).forEach((s, i, arr) => { if (s.startsWith('--')) A[s.slice(2)] = arr[i + 1]; });
const menu = A.menu, only = A.table === undefined ? null : parseInt(A.table, 10);
if (!menu) { console.error('need --menu'); process.exit(2); }

(async () => {
  const logger = new Logger('diag_shapes');
  const browser = await connectBrowser(logger);
  let pages = await getLanhuPages(browser);
  let page = pages[0], opened = null;
  if (!page) {
    const ctx = browser.contexts()[0] || await browser.newContext();
    page = await ctx.newPage(); opened = page;
    await page.goto(resolveLanhuUrl(), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3500);
    await enterPrototype(page, logger);
  }
  await robustClickMenu(page, menu, logger);
  const frame = await findContentFrame(page, logger);
  await scrollToBottom(frame, logger);
  const ex = await extractLanhuContent(frame, logger);
  if (opened) { try { await opened.close(); } catch (e) {} }
  await browser.close();
  const shapes = ex.tableShapes || [];
  if (A.out) fs.writeFileSync(A.out, JSON.stringify(shapes, null, 1), 'utf-8');
  shapes.forEach((s, i) => {
    if (only !== null && i !== only) return;
    console.log('=== 表' + i + ' top=' + s.top + ' bottom=' + s.bottom + ' 格子 ' + s.cells.length + ' 个，落入项 ' + s.items.length + ' 个');
    s.cells.sort((a, b) => a.y - b.y || a.x - b.x).forEach(c => console.log('   格 y=' + c.y + ' x=' + c.x + ' ' + c.w + 'x' + c.h));
    s.items.sort((a, b) => a.y - b.y || a.x - b.x).forEach(t => console.log('   项 y=' + t.y + ' h=' + t.h + ' x=' + t.x + ' w=' + t.w + ' → 格(y=' + t.cellY + ',h=' + t.cellH + ') ' + JSON.stringify(t.text)));
  });
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(2); });
