/**
 * 从"离线导出任务已完成"弹窗点查看→进导出任务页→下载文件→列头。
 */
const { chromium } = require('D:/ZCodetest/aiagentqa_test/node_modules/playwright');
const fs = require('fs');
const DL = 'D:/ZCodetest/aiagentqa_test/_exec_artifacts/downloads';
const PORT = 9335;

(async () => {
  const bd = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const sess = await bd.newBrowserCDPSession();
  await sess.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true }).catch(() => {});
  const ctx = bd.contexts()[0];
  const p = ctx.pages().find(x => x.url().includes('jt-ll.test.ztoeco.com'));

  // 找"离线导出任务已完成"弹窗，点"查看"
  let clicked = false;
  for (const fr of [p.mainFrame(), ...p.frames()]) {
    try {
      const done = fr.locator('.el-dialog').filter({ hasText: '离线导出任务已完成' });
      if (await done.count()) {
        const view = done.locator('button').filter({ hasText: /^查看$/ }).first();
        if (await view.count()) { await view.click({ timeout: 5000 }); clicked = true; break; }
      }
    } catch (e) {}
  }
  console.log('clicked 查看=', clicked);
  await p.waitForTimeout(3500);
  console.log('PAGES=', ctx.pages().map(x => x.url().slice(0, 110)).join(' | '));
  console.log('FRAMES=', p.frames().map(x => x.url().slice(0, 90)).filter(u => u.includes('http')).join(' | '));

  // 新页签/iframe 里找下载链接
  for (const pg of ctx.pages()) {
    const urls = await pg.evaluate(() => [...document.querySelectorAll('a')].map(a => ({ t: (a.innerText || '').trim(), href: a.href })).filter(x => /下载|download|\.xlsx|\.csv|\.zip/i.test(x.t + x.href))).catch(() => []);
    if (urls.length) console.log('DOWNLOAD_LINKS on', pg.url().slice(0, 70), '=', JSON.stringify(urls).slice(0, 800));
  }
  console.log('DOWNLOADS=', JSON.stringify(fs.existsSync(DL) ? fs.readdirSync(DL) : []));
  await bd.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
