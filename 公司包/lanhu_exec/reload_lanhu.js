/**
 * reload_lanhu.js — 重新加载池租实例上的蓝湖原型页，等待 axure 帧加载完成。
 * 输出状态到本目录 out/_reload.txt。不关闭任何页面。
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out', '_reload.txt');
// 地址四层解析（--url / LANHU_URL / 本机 lanhu_config.json）；复用已有蓝湖页签时不主动 goto
const { resolveLanhuUrl, missingUrlHelp } = require('./config_loader');

(async () => {
  const lines = [];
  const log = (s) => { lines.push(s); console.log(s); };
  const { connectBrowser, getLanhuPages } = require('./browser_utils');
  const browser = await connectBrowser();
  const pages = await getLanhuPages(browser);
  if (!pages.length) { fs.writeFileSync(OUT, 'NO_LANHU_PAGE'); process.exit(1); }
  const page = pages[0];
  log('before url=' + page.url());
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => log('reload err ' + e.message));
  await page.waitForTimeout(4000);
  // 邀请链接重载后可能回到落地态，必要时重新 goto
  const needGoto = !(page.url() || '').includes('invite');
  if (needGoto) {
    const url = resolveLanhuUrl();
    if (url) { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForTimeout(4000); }
    else log('四层解析无地址（--url/LANHU_URL/本机config），跳过 goto');
  }
  // 等 axure iframe 出现
  let frames = [];
  for (let i = 0; i < 20; i++) {
    frames = page.frames().filter(f => /axure|prototype|lanhu/i.test(f.url()));
    if (frames.length) break;
    await page.waitForTimeout(1000);
  }
  log('after url=' + page.url());
  log('title=' + (await page.title().catch(() => '')));
  log('axure-ish frames=' + frames.length + ' :: ' + frames.map(f => f.url().slice(0, 90)).join(' | '));
  // 数菜单树
  const treeCnt = await page.evaluate(() => document.querySelectorAll('.tree-item-wrapper, .tree-name').length).catch(() => 0);
  log('tree items=' + treeCnt);
  fs.writeFileSync(OUT, lines.join('\n'));
  process.exit(0);
})().catch(e => { try { fs.writeFileSync(OUT, 'FATAL ' + e.message); } catch (_) {} process.exit(1); });
