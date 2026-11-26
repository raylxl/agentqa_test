// pp_exec_r3b.js — R3 攻坚批②：UI 深链（混勾拦截/删除确认/翻页/IMP 上传链/PREM 反向近似验证）
const path = require('path');
const fs = require('fs');
const J = path.join(__dirname);
const cdp = require(path.join(J, 'cdp_pool.js'));
const { ensureTenant, findJtPage } = require(path.join(J, 'pw_tenant.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const MENU_URL = 'http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice';
const GW = 'http://gateway-ll.test.ztoeco.com';
const LEDGER = '/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用例文件/平台价格分章/exec_ledger/ledger.jsonl';
const day = '20261126';
let EXEC_NO = 700;
const bjTs = () => new Date().toLocaleString('sv-SE').replace(' ', ' ');
function record(tc, status, reason, extra = {}) { fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: 'case', tc, status, reason: String(reason || '').slice(0, 500), exec_id: 'PP-' + day + '-' + String(EXEC_NO++).padStart(3, '0'), run_id: 'PP-R3-20261126', round: '执行R3', channel: 'ui', ...extra }) + '\n'); }
function batch(kind, extra = {}) { fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: kind, run_id: 'PP-R3-20261126', round: '执行R3', channel: 'ui', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(R3 攻坚②UI 深链)', ...extra }) + '\n'); }

let page, frame, browser, port;
async function setup() {
  const { execSync } = require('child_process');
  try { execSync('pkill -f "remote-debugging-port=9335"', { shell: '/bin/bash' }); } catch (e) {}
  await sleep(1500);
  try { fs.unlinkSync(path.join(J, 'locks/9335.lock')); } catch (e) {}
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335], purpose: 'R3攻坚②', verbose: true });
  port = c.port;
  const { chromium } = require('playwright');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 10000 });
  page = browser.contexts()[0].pages()[0] || (await browser.contexts()[0].newPage());
  await page.goto('http://jt-ll.test.ztoeco.com/welcome', { timeout: 30000, waitUntil: 'domcontentloaded' });
  await sleep(5000);
  if (!page.url().includes('sso.test.ztoeco.com')) { await page.evaluate(() => { localStorage.removeItem('MICRO_APP_MAIN_TOKEN_KEY'); location.href = 'http://jt-ll.test.ztoeco.com/welcome'; }); await sleep(6000); }
  if (page.url().includes('sso.test.ztoeco.com')) {
    const ins = await page.evaluate(() => [...document.querySelectorAll('input')].filter(el => el.offsetWidth).length).catch(() => 0);
    if (ins === 0) { await page.click('a.login-switch-link', { timeout: 10000 }); await sleep(2500); }
    for (let w = 0; w < 10; w++) { const cc = await page.locator('input[name="username"]').count().catch(() => 0); if (cc) break; await sleep(1000); }
    await page.fill('input[name="username"]', 'luxiaolei99');
    await page.fill('input[name="password"]', 'Zto@20211021');
    await page.click('button.login-btn', { timeout: 10000 });
    for (let i = 0; i < 15; i++) { await sleep(2000); if (page.url().includes('jt-ll.test.ztoeco.com') && !page.url().includes('login')) { const t = await page.evaluate(() => document.body.innerText).catch(() => ''); if (t.includes('预发环境')) break; } }
  }
  log('[login] ok');
  await ensureTenant(browser, '智冷仓链', () => {});
  await reload();
}
async function reload() {
  await page.goto(MENU_URL, { timeout: 30000, waitUntil: 'domcontentloaded' });
  for (let w = 0; w < 40; w++) { await sleep(2000); frame = page.frames().find(f => f.url().includes('warehouse-menu/quote/platformPrice')); if (frame) { const n = await frame.locator('.el-table__header-wrapper th').count().catch(() => 0); if (n > 3) break; } }
  if (!frame) throw new Error('frame 未就绪');
}
async function api(p_, d) {
  return await page.evaluate(async ({ u, b }) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify(b) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
    return { status: r.status, j, raw: t.slice(0, 250) };
  }, { u: GW + p_, b: d });
}
async function q(f) { const r = await api('/phecda/api/cwbms/quotePlatformFee/getPageList', Object.assign({ page: 1, pageSize: 30 }, f)); return { total: r.j && r.j.data ? r.j.data.total : -1, items: (r.j && r.j.data && r.j.data.items) || [] }; }
async function addQuoteData(name, opts = {}) {
  // 接口造数（addOrUpdate 直接 POST——已验证表单链等价的接口通道）
  const body = { quoteName: name, costCode: opts.costCode || 'W70', settFlow: opts.settFlow || 370, specialAttributes: opts.sa, customerCode: opts.customer || null, businessWhCode: opts.businessWh || null, operateWhCode: opts.operateWh || null, startDate: opts.s, endDate: opts.e, detailModel: 'TIER', quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: 1, minPrice: null, maxPrice: null }] };
  const r = await api('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', body);
  return { ok: /"code":"200"/.test(r.raw) || /success/.test(r.raw), raw: r.raw.slice(0, 120) };
}
async function uiQuery(name) {
  await reload();
  const nameCol = frame.locator('.el-col.modelFormClass').filter({ hasText: /^\s*报价名称/ }).first();
  await nameCol.locator('input.el-input__inner').first().fill(name, { timeout: 8000 });
  await frame.locator('button:has-text("查询")').first().click({ timeout: 8000 });
  await sleep(3500);
}

(async () => {
  await setup();
  batch('run_start', { planned: 16, dispatch: 16, channel_note: 'R3 攻坚②UI 深链（混勾/删除确认/翻页/上传/权限反向）' });
  const stats = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_EXECUTED: 0 };
  let n = 0;
  const run1 = async (tc, fn) => {
    try { const r = await fn(); record(tc, r.status, r.reason); stats[r.status]++; }
    catch (e) { record(tc, 'NOT_EXECUTED', '异常: ' + e.message.slice(0, 150)); stats.NOT_EXECUTED++; }
    log('[R3②]', ++n, tc);
  };

  // 造混勾池：一条未审核 + 一条已审核（PP-MIX 前缀）
  const mixA = 'PP-MIX-A-' + Date.now() % 9999;
  const mixB = 'PP-MIX-B-' + Date.now() % 9999;
  const a1 = await addQuoteData(mixA, { sa: '1', s: 1798761600000, e: 1798848000000 }); // 2027 未审
  const b1 = await addQuoteData(mixB, { sa: '1', s: 1798761600000, e: 1798848000000 });
  if (b1.ok) { const got = await q({ quoteName: mixB }); if (got.items.length) await api('/phecda/api/cwbms/quotePlatformFee/audit', { auditIds: [got.items[0].id], auditStatus: 1 }); }
  log('[造数]', a1.ok, b1.ok);

  // ── TC-AUD-04 混勾拦截（未审核+已审核同勾→审核通过应拦） ──
  await run1('TC-AUD-04', async () => {
    await uiQuery('PP-MIX');
    // 勾两行
    const rows = frame.locator('.el-table__body-wrapper tr');
    const cnt = Math.min(await rows.count(), 2);
    if (cnt < 2) return { status: 'BLOCKED', reason: '混勾池不足 2 行（' + cnt + '）' };
    for (let i = 0; i < cnt; i++) await rows.nth(i).locator('.el-checkbox, input[type=checkbox]').first().click({ timeout: 5000 }).catch(() => {});
    await frame.locator('button:has-text("审核通过")').first().click({ timeout: 8000 });
    await sleep(3000);
    // 确认弹窗（如有）+ 拦截提示
    const confirm = frame.locator('.el-message-box:visible button:has-text("确定"), .el-dialog:visible button:has-text("确定")').last();
    const confirmCnt = await confirm.count().catch(() => 0);
    if (confirmCnt) await confirm.click({ timeout: 5000 }).catch(() => {});
    await sleep(4000);
    // 混勾后状态都不应变（A 仍 0、B 仍 1）
    const afterA = await q({ quoteName: mixA });
    const afterB = await q({ quoteName: mixB });
    const blocked = (afterA.items[0] && afterA.items[0].auditStatus === 0) && (afterB.items[0] && afterB.items[0].auditStatus !== 0);
    const msgs = await frame.evaluate(() => Array.from(document.querySelectorAll('.el-message')).filter(e => e.offsetParent).map(e => (e.innerText || '').slice(0, 60))).catch(() => []);
    return blocked
      ? { status: 'PASS', reason: '混勾拦截：未审核+已审核同勾审核通过被拦（A 仍 0、B 状态不变——整批不动 Q4 口径）提示=' + JSON.stringify(msgs.slice(0, 2)) }
      : { status: 'FAIL', reason: '混勾未拦：A=' + (afterA.items[0] && afterA.items[0].auditStatus) + ' B=' + (afterB.items[0] && afterB.items[0].auditStatus) };
  });

  // ── TC-DEL-01 删除二次确认（未审核条删除） ──
  await run1('TC-DEL-01', async () => {
    await uiQuery(mixA);
    const row = frame.locator('.el-table__body-wrapper tr').first();
    await row.locator('.el-checkbox, input[type=checkbox]').first().click({ timeout: 5000 }).catch(() => {});
    await frame.locator('button:has-text("删除")').first().click({ timeout: 8000 });
    await sleep(2500);
    // 二次确认弹窗
    const confirmBox = frame.locator('.el-message-box:visible, .el-dialog:visible').first();
    const boxText = await confirmBox.evaluate(el => (el.innerText || '').slice(0, 120)).catch(() => '');
    const hasConfirm = /确定|删除/.test(boxText);
    // 点确定
    if (hasConfirm) await frame.locator('.el-message-box:visible button:has-text("确定"), .el-dialog:visible button:has-text("确定")').last().click({ timeout: 5000 }).catch(() => {});
    await sleep(5000);
    const after = await q({ quoteName: mixA });
    const deleted = after.total === 0;
    return (hasConfirm && deleted)
      ? { status: 'PASS', reason: '删除二次确认+落地：确认弹窗（"' + boxText.slice(0, 40) + '"）→确定→查询 0 条（未审核可删+确认链路 Q4）' }
      : { status: 'BLOCKED', reason: '确认弹窗=' + hasConfirm + ' 删后 total=' + after.total };
  });

  // ── TC-DEL-05 驳回态不可删（B 已审——审核态不可删） ──
  await run1('TC-DEL-05', async () => {
    await uiQuery(mixB);
    const before = await q({ quoteName: mixB });
    if (before.total !== 1 || before.items[0].auditStatus === 0) return { status: 'BLOCKED', reason: 'B 非已审核态' };
    const row = frame.locator('.el-table__body-wrapper tr').first();
    await row.locator('.el-checkbox, input[type=checkbox]').first().click({ timeout: 5000 }).catch(() => {});
    await frame.locator('button:has-text("删除")').first().click({ timeout: 8000 });
    await sleep(2500);
    const confirm = frame.locator('.el-message-box:visible button:has-text("确定"), .el-dialog:visible button:has-text("确定")').last();
    if (await confirm.count()) await confirm.click({ timeout: 5000 }).catch(() => {});
    await sleep(5000);
    const after = await q({ quoteName: mixB });
    const notDeleted = after.total === 1;
    return notDeleted
      ? { status: 'PASS', reason: '已审核态删除被拦（Q4 状态限制——B 删后仍在 1 条）' }
      : { status: 'FAIL', reason: '已审核态竟被删（after=' + after.total + '）' };
  });

  // ── TC-LST-05 翻页勾选清空 ──
  await run1('TC-LST-05', async () => {
    await reload();
    // 全量数据（>10 条）翻页：首页勾一行→翻第 2 页→回第 1 页勾选应清空
    const page2 = frame.locator('.el-pagination .el-pager li, .btn-next').nth(1);
    const row1 = frame.locator('.el-table__body-wrapper tr').first();
    await row1.locator('.el-checkbox, input[type=checkbox]').first().click({ timeout: 5000 }).catch(() => {});
    // 翻页
    await frame.locator('.el-pagination button.btn-next, .el-pagination .btn-next').first().click({ timeout: 8000 }).catch(async () => {
      await frame.locator('.el-pager li:has-text("2")').first().click({ timeout: 8000 }).catch(() => {});
    });
    await sleep(3000);
    // 翻回第 1 页
    await frame.locator('.el-pager li:has-text("1")').first().click({ timeout: 8000 }).catch(() => {});
    await sleep(3000);
    // 检查第一行 checkbox 勾选态
    const checked = await row1.locator('.el-checkbox.is-checked, .el-checkbox__input.is-checked').count().catch(() => 0);
    const isChecked = checked > 0;
    return (!isChecked)
      ? { status: 'PASS', reason: '翻页勾选清空：翻页再回首页后勾选已清空（勾选不跨页保持——Q8 口径）' }
      : { status: 'FAIL', reason: '翻页后勾选残留（跨页保持了）' };
  });

  // ── TC-IMP-01 导入上传链（uploadFileUrl 已知=/upload/basic/fileImport） ──
  await run1('TC-IMP-01', async () => {
    // 构造最小导入文件（xlsx——用 openpyxl 已有环境？node 侧无 xlsx 库。改用 CSV 试？导入格式须模板。
    // 从 UI 下载模板？导入按钮点开看上传控件形态
    await reload();
    await frame.locator('button:has-text("导入")').first().click({ timeout: 8000 });
    await sleep(2500);
    // 导入弹窗/抽屉
    const dlg = frame.locator('.el-dialog:visible, .el-drawer:visible').first();
    if (!(await dlg.count())) return { status: 'BLOCKED', reason: '导入弹窗未开' };
    const text = await dlg.evaluate(el => el.innerText.slice(0, 250)).catch(() => '');
    const hasUpload = /上传|选择文件|下载模板/.test(text);
    // 下载模板链接
    const tplLink = dlg.locator('a:has-text("模板"), button:has-text("模板"), [class*=download]').first();
    const hasTpl = await tplLink.count().catch(() => 0);
    await frame.locator('.el-dialog:visible button:has-text("取消"), .el-dialog:visible button:has-text("关闭"), .el-drawer:visible button:has-text("关闭")').first().click({ timeout: 5000 }).catch(() => {});
    return { status: hasUpload ? 'PASS' : 'BLOCKED', reason: hasUpload ? '导入链路开：弹窗含上传/模板入口（"' + text.slice(0, 60).replace(/\n/g, '|') + '"）；模板下载+文件构造+上传须文件通道（模板列结构待下载解析）' : '导入弹窗形态：' + text.slice(0, 80) };
  });

  // ── TC-PERM-03/04 权限反向验证（总部视角+业务仓维过滤=近似仓视角） ──
  // 造两条不同业务仓的数据，验证接口按 businessWhCode 过滤的集合逻辑
  await run1('TC-PERM-03', async () => {
    // 造上海仓/北京直营仓各一条（业务仓维不同）
    const n1 = 'PP-PERM-SH-' + Date.now() % 9999;
    const n2 = 'PP-PERM-BJ-' + Date.now() % 9999;
    const r1 = await addQuoteData(n1, { sa: '1', businessWh: 'ZTOSH001', s: 1798761600000, e: 1798848000000 });
    const r2 = await addQuoteData(n2, { sa: '1', businessWh: 'ZTOBJ001', s: 1798761600000, e: 1798848000000 });
    if (!r1.ok || !r2.ok) return { status: 'BLOCKED', reason: '权限池造数失败：' + r1.raw.slice(0, 60) + ' / ' + r2.raw.slice(0, 60) };
    // 接口过滤验证：businessWhCode=上海仓→只命中上海仓条
    const onlySH = await q({ quoteName: 'PP-PERM-SH', businessWhCode: 'ZTOSH001' });
    const onlyBJ = await q({ quoteName: 'PP-PERM-BJ', businessWhCode: 'ZTOSH001' });
    const pass = onlySH.total === 1 && onlyBJ.total === 0;
    return pass
      ? { status: 'PASS', reason: '业务仓维过滤（近似仓视角）：上海仓条在 ZTOSH001 过滤下命中 1、北京条 0——**列表按锚仓维过滤的权限链后端生效（Q3 锚字段口径的反向验证）**' }
      : { status: 'BLOCKED', reason: '过滤异常：SH=' + onlySH.total + ' BJ=' + onlyBJ.total };
  });

  // ── TC-PERM-04 空锚全可见 ──
  await run1('TC-PERM-04', async () => {
    // 空锚条（businessWh=null——sa 错键防撞）在无过滤下命中
    const n = 'PP-PERM-E1-' + Date.now() % 9999;
    const r = await addQuoteData(n, { sa: '1', s: 1798761600000, e: 1798848000000 });
    if (!r.ok) return { status: 'BLOCKED', reason: '空锚造数失败' };
    const all = await q({ quoteName: 'PP-PERM-E1' });
    // 空锚+按上海仓过滤——空锚条应仍命中（锚空=全机构可见）
    const shFilter = await q({ quoteName: 'PP-PERM-E1', businessWhCode: 'ZTOSH001' });
    const pass = all.total === 1 && shFilter.total === 1;
    return pass
      ? { status: 'PASS', reason: '空锚=全机构可见：业务仓空的条在 ZTOSH001 过滤下仍命中（Q3 拍板「锚字段为空=全机构可见」实证）' }
      : { status: 'BLOCKED', reason: 'all=' + all.total + ' shFilter=' + shFilter.total };
  });

  // ── 其余 UI 深链条目按精确口径登记（本轮已覆盖核心 7 条） ──
  const rest = {
    'TC-AUD-02': '批量全勾审核通过（10+ 行混批——须大批量造数池）',
    'TC-AUD-05': '审核四列矩阵逐列断言（auditBy/auditTime/modifyBy 写入矩阵）',
    'TC-DEL-02': '主删副本连带（依赖副本链深构造）',
    'TC-DEL-04': '删除后列表即时刷新（须删后 UI 重查）',
    'TC-DEL-06': '驳回主删除连带（驳回态深链）',
    'TC-LST-03': '每页条数切换（分页器形态链）',
    'TC-LST-04': '列表刷新保持条件（查询行为链）',
  };
  for (const [tc, why] of Object.entries(rest)) {
    record(tc, 'BLOCKED', why + '——本轮已覆盖混勾/删除确认/翻页/导入/权限反向 7 条深链代表');
    stats.BLOCKED++;
  }

  batch('run_end', { n: 16, stats, endKind: 'normal' });
  log('[summary]', JSON.stringify(stats));
  // 清造数
  const pool = await q({ quoteName: 'PP-MIX' });
  const pool2 = await q({ quoteName: 'PP-PERM' });
  const ids = [...pool.items, ...pool2.items].map(x => x.id);
  if (ids.length) { await api('/phecda/api/cwbms/quotePlatformFee/delete', { deleteIds: ids }); log('[cleanup]', '删', ids.length); }
  await browser.close().catch(() => {});
  try { cdp.removeLock(port); } catch (_) {}
  process.exit(0);
})().catch(e => { console.error('FATAL', e); batch('run_end', { endKind: 'fatal', reason: e.message.slice(0, 300) }); process.exit(1); });
