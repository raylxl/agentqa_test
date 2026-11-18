#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { connectBrowser, getLanhuPages } = require('./browser_utils');

(async () => {
  const out = [];
  const browser = await connectBrowser();
  let pages = await getLanhuPages(browser);
  let page = pages[0] || null;
  if (!page) {
    // 池化任务式：无蓝湖页签则新开邀请链接并进原型（用完即关）
    const { resolveLanhuUrl, missingUrlHelp } = require('./config_loader');
    const url = resolveLanhuUrl();
    if (!url) { console.log(missingUrlHelp()); process.exit(2); }
    const ctx = browser.contexts()[0] || await browser.newContext();
    page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3500);
    const { enterPrototype } = require('./browser_utils');
    await enterPrototype(page);
    var opened = page;
  }
  const names = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.tree-item-wrapper')).map(e => e.textContent.trim());
  });
  const kws = ['平台价格', '仓内作业价格', '配送价格', '出入库账单', '通用计费规则调整', '货量考核政策', '存储账单'];
  const matched = names.filter(n => kws.some(k => n.includes(k)));
  out.push('TOTAL_TREE=' + names.length);
  out.push('MATCHED=' + JSON.stringify(matched, null, 0));
  require('fs').mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', '_menus.txt'), out.join('\n'));
  if (typeof opened !== 'undefined') { try { await opened.close(); } catch (e) {} } // 关本任务开的页签
  await new Promise(r => setTimeout(r, 800));
  process.exit(0);
})().catch(e => { try { require('fs').mkdirSync(path.join(__dirname, 'out'), { recursive: true }); fs.writeFileSync(path.join(__dirname, 'out', '_menus.txt'), 'FATAL ' + e.message); } catch (_) {} console.error(e.message); process.exit(1); });
