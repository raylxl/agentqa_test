/**
 * 导出任务页点第一行"下载"→抓文件→解析列头。
 */
const { chromium } = require('D:/ZCodetest/aiagentqa_test/node_modules/playwright');
const fs = require('fs'), path = require('path');
const DL = 'D:/ZCodetest/aiagentqa_test/_exec_artifacts/downloads';
const PORT = 9335;

(async () => {
  const bd = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const sess = await bd.newBrowserCDPSession();
  await sess.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true }).catch(() => {});
  const ctx = bd.contexts()[0];
  const p = ctx.pages().find(x => x.url().includes('taskTemplateTable')) || ctx.pages().find(x => x.url().includes('jt-ll.test.ztoeco.com'));
  await p.waitForTimeout(1000);
  const f = p.frames().find(x => x.url().includes('taskTemplateTable')) || p.mainFrame();

  // 找第一行（含"对客账单2026"）的 tr，点其"下载"
  const rows = f.locator('.el-table__body-wrapper tbody tr');
  const n = await rows.count();
  console.log('task rows=', n);
  let target = null;
  for (let i = 0; i < n; i++) {
    const t = await rows.nth(i).innerText().catch(() => '');
    if (t.includes('对客账单2026')) { target = i; console.log('target row', i, t.replace(/\s+/g, ' ').slice(0, 120)); break; }
  }
  if (target === null) { console.log('NO_TARGET_ROW'); await bd.close(); process.exit(0); }
  const dlBtn = rows.nth(target).locator('button, a').filter({ hasText: /^下载$/ }).first();
  console.log('dl btn count=', await rows.nth(target).locator('button,a').filter({ hasText: /^下载$/ }).count());
  // 监听下载
  const dlPromise = p.waitForEvent('download', { timeout: 15000 }).catch(e => null);
  await dlBtn.click({ timeout: 6000 }).catch(e => console.log('dl click err', e.message.slice(0, 80)));
  const dl = await dlPromise;
  if (dl) {
    const fn = dl.suggestedFilename();
    console.log('DOWNLOAD_EVENT=', fn);
    await dl.saveAs(path.join(DL, fn)).catch(e => console.log('save err', e.message.slice(0, 80)));
  } else console.log('NO_DOWNLOAD_EVENT');
  await p.waitForTimeout(1500);
  console.log('DOWNLOADS=', JSON.stringify(fs.readdirSync(DL).map(f => ({ f, sz: fs.statSync(path.join(DL, f)).size }))));
  await bd.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
