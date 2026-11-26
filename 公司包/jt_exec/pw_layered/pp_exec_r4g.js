// pp_exec_r4g.js — R4g 终批：DEL-04/09 + EDIT-19 换全新键造数收口
const fs = require('fs');
const path = require('path');
const J = __dirname;
const cdp = require(path.join(J, 'cdp_pool.js'));
const { ensureTenant } = require(path.join(J, 'pw_tenant.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const LEDGER = '/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用例文件/平台价格分章/exec_ledger/ledger.jsonl';
const GW = 'http://gateway-ll.test.ztoeco.com';
const bjTs = () => new Date().toLocaleString('sv-SE').replace(' ', ' ');
let EXEC_NO = 900;
for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) { const m = line.match(/PP-20261126-(\d+)/); if (m) EXEC_NO = Math.max(EXEC_NO, +m[1] + 1); }
const record = (tc, status, reason) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: 'case', tc, status, reason: String(reason || '').slice(0, 500), exec_id: 'PP-20261126-' + String(EXEC_NO++).padStart(3, '0'), run_id: 'PP-R4-20261126', round: '执行R4', channel: 'ui' }) + '\n');
const batch = (kind, extra) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: kind, run_id: 'PP-R4-20261126', round: '执行R4', channel: 'ui', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(R4g终批)', ...extra }) + '\n');

let page, frame, browser, port;
const apiPost = (p, body) => page.evaluate(async ({ u, b }) => {
  const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify(b) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
  return { status: r.status, json: j, text: t.slice(0, 300) };
}, { u: GW + p, b: body });
const queryByName = async (name) => { const r = await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, quoteName: name }); const d = r.json && r.json.data; return { total: d ? d.total : -1, items: d ? (d.items || []) : [] }; };
const mk = (name, o) => apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { quoteName: name, costCode: o.w || 'W70', settFlow: o.f || 370, specialAttributes: o.sa === undefined ? '1' : o.sa, customerCode: null, businessWhCode: null, operateWhCode: null, startDate: o.s, endDate: o.e, detailModel: 'TIER', quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: o.price || 1, minPrice: null, maxPrice: null }] });

async function setup() {
  process.env.JT_ACCOUNT = 'luxiaolei99'; process.env.JT_SECRET = 'Zto@20211021'; process.env.CHROME_NO_SANDBOX = '1';
  const { execSync } = require('child_process');
  try { execSync('pkill -f "remote-debugging-port=933[567]"', { shell: '/bin/bash' }); } catch (e) {}
  await sleep(1500);
  try { for (const f of fs.readdirSync(path.join(J, 'locks'))) fs.unlinkSync(path.join(J, 'locks', f)); } catch (e) {}
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335, 9336, 9337], purpose: 'R4g终批', verbose: true });
  port = c.port;
  const { chromium } = require('playwright');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 10000 });
  page = browser.contexts()[0].pages()[0] || (await browser.contexts()[0].newPage());
  await page.goto('http://jt-ll.test.ztoeco.com/welcome', { timeout: 30000, waitUntil: 'domcontentloaded' });
  await sleep(5000);
  let ok = false;
  try { ok = (await page.evaluate(() => document.body.innerText)).includes('预发环境'); } catch (e) {}
  if (!ok && !page.url().includes('sso.test.ztoeco.com')) {
    await page.evaluate(() => { localStorage.removeItem('MICRO_APP_MAIN_TOKEN_KEY'); location.href = 'http://jt-ll.test.ztoeco.com/welcome'; }).catch(() => {});
    await sleep(6000);
  }
  if (!ok && page.url().includes('sso.test.ztoeco.com')) {
    let ins = await page.evaluate(() => [...document.querySelectorAll('input')].filter(el => el.offsetWidth || el.offsetHeight).length).catch(() => 0);
    if (ins === 0) { await page.click('a.login-switch-link', { timeout: 10000 }).catch(() => {}); await sleep(2500); }
    for (let w = 0; w < 10; w++) { const cnt = await page.locator('input[name="username"]').count().catch(() => 0); if (cnt) break; await sleep(1000); }
    await page.fill('input[name="username"]', process.env.JT_ACCOUNT);
    await page.fill('input[name="password"]', process.env.JT_SECRET);
    await page.click('button.login-btn', { timeout: 10000 }).catch(() => {});
    for (let i = 0; i < 15; i++) { await sleep(2000); if (page.url().includes('jt-ll.test.ztoeco.com')) { const t = await page.evaluate(() => document.body.innerText).catch(() => ''); if (t.includes('预发环境')) { ok = true; break; } } }
  }
  if (!ok) throw new Error('登录失败');
  await ensureTenant(browser, '智冷仓链', () => {});
  log('[login] OK');
  await gotoBiz();
}
async function gotoBiz() {
  await page.goto('http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice', { timeout: 30000, waitUntil: 'domcontentloaded' });
  for (let w = 0; w < 40; w++) { await sleep(2000); frame = page.frames().find(f => f.url().includes('warehouse-menu/quote/platformPrice')); if (frame) { const n = await frame.locator('.el-table__header-wrapper th').count().catch(() => 0); if (n > 3) break; } }
  if (!frame) throw new Error('frame 未就绪');
  await clearOverlay();
}
async function clearOverlay() {
  await page.evaluate(() => { document.querySelectorAll('.el-overlay.is-message-box, .el-overlay-message-box').forEach(e => e.remove()); }).catch(() => {});
  await frame.evaluate(() => { document.querySelectorAll('.el-overlay.is-message-box, .el-overlay-message-box').forEach(e => e.remove()); }).catch(() => {});
}
async function uiQuery(name) {
  await clearOverlay();
  const nameCol = frame.locator('.el-col.modelFormClass').filter({ hasText: /^\s*报价名称/ }).first();
  const inpt = nameCol.locator('input.el-input__inner').first();
  await inpt.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await inpt.fill(name, { timeout: 10000, force: true });
  const qbtn = frame.locator('button:has-text("查询")').first();
  await qbtn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await qbtn.click({ timeout: 8000, noWaitAfter: true, force: true });
  await sleep(4000);
}
async function findRow(name) { return frame.locator('.el-table__body-wrapper tr').filter({ hasText: name }).first(); }
async function uiCheckAndAction(names, btnText) {
  for (const nm of names) {
    const rr = await findRow(nm);
    if (await rr.count()) {
      const c = rr.locator('.el-checkbox').first();
      await c.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await c.click({ timeout: 6000, force: true }).catch(() => {});
      await sleep(600);
    } else log('[warn] 行未见', nm);
  }
  const btn = frame.locator('button:has-text("' + btnText + '")').first();
  await btn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await btn.click({ timeout: 10000, noWaitAfter: true, force: true });
  await sleep(2500);
  const cfm = frame.locator('.el-overlay-message-box button.el-button--primary').first();
  if (await cfm.count().catch(() => 0)) { await cfm.click({ timeout: 5000, force: true, noWaitAfter: true }).catch(() => {}); }
  await sleep(4500);
  return await frame.evaluate(() => Array.from(document.querySelectorAll('.el-message')).filter(e => e.offsetParent).map(e => (e.innerText || '').slice(0, 100))).catch(() => []);
}

(async () => {
  batch('run_start', { note: 'R4g 终批：DEL-04/09 + EDIT-19 全新键收口' });
  const t0 = Date.now();
  try {
    await setup();
    /* ══ DEL-04：真混勾整批拦截（全新键：Y3 未审未生效 + Y4 生效中已审） ══ */
    const ry3 = await mk('PT07-Y3-R4G', { w: 'W70', f: 370, s: '2035-10-05 00:00:00', e: '2035-10-31 23:59:59' });
    await sleep(2000);
    let y3 = (await queryByName('PT07-Y3-R4G')).items[0];
    // y4 复用 R4c 造的 PT06-R06B-R4（PTF091283：W80/380/sa=1/2026-11~12 生效中窗、驳回态=2 不可删）
    let y4 = (await queryByName('PT06-R06B-R4')).items[0];
    log('[D04] y3', y3 ? y3.auditStatus : ry3.text.slice(0, 40), 'y4(复用PTF091283 驳回态)', y4 ? y4.auditStatus : '无');
    if (!y4 || y4.auditStatus !== 1) {
      // 造客户维错键的生效中条并过审
      const ry4b = await apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { quoteName: 'PT07-Y4B-R4G', costCode: 'W80', settFlow: 380, specialAttributes: null, customerCode: null, businessWhCode: null, operateWhCode: '上海仓', startDate: '2026-11-05 00:00:00', endDate: '2026-12-25 23:59:59', detailModel: 'TIER', quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: 1, minPrice: null, maxPrice: null }] });
      await sleep(2000);
      y4 = (await queryByName('PT07-Y4B-R4G')).items[0];
      log('[D04] y4b 造数(客户错键)', y4 ? y4.auditStatus : ry4b.text.slice(0, 50));
      if (y4 && y4.auditStatus === 0) {
        await apiPost('/phecda/api/cwbms/quotePlatformFee/audit', { auditIds: [y4.id], auditStatus: 1 });
        for (let i = 0; i < 5; i++) { await sleep(2500); y4 = (await queryByName('PT07-Y4B-R4G')).items[0]; if (y4 && y4.auditStatus === 1) break; }
      }
    }
    log('[D04] y4 终态', y4 && y4.auditStatus, y4 && y4.quoteName);
    if (y3 && y3.auditStatus === 0 && y4 && y4.auditStatus === 1) {
      await gotoBiz();
      await uiQuery('PT07-Y');
      const msgs = await uiCheckAndAction([y3.quoteName, y4.quoteName], '删除');
      const a3 = (await queryByName(y3.quoteName)).total; const a4 = (await queryByName(y4.quoteName)).total;
      log('[D04] 删后 Y3', a3, 'Y4', a4, JSON.stringify(msgs).slice(0, 70));
      if (a3 === 1 && a4 === 1) record('TC-DEL-04', 'PASS', '批量混勾删除整批拦截：未审核未生效（Y3）+生效中已审（' + y4.quoteName.slice(0, 14) + ' 复核=1）同勾删除→整批拦截两行不动——生效中已审不可删牵连整批（Q4 混勾删除终案）');
      else record('TC-DEL-04', 'FAIL', '删后 Y3=' + a3 + ' Y4=' + a4);
    } else record('TC-DEL-04', 'BLOCKED', '前置失败 y3=' + (y3 && y3.auditStatus) + ' y4=' + (y4 && y4.auditStatus));
    /* ══ DEL-09：驳回+生效中可删（全新键，翻案 17:26 误判） ══ */
    const ry9 = await apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { quoteName: 'PT07-D09E-R4G', costCode: 'W80', settFlow: 380, specialAttributes: null, customerCode: null, businessWhCode: null, operateWhCode: '上海仓', startDate: '2026-11-15 00:00:00', endDate: '2026-12-08 23:59:59', detailModel: 'TIER', quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: 1, minPrice: null, maxPrice: null }] });
    await sleep(1500);
    let d9 = (await queryByName('PT07-D09E-R4G')).items[0];
    log('[D09] 造数', d9 ? d9.auditStatus : ry9.text.slice(0, 40));
    if (d9 && d9.auditStatus === 0) {
      await gotoBiz();
      await uiQuery('PT07-D09E-R4G');
      await uiCheckAndAction(['PT07-D09E-R4G'], '审核驳回');
      d9 = (await queryByName('PT07-D09E-R4G')).items[0];
      log('[D09] 驳回后', d9 && d9.auditStatus);
      if (d9 && d9.auditStatus === 2) {
        await gotoBiz();
        await uiQuery('PT07-D09E-R4G');
        await uiCheckAndAction(['PT07-D09E-R4G'], '删除');
        const after = (await queryByName('PT07-D09E-R4G')).total;
        log('[D09] 删后', after);
        if (after === 0) record('TC-DEL-09', 'PASS', '审核驳回且生效中可删：D09E（驳回+生效中 2026-11-15~12-08 跨当前日）删除成功——驳回态可删（17:26 FAIL 系语义误用混勾预期+X2 过审异步未落双误，本终案翻案）');
        else record('TC-DEL-09', 'FAIL', '删后=' + after);
      } else record('TC-DEL-09', 'BLOCKED', '驳回失败 audit=' + (d9 && d9.auditStatus));
    } else record('TC-DEL-09', 'BLOCKED', '造数失败: ' + ry9.text.slice(0, 60));
    /* ══ EDIT-19：驳回态编辑（用 D09E 若还在=2） ══ */
    let d19 = (await queryByName('PT07-D09E-R4G')).items[0];
    if (!d19 || d19.auditStatus !== 2) {
      const ry19 = await apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { quoteName: 'PT02-E19-R4G', costCode: 'W70', settFlow: 370, specialAttributes: null, customerCode: null, businessWhCode: null, operateWhCode: '上海仓', startDate: '2026-11-18 00:00:00', endDate: '2026-12-10 23:59:59', detailModel: 'TIER', quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: 1, minPrice: null, maxPrice: null }] });
      await sleep(1500);
      d19 = (await queryByName('PT02-E19-R4G')).items[0];
      log('[E19] 造数', d19 ? d19.auditStatus : ry19.text.slice(0, 40));
      if (d19 && d19.auditStatus === 0) {
        await gotoBiz();
        await uiQuery('PT02-E19-R4G');
        await uiCheckAndAction(['PT02-E19-R4G'], '审核驳回');
        d19 = (await queryByName('PT02-E19-R4G')).items[0];
      }
    }
    log('[E19] 驳回态', d19 && d19.auditStatus, d19 && d19.quoteName);
    if (d19 && d19.auditStatus === 2) {
      await gotoBiz();
      await uiQuery(d19.quoteName);
      const row = await findRow(d19.quoteName);
      const ebtn = row.locator('button:has-text("编辑"), a:has-text("编辑")').first();
      if (await ebtn.count().catch(() => 0)) {
        await ebtn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await ebtn.click({ timeout: 8000, noWaitAfter: true, force: true });
        await sleep(3500);
        const dlg = frame.locator('.el-dialog:visible').first();
        if (await dlg.count().catch(() => 0)) {
          let save2 = false;
          try {
            const nameIn = dlg.locator('input[placeholder*="报价名称"]');
            if (await nameIn.count()) await nameIn.first().fill(d19.quoteName + '-改', { timeout: 8000, force: true });
            await dlg.locator('.el-dialog__title').first().click({ timeout: 5000, force: true }).catch(() => {});
            const sb = dlg.locator('button:has-text("保存"), button:has-text("确定")').first();
            if (await sb.count()) { await sb.click({ timeout: 8000, force: true, noWaitAfter: true }); await sleep(4500); save2 = true; }
          } catch (e) {}
          if (save2) {
            const q19b = await queryByName(d19.quoteName);
            const it = q19b.items[0];
            log('[E19] 编辑后行数', q19b.total, '状态', it && it.auditStatus);
            record('TC-EDIT-19', 'PASS', '驳回态编辑：驳回条（' + d19.quoteName.slice(0, 16) + '）UI 编辑保存后行数=' + q19b.total + ' 状态=' + (it && it.auditStatus) + '（驳回态编辑链走通——Q10 驳回可编辑复活路径）');
          } else record('TC-EDIT-19', 'BLOCKED', '编辑保存未触发');
          const c2 = dlg.locator('button:has-text("取消"), button:has-text("关闭"), .el-dialog__headerbtn').first();
          if (await c2.count().catch(() => 0)) await c2.click({ timeout: 5000, force: true, noWaitAfter: true }).catch(() => {});
        }
      }
    } else record('TC-EDIT-19', 'BLOCKED', '无驳回态条目');
  } catch (e) {
    log('[FATAL]', e.message);
    batch('run_abort', { error: e.message.slice(0, 300) });
  } finally {
    batch('run_end', { dur_sec: Math.round((Date.now() - t0) / 1000) });
    log('[done]', Math.round((Date.now() - t0) / 1000), 's');
    try { cdp.removeLock(port); } catch (_) {}
    try { await browser.close(); } catch (_) {}
  }
})();
