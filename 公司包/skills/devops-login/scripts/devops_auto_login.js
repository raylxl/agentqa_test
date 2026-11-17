// devops_auto_login.js — 检测 OAuth 一键登录卡并自动点击（宝盒在线时）
// 用法：node devops_auto_login.js [最长等待秒数=90]
const { chromium } = require('playwright');
const maxSec = parseInt(process.argv[2] || '90', 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
  const ctx = browser.contexts().find(c => c.pages().length > 0);
  const start = Date.now();
  while (Date.now() - start < maxSec * 1000) {
    for (const page of ctx.pages()) {
      const url = page.url();
      // 已在 devops 域 = 登录完成
      if (url.includes('devops.dev.ztoeco.com') && !url.includes('connect.zto.com')) {
        console.log('已登录:', page.title().then ? '' : '', url.slice(0, 60));
        console.log('OK: 已在一站式域内，无需登录');
        process.exit(0);
      }
      if (url.includes('connect.zto.com')) {
        // 找一键登录按钮
        try {
          const btn = page.evaluate(() => {
            const els = document.querySelectorAll('button, div, span, a');
            for (const e of els) {
              const r = e.getBoundingClientRect();
              if (r.width > 0 && r.height > 0 && e.children.length === 0 && (e.innerText || '').trim() === '一键登录') {
                return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
              }
            }
            return null;
          });
          if (btn) {
            console.log('找到一键登录按钮，真实点击 @', btn.x, btn.y);
            await page.mouse.click(btn.x, btn.y);
            await sleep(8000); // 宝盒确认异步等
            const u2 = page.url();
            if (u2.includes('devops.dev.ztoeco.com')) {
              console.log('OK: 一键登录成功');
              process.exit(0);
            }
            console.log('点击后仍在 OAuth，继续等待...');
          }
        } catch (e) { /* 页面导航中，忽略 */ }
      }
    }
    await sleep(3000);
  }
  console.log('TIMEOUT: 未在', maxSec, '秒内完成登录（检查宝盒是否在线）');
  process.exit(1);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
