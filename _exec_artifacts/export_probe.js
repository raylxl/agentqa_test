/**
 * 导出通道实测：点导出→确认→观察下载/导出任务页→抓文件列头。
 */
const { chromium } = require('D:/ZCodetest/aiagentqa_test/node_modules/playwright');
const fs = require('fs');
const DL = 'D:/ZCodetest/aiagentqa_test/_exec_artifacts/downloads';
const PORT = 9335;
const URL = 'http://jt-ll.test.ztoeco.com/app/#/phecda/bill/refactoringCustomerBill';

(async () => {
  const bd = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = bd.contexts()[0];
  // 允许下载到指定目录（CDP browser-level）
  const sess = await bd.newBrowserCDPSession();
  await sess.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true }).catch(e => console.log('setDownloadBehavior err', e.message));

  let p = ctx.pages().find(x => x.url().includes('jt-ll.test.ztoeco.com'));
  if (!p.url().includes('refactoringCustomerBill')) { await p.goto(URL, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(6000); }
  const f = p.frames().find(x => x.url().includes('refactoringCustomerBill') && x.url().includes('#/')) || p.mainFrame();

  // 点导出
  await f.locator('button').filter({ hasText: /^导出$/ }).first().click({ timeout: 8000 }).catch(e => console.log('导出click err', e.message.slice(0, 80)));
  await p.waitForTimeout(1200);
  // 弹窗里点"确认"
  let confirmed = false;
  for (const fr of [f, p.mainFrame()]) {
    try {
      const ok = fr.locator('.el-dialog button').filter({ hasText: /^确认$/ }).first();
      if (await ok.count()) { await ok.click({ timeout: 5000 }); confirmed = true; break; }
    } catch (e) {}
  }
  console.log('confirmed=', confirmed);
  await p.waitForTimeout(6000);

  // 观察：新页签/导出任务页/下载文件
  console.log('PAGES=', ctx.pages().map(x => x.url().slice(0, 100)).join(' | '));
  const dlBefore = fs.existsSync(DL) ? fs.readdirSync(DL) : [];
  console.log('DOWNLOADS=', JSON.stringify(dlBefore));
  // 页面新出现的文本片段（导出任务提示）
  const txt = await p.evaluate(() => (document.body.innerText || '').slice(-600)).catch(() => '');
  console.log('BODY_TAIL=', JSON.stringify(txt));
  // 弹窗再查
  const dlg = await p.evaluate(() => [...document.querySelectorAll('.el-dialog,.el-message-box')].filter(e => e.getBoundingClientRect().width > 0).map(e => (e.innerText || '').trim().slice(0, 200))).catch(() => []);
  console.log('DIALOGS=', JSON.stringify(dlg));
  await bd.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
