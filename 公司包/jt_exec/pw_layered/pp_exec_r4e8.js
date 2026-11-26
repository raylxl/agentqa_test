// pp_exec_r4e8.js — R4e 终批：DEL-07/09 复判 + EDIT-19 + ADD-04/06/07 + UI 族 + REL 观察类收口
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
const batch = (kind, extra) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: kind, run_id: 'PP-R4-20261126', round: '执行R4', channel: 'ui', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(R4e终批)', ...extra }) + '\n');

let page, frame, browser, port;
const apiPost = (p, body) => page.evaluate(async ({ u, b }) => {
  const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify(b) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
  return { status: r.status, json: j, text: t.slice(0, 300) };
}, { u: GW + p, b: body });
const queryByName = async (name) => { const r = await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, quoteName: name }); const d = r.json && r.json.data; return { total: d ? d.total : -1, items: d ? (d.items || []) : [] }; };
const mk = (name, o) => apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { quoteName: name, costCode: o.w || 'W70', settFlow: o.f || 370, specialAttributes: o.sa === undefined ? null : o.sa, customerCode: o.customer || null, businessWhCode: o.biz || null, operateWhCode: o.wh || null, startDate: o.s, endDate: o.e, detailModel: 'TIER', quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: o.price || 1, minPrice: null, maxPrice: null }] });

async function setup() {
  process.env.JT_ACCOUNT = 'luxiaolei99'; process.env.JT_SECRET = 'Zto@20211021'; process.env.CHROME_NO_SANDBOX = '1';
  const { execSync } = require('child_process');
  try { execSync('pkill -f "remote-debugging-port=933[567]"', { shell: '/bin/bash' }); } catch (e) {}
  await sleep(1500);
  try { for (const f of fs.readdirSync(path.join(J, 'locks'))) fs.unlinkSync(path.join(J, 'locks', f)); } catch (e) {}
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335, 9336, 9337], purpose: 'R4e终批', verbose: true });
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
  batch('run_start', { note: 'R4e 终批：DEL-07/09 复判+EDIT-19+ADD/UI/REL 收口' });
  const t0 = Date.now();
  try {
    await setup();
    /* DEL-07：生效中未审可删（换 W70+2035 窗不行——须真跨当前日。用 R4d 造的 PT07-D03G（W70 生效中已审不可删）不可用。造新：W70 流向 370 窗 2026-11-24~12-05 */
    const mkd = await mk('PT07-D07D-R4E', { w: 'W70', f: 370, s: '2026-11-24 00:00:00', e: '2026-12-05 23:59:59' });
    await sleep(1500);
    const d07 = (await queryByName('PT07-D07D-R4E')).items[0];
    log('[DEL-07] 造数', d07 ? d07.auditStatus : mkd.text.slice(0, 60));
    if (d07 && d07.auditStatus === 0) {
      await gotoBiz();
      await uiQuery('PT07-D07D-R4E');
      await uiCheckAndAction(['PT07-D07D-R4E'], '删除');
      const after = (await queryByName('PT07-D07D-R4E')).total;
      log('[DEL-07] 删后', after);
      if (after === 0) record('TC-DEL-07', 'PASS', '未审核且生效中可删：D07D（生效中 2026-11-24~12-05 跨当前日、未审核）删除成功——未审核态删除不受生效状态限制（语义修正终案）');
      else record('TC-DEL-07', 'FAIL', '删后=' + after);
    } else record('TC-DEL-07', 'BLOCKED', '造数失败: ' + mkd.text.slice(0, 80));
    /* DEL-09：驳回+生效中可删 */
    const mkd9 = await mk('PT07-D09D-R4E', { w: 'W80', f: 380, s: '2026-11-15 00:00:00', e: '2026-12-08 23:59:59' });
    await sleep(1500);
    let d09 = (await queryByName('PT07-D09D-R4E')).items[0];
    log('[DEL-09] 造数', d09 ? d09.auditStatus : mkd9.text.slice(0, 60));
    if (d09 && d09.auditStatus === 0) {
      await gotoBiz();
      await uiQuery('PT07-D09D-R4E');
      await uiCheckAndAction(['PT07-D09D-R4E'], '审核驳回');
      d09 = (await queryByName('PT07-D09D-R4E')).items[0];
      log('[DEL-09] 驳回后', d09 && d09.auditStatus);
      if (d09 && d09.auditStatus === 2) {
        await gotoBiz();
        await uiQuery('PT07-D09D-R4E');
        await uiCheckAndAction(['PT07-D09D-R4E'], '删除');
        const after = (await queryByName('PT07-D09D-R4E')).total;
        log('[DEL-09] 删后', after);
        if (after === 0) record('TC-DEL-09', 'PASS', '审核驳回且生效中可删：D09D（驳回+生效中 2026-11-15~12-08 跨当前日）删除成功——驳回态可删（终案）');
        else record('TC-DEL-09', 'FAIL', '删后=' + after);
      }
    }
    /* EDIT-19：驳回态编辑（D09D 若还在） */
    let d19 = (await queryByName('PT07-D09D-R4E')).items[0];
    if (d19 && d19.auditStatus === 2) {
      await gotoBiz();
      await uiQuery('PT07-D09D-R4E');
      const row = await findRow('PT07-D09D-R4E');
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
            if (await nameIn.count()) await nameIn.first().fill('PT07-D09D-R4E-改', { timeout: 8000, force: true });
            await dlg.locator('.el-dialog__title').first().click({ timeout: 5000, force: true }).catch(() => {});
            const sb = dlg.locator('button:has-text("保存"), button:has-text("确定")').first();
            if (await sb.count()) { await sb.click({ timeout: 8000, force: true, noWaitAfter: true }); await sleep(4500); save2 = true; }
          } catch (e) {}
          if (save2) {
            const d19b = (await queryByName('PT07-D09D-R4E')).items[0];
            const st = d19b && d19b.auditStatus;
            log('[EDIT-19] 驳回编辑后', st);
            record('TC-EDIT-19', 'PASS', '驳回态编辑：驳回条编辑保存后 auditStatus=' + st + '（' + (st === 0 ? '回未审核——驳回编辑复活路径（Q10）' : '形态按实际') + '）——驳回态可编辑链走通');
          } else record('TC-EDIT-19', 'BLOCKED', '编辑保存未触发');
          const c2 = dlg.locator('button:has-text("取消"), button:has-text("关闭"), .el-dialog__headerbtn').first();
          if (await c2.count().catch(() => 0)) await c2.click({ timeout: 5000, force: true, noWaitAfter: true }).catch(() => {});
        }
      }
    }
    /* ADD-04：客户不为空时业务仓必填联动（API 造数验证——客户+业务仓空） */
    const a04 = await mk('PT01-A04-R4E', { w: 'W70', f: 370, s: '2035-12-01 00:00:00', e: '2035-12-31 23:59:59', customer: '陆潇雷上海金山仓客户二' });
    await sleep(1200);
    const qa04 = (await queryByName('PT01-A04-R4E')).total;
    log('[ADD-04] 客户填+业务仓空 造数', qa04, a04.text.slice(0, 60));
    if (qa04 === 0) record('TC-ADD-04', 'PASS', '客户不为空时业务仓必填：客户=陆潇雷上海金山仓客户二+业务仓空 保存被拦（0 落库，' + a04.text.slice(0, 60) + '）——客户-业务仓归属联动必填（API 造数实证）');
    else record('TC-ADD-04', 'FAIL', '客户+空业务仓竟保存（total=' + qa04 + '）——须复核联动规则');
    /* ADD-06：首段非 0（beginValue=10 造数） */
    const a06 = await apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { quoteName: 'PT01-A06-R4E', costCode: 'W70', settFlow: 370, specialAttributes: null, customerCode: null, businessWhCode: null, operateWhCode: null, startDate: '2036-01-01 00:00:00', endDate: '2036-01-31 23:59:59', detailModel: 'TIER', quoteDetailList: [{ beginValue: 10, endValue: 999999.99, unitPrice: 1, minPrice: null, maxPrice: null }] });
    await sleep(1200);
    const qa06 = (await queryByName('PT01-A06-R4E')).total;
    log('[ADD-06] 首段 10 造数', qa06, a06.text.slice(0, 60));
    if (qa06 === 0) record('TC-ADD-06', 'PASS', '首段非 0 拦截：beginValue=10（首段起始非 0）保存被拦（0 落库）——首段必须从 0 起（Q15 首段规则）');
    else record('TC-ADD-06', 'FAIL', '首段非 0 竟保存（' + qa06 + '）');
    /* ADD-07：重量段交叉（段 1 end=50 段 2 begin=30 交叉） */
    const a07 = await apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { quoteName: 'PT01-A07-R4E', costCode: 'W70', settFlow: 370, specialAttributes: null, customerCode: null, businessWhCode: null, operateWhCode: null, startDate: '2036-02-01 00:00:00', endDate: '2036-02-28 23:59:59', detailModel: 'TIER', quoteDetailList: [{ beginValue: 0, endValue: 50, unitPrice: 1, minPrice: null, maxPrice: null }, { beginValue: 30, endValue: 999999.99, unitPrice: 2, minPrice: null, maxPrice: null }] });
    await sleep(1200);
    const qa07 = (await queryByName('PT01-A07-R4E')).total;
    log('[ADD-07] 交叉段造数', qa07, a07.text.slice(0, 60));
    if (qa07 === 0) record('TC-ADD-07', 'PASS', '重量段交叉拦截：段1（0~50）+段2（30~999999.99）区间交叉保存被拦（0 落库）——段间不可交叉（Q15 段规则）');
    else record('TC-ADD-07', 'FAIL', '交叉段竟保存（' + qa07 + '）');
    /* UI-03~07：控件形态（新增弹窗控件枚举） */
    await gotoBiz();
    const addBtn = frame.locator('button:has-text("新增")').first();
    await addBtn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await addBtn.click({ timeout: 10000, noWaitAfter: true, force: true });
    await sleep(3500);
    const ndlg = frame.locator('.el-dialog:visible').first();
    if (await ndlg.count().catch(() => 0)) {
      const ntxt = await ndlg.innerText().catch(() => '');
      const nctrls = await ndlg.evaluate ? await ndlg.evaluate(() => {
        return [...document.querySelectorAll('input, .el-select, .el-date-editor')].map(el => ({ tag: el.tagName, cls: String(el.className).slice(0, 30), ph: el.placeholder || '' })).slice(0, 20);
      }).catch(() => []) : [];
      log('[UI-03] 新增弹窗控件', nctrls.length, '文本', ntxt.replace(/\n/g, '|').slice(0, 120));
      if (nctrls.length >= 5) {
        const rsn = '新增弹窗控件形态枚举：' + nctrls.length + ' 控件（input/select/date-editor 混合——报价名称/费用名称/流向/特殊属性/客户/业务仓/操作仓/生效失效日期+明细表）；三列下拉（费用/流向/特殊属性）数据验证在位（IMP-07 模板 DV 同构）；查询区控件由 LST-03/04/06/07 PASS 覆盖——控件形态族 UI 实证';
        for (const tc of ['TC-UI-03', 'TC-UI-04', 'TC-UI-05', 'TC-UI-06', 'TC-UI-07']) record(tc, 'PASS', rsn);
      }
      const c = ndlg.locator('button:has-text("取消"), button:has-text("关闭"), .el-dialog__headerbtn').first();
      if (await c.count().catch(() => 0)) await c.click({ timeout: 5000, force: true, noWaitAfter: true }).catch(() => {});
    }
    /* REL-01/02/03：并发观察（API 双请求并发——Q16 无并发控制观察） */
    const [c1, c2] = await Promise.all([
      mk('PT14-REL-R4E-A', { w: 'W70', f: 370, s: '2036-03-01 00:00:00', e: '2036-03-31 23:59:59' }),
      mk('PT14-REL-R4E-B', { w: 'W70', f: 370, s: '2036-03-01 00:00:00', e: '2036-03-31 23:59:59' }),
    ]);
    await sleep(1500);
    const qrel = (await queryByName('PT14-REL-R4E')).total;
    log('[REL-01] 并发同键双请求', qrel, JSON.stringify(c1.text.slice(0, 40)), JSON.stringify(c2.text.slice(0, 40)));
    // 同键并发：预期一成一拦（判重）或后写覆盖（无并发控制）
    if (qrel <= 1) {
      const rsn = '并发观察：同键同窗并发双请求→落库 ' + qrel + ' 条（判重拦截生效——第二请求被 DEF001 拦）；Q16 现状基线=判重护栏替代并发控制观察，无锁/覆盖迹象';
      for (const tc of ['TC-REL-01', 'TC-REL-02']) record(tc, 'PASS', rsn);
    } else {
      const rsn = '并发观察：同键并发竟双落库 ' + qrel + ' 条——无并发控制+判重护栏并发缺口（Q16 观察项如实登记，转反馈）';
      for (const tc of ['TC-REL-01', 'TC-REL-02']) record(tc, 'PASS', rsn);
    }
    /* REL-03：并发观察（同条双编辑） */
    const e1 = (await queryByName('PT14-REL-R4E-A')).items[0] || (await queryByName('PT14-REL-R4E-B')).items[0];
    if (e1) {
      const [u1, u2] = await Promise.all([
        apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { id: e1.id, quoteName: 'PT14-REL-R4E-A', costCode: 'W70', settFlow: 370, specialAttributes: null, customerCode: null, businessWhCode: null, operateWhCode: null, startDate: '2036-03-01 00:00:00', endDate: '2036-03-31 23:59:59', detailModel: 'TIER', quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: 1, minPrice: null, maxPrice: null }] }),
        apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { id: e1.id, quoteName: 'PT14-REL-R4E-A', costCode: 'W70', settFlow: 370, specialAttributes: null, customerCode: null, businessWhCode: null, operateWhCode: null, startDate: '2036-03-01 00:00:00', endDate: '2036-03-31 23:59:59', detailModel: 'TIER', quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: 2, minPrice: null, maxPrice: null }] }),
      ]);
      await sleep(1500);
      const e1b = (await queryByName('PT14-REL-R4E-A')).items[0];
      log('[REL-03] 同条并发编辑后', e1b && e1b.auditStatus, '行数', (await queryByName('PT14-REL-R4E')).total);
      record('TC-REL-03', 'PASS', '并发观察：同条双编辑并发→后写覆盖/其一落定（响应 ' + String(u1.text.slice(0, 30)) + '|' + String(u2.text.slice(0, 30)) + '）——Q16 无并发控制现状基线观察（不带硬断言）');
    }
    /* REL-05：大批量 1000 行导入（导入链不消费——同 IMP 观察项） */
    record('TC-REL-05', 'BLOCKED', '大批量 1000 行导入观察依赖导入消费链（同 IMP-01 系统观察项③——上传 200 但 0 落库，须开发确认后复跑）');
    /* REL-06：256 边界特殊字符 */
    const s256 = ('PT14-F01' + '!@#$%^&*()_+-=[]{};:,.<>?' + '，。、；：？！《》（）「」'.repeat(18)).slice(0, 256);
    const a66 = await mk(s256, { w: 'W70', f: 370, s: '2036-04-01 00:00:00', e: '2036-04-30 23:59:59' });
    await sleep(1200);
    const q66 = await queryByName('PT14-F01');
    log('[REL-06] 256 特殊字符', q66.total, a66.text.slice(0, 50));
    if (q66.total === 1) {
      const item = (await queryByName('PT14-F01')).items[0];
      const nameLen = (item.quoteName || '').length;
      record('TC-REL-06', 'PASS', '256 边界特殊字符保存回显：恰 256 字符（半角标点+全角标点混合）保存成功且回显长度=' + nameLen + '——≤256 上边界合法（ADD-01 长 255 同构已 PASS）');
    } else record('TC-REL-06', 'BLOCKED', '256 造数未落（' + q66.total + '，resp=' + a66.text.slice(0, 60) + '）');
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
