#!/usr/bin/env node
/**
 * 诊断（只读）：打印指定菜单页面某段 y 范围内文字件/表单控件的矩形（页面坐标）与文本。
 * 用法：node diag_texts.js <端口> --menu "<树内菜单名>" --from <y> --to <y> [--grep "<关键字>"]
 */
const { connectBrowser, getLanhuPages, enterPrototype, robustClickMenu, scrollToBottom, findContentFrame, Logger } = require('./browser_utils');
const { resolveLanhuUrl } = require('./config_loader');
const A = {};
process.argv.slice(2).forEach((s, i, arr) => { if (s.startsWith('--')) A[s.slice(2)] = arr[i + 1]; });
const menu = A.menu, from = parseFloat(A.from || '0'), to = parseFloat(A.to || '1e9'), grep = A.grep || '';
if (!menu) { console.error('need --menu'); process.exit(2); }

(async () => {
  const logger = new Logger('diag_texts');
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
  const out = await frame.evaluate((args) => {
    const sy0 = window.scrollY || 0;
    const items = [];
    document.querySelectorAll('[id$="_text"]').forEach(el => {
      const t = (el.innerText || '').trim(); if (!t) return;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return;
      const y = Math.round(r.top + sy0);
      if (y < args.from || y > args.to) return;
      items.push({ kind: 'text', y, x: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), t: t.replace(/\n+/g, '⏎').slice(0, 60) });
    });
    document.querySelectorAll('input,select,textarea,button').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const ty = (el.type || '').toLowerCase();
      if (el.tagName === 'INPUT' && (ty === 'checkbox' || ty === 'radio' || ty === 'hidden')) return;
      const y = Math.round(r.top + sy0);
      if (y < args.from || y > args.to) return;
      let t = el.tagName === 'SELECT' ? (el.selectedIndex >= 0 ? el.options[el.selectedIndex].text : '') : (el.value || el.placeholder || '');
      if (!t) return;
      items.push({ kind: 'input', y, x: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), t: String(t).slice(0, 40) });
    });
    return items;
  }, { from, to });
  if (opened) { try { await opened.close(); } catch (e) {} }
  await browser.close();
  out.sort((a, b) => a.y - b.y || a.x - b.x);
  for (const it of out) {
    if (grep && !it.t.includes(grep)) continue;
    console.log('y=%s x=%s w=%s h=%s cy=%s %s %s', it.y, it.x, it.w, it.h, (it.y + it.h / 2).toFixed(0), it.kind.padEnd(5), JSON.stringify(it.t));
  }
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(2); });
