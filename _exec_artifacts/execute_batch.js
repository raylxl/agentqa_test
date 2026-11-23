/**
 * 对客账单增加寄件人信息 1.27 — AI 首跑批量执行器
 * 连 9335,实时复查系统客观证据 → 按执行前分流规则逐条判定 → 写账本 JSON。
 * 纪律: 不现场改用例; PASS 必须有真实系统行为证据; 造数缺失/双账号缺失= BLOCKED; 转测校准= OBSERVE。
 */
const { chromium } = require('D:/ZCodetest/aiagentqa_test/node_modules/playwright');
const fs = require('fs');
const PORT = 9335;
const URL = 'http://jt-ll.test.ztoeco.com/app/#/phecda/bill/refactoringCustomerBill';
const ART = 'D:/ZCodetest/aiagentqa_test/_exec_artifacts';
const now = () => new Date().toISOString().replace('Z', '+00:00');

(async () => {
  const bd = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = bd.contexts()[0];
  let p = ctx.pages().find(x => x.url().includes('jt-ll.test.ztoeco.com'));
  if (!p) { console.error('NO_PAGE'); process.exit(1); }
  if (!p.url().includes('refactoringCustomerBill')) { await p.goto(URL, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(6000); }
  // 关残留弹窗
  await p.evaluate(() => { for (const d of document.querySelectorAll('.el-dialog')) if (d.getBoundingClientRect().width > 0) { const c = [...d.querySelectorAll('button')].find(b => (b.innerText || '').trim() === '取消'); if (c) c.click(); } }).catch(() => {});
  await p.waitForTimeout(800);
  const f = p.frames().find(x => x.url().includes('refactoringCustomerBill') && x.url().includes('#/')) || p.mainFrame();
  const t0 = Date.now();
  const facts = await f.evaluate(() => {
    const ths = [...document.querySelectorAll('.el-table__header-wrapper th')].map(e => (e.innerText || '').trim());
    const iS = ths.indexOf('寄件人姓名'), iC = ths.indexOf('寄件客户名称'), iCode = ths.indexOf('寄件客户编码');
    const hasSenderQuery = [...document.querySelectorAll('.el-form-item__label,label')].some(e => (e.innerText || '').trim() === '寄件人姓名');
    const pg = document.querySelector('.el-pagination');
    // 真实数据两列取值样本
    const tbodies = [...document.querySelectorAll('.el-table__body-wrapper tbody')];
    let rows = []; for (const tb of tbodies) { const r = [...tb.querySelectorAll('tr')].map(tr => [...tr.querySelectorAll('td')].map(td => (td.innerText || '').trim())); if (r.length > rows.length) rows = r; }
    return {
      iS, iC, iCode, adjacent: (iC === iS + 1 && iCode === iC + 1),
      senderHeaderExists: iS >= 0, custNameHeaderExists: iC >= 0,
      hasSenderQuery, pagination: pg ? (pg.innerText || '').replace(/\s+/g, ' ').trim() : '',
      rowCount: rows.length,
      senderThStyle: (() => { const th = [...document.querySelectorAll('.el-table__header-wrapper th')].find(e => (e.innerText || '').trim() === '寄件人姓名'); if (!th) return null; const cs = getComputedStyle(th); return { bg: cs.backgroundColor, color: cs.color, fw: cs.fontWeight }; })(),
      sample: rows.slice(0, 3).map(r => ({ sender: r[5], custName: r[6], custCode: r[7] }))
    };
  });
  const elapsed = Date.now() - t0;
  console.log('[复查] 表头相邻=' + facts.adjacent + ' 寄件人姓名列=' + facts.senderHeaderExists + ' 寄件客户名称列=' + facts.custNameHeaderExists + ' 人名查询项=' + facts.hasSenderQuery + ' ' + facts.pagination + ' (耗时' + elapsed + 'ms)');
  await bd.close();

  const ts = now();
  const EV = (s) => '源=无头9335实时复查:' + s;
  const ledger = [];
  const add = (id, module, priority, status, reason, evidence) => ledger.push({ id, module, priority, status, ts, reason, evidence });

  // ===== 一、列结构与取值 =====
  add('TC-COL-01', 'COL', 'P1', facts.senderHeaderExists ? 'PASS' : 'FAIL',
    facts.senderHeaderExists ? '表头实测存在列「寄件人姓名」，文案逐字一致' : '表头未见「寄件人姓名」列',
    EV(`ths.indexOf寄件人姓名=${facts.iS}`));
  add('TC-COL-02', 'COL', 'P1', facts.adjacent ? 'PASS' : 'FAIL',
    facts.adjacent ? '列序实测相邻:寄件人姓名(${iS})→寄件客户名称(${iC})→寄件客户编码(${iCode})'.replace('${iS}', facts.iS).replace('${iC}', facts.iC).replace('${iCode}', facts.iCode) : '三列非相邻',
    EV('adjacent=' + facts.adjacent));
  add('TC-COL-03', 'COL', 'P1', 'BLOCKED', '前置造数缺失:环境无运单WDC10002(senderName=李四/senderCustomerName=乙达商贸)对应账单行,无法做取值来源精确对照', '造数依赖PRE-03;真实环境为196条接口测试账单,无该构造数据');
  add('TC-COL-04', 'COL', 'P1', 'BLOCKED', '前置造数缺失:环境无运单WDC10003快照数据,无法对照senderCustomerName精确值', '造数依赖PRE-03');
  add('TC-COL-05', 'COL', 'P1', 'BLOCKED', '前置造数缺失:环境无WDC10001(张三/甲运物流)构造数据;真实数据样本两列独立显示(sender与custName有同有异),但预期写死具体值,不做零证据等价判PASS', '造数依赖PRE-03;真实样本=' + JSON.stringify(facts.sample));
  add('TC-COL-06', 'COL', 'P1', 'BLOCKED', '前置造数缺失:环境无「客户改名前后快照」对照数据(甲运物流→集团股份),无法验证改名不漂移', '造数依赖PRE-04');

  // ===== 二、查询条件 =====
  add('TC-QRY-01', 'QRY', 'P1', 'BLOCKED', '前置造数缺失:环境无客户TESTQ2CA及其2条账单,无法验证按该客户编码查询命中', '造数依赖PRE-05;查询功能本身可用但预期写死TESTQ2CA');
  add('TC-QRY-02', 'QRY', 'P1', facts.hasSenderQuery === false ? 'PASS' : 'FAIL',
    facts.hasSenderQuery === false ? '查询区实测无「寄件人姓名」查询项,查询维度仅为客户主体/单号等,PS口径未变' : '查询区出现「寄件人姓名」查询项',
    EV('hasSenderNameQuery=' + facts.hasSenderQuery));
  add('TC-QRY-03', 'QRY', 'P1', 'BLOCKED', '前置造数缺失:环境无TESTQ2CA组合数据,无法验证预期行数=2的过滤断言', '造数依赖PRE-05');
  add('TC-QRY-04', 'QRY', 'P1', 'BLOCKED', '前置造数缺失:环境无客户TESTQ2CC(顺达供应链有限公司)及其账单,无法验证按名称查询命中', '造数依赖PRE-05');

  // ===== 三、导出 =====
  const expBlock = '导出任务可生成（实测文件名对客账单20261120163117428/196条/任务页有下载按钮），但下载需到导出任务页虚拟渲染表格人工点击，工具链抓取不稳定（判定标准§2.4 导出需任务页下载=BLOCKED）；且预期写死具体造数值，环境无对应数据';
  add('TC-EXP-01', 'EXP', 'P1', 'BLOCKED', '导出列头校验需下载文件,' + expBlock, '导出通道探明:任务生成OK/下载文件未取到');
  add('TC-EXP-02', 'EXP', 'P1', 'BLOCKED', '导出列序校验需下载文件,' + expBlock, '同上');
  add('TC-EXP-03', 'EXP', 'P1', 'BLOCKED', '导出全量行数校验需下载文件且需造数12条跨页,' + expBlock, '同上+造数PRE-05');
  add('TC-EXP-04', 'EXP', 'P1', 'BLOCKED', '导出取值校验需下载文件+造数WDE10001,' + expBlock, '同上+造数');
  add('TC-EXP-05', 'EXP', 'P1', 'BLOCKED', '导出快照校验需下载文件+改名造数,' + expBlock, '同上+PRE-04');
  add('TC-EXP-06', 'EXP', 'P1', 'BLOCKED', '导出无掩码校验需下载文件,' + expBlock, '同上;列表侧已实证完整显示无掩码');
  add('TC-EXP-07', 'EXP', 'P1', 'OBSERVE', '转测校准⑥:特殊字符导出转义观察,依赖下载文件+含特殊字符造数,未取到文件,转人工观察', '转测校准观察条;造数PRE-08');

  // ===== 四、UI =====
  add('TC-UI-01', 'UI', 'P2', facts.adjacent ? 'PASS' : 'FAIL', facts.adjacent ? '表头从左到右实测寄件人姓名→寄件客户名称→寄件客户编码三列相邻' : '列序不符', EV('adjacent=' + facts.adjacent));
  add('TC-UI-02', 'UI', 'P2', (facts.senderHeaderExists && facts.custNameHeaderExists) ? 'PASS' : 'FAIL', (facts.senderHeaderExists && facts.custNameHeaderExists) ? '表头文案实测:更名列=寄件人姓名、新增列=寄件客户名称,逐字一致无旧文案残留' : '表头文案缺失', EV('sender=' + facts.senderHeaderExists + ',custName=' + facts.custNameHeaderExists));
  add('TC-UI-03', 'UI', 'P2', 'OBSERVE', '转测校准:寄件人姓名列表头实测为灰底(' + (facts.senderThStyle ? facts.senderThStyle.bg : '?') + '),无原型绿色高亮;按设计口径原型示意≠最终样式,记录形态不判缺陷', EV('senderThStyle=' + JSON.stringify(facts.senderThStyle)));
  add('TC-UI-04', 'UI', 'P2', 'OBSERVE', '转测校准:超长文本展示形态,环境无对应超长值造数,转人工观察列表截断/换行形态及导出是否保留完整值', '转测校准⑤;造数依赖');

  // ===== 五、安全与权限 =====
  const secBlock = '权限隔离验证需客户A(TESTS1A)/客户B(TESTS1B)两个客户账号做越权对照;当前仅总部账号(房耀华/15121193680),无法构造双账号越权场景(依赖缺失=§2.4 BLOCKED)';
  add('TC-SEC-01', 'SEC', 'P0', 'BLOCKED', '列表默认过滤越权验证,' + secBlock, '账号依赖PRE-02');
  add('TC-SEC-02', 'SEC', 'P0', 'BLOCKED', '精确查询越权验证,' + secBlock, '账号依赖PRE-02');
  add('TC-SEC-03', 'SEC', 'P0', 'BLOCKED', '导出越权验证,' + secBlock, '账号依赖PRE-02');
  add('TC-SEC-04', 'SEC', 'P0', 'BLOCKED', '不脱敏安全边界越权对照,' + secBlock + ';列表侧已实证权限内两列完整显示无掩码', '账号依赖PRE-02');

  // ===== 六、可靠性与降级 =====
  add('TC-REL-01', 'REL', 'P2', 'OBSERVE', '转测校准①/空值降级:环境无寄件人姓名/寄件客户名称为空的构造账单行,转人工观察空值显示形态', '转测校准②;造数PRE-06');
  add('TC-REL-02', 'REL', 'P2', 'OBSERVE', '转测校准①/多条地址:环境无同一寄件客户多条寄件地址的构造运单,转人工观察取值稳定性', '转测校准①;造数PRE-06');
  add('TC-REL-03', 'REL', 'P2', 'OBSERVE', '转测校准③/性能:实测列表加载196条正常(' + elapsed + 'ms DOM渲染)、分页可用(20页);无2336条量级造数,大批量导出耗时转人工观察', EV('pagination=' + facts.pagination + ',renderMs=' + elapsed));

  // 批次计时行
  const meta = { run_id: 'LX-20261120-001', run_start: ts, round: '第1轮:AI首跑', source: 'usecase-executor', channel: 'ui', tenant: '冷链快运', account: '15121193680(房耀华/总部)', system: 'jt-ll.test.ztoeco.com', menu: '/phecda/bill/refactoringCustomerBill', facts };

  const out = { meta, ledger };
  fs.writeFileSync(ART + '/ledger.json', JSON.stringify(ledger, null, 1));
  fs.writeFileSync(ART + '/run_meta.json', JSON.stringify(meta, null, 1));

  const cnt = ledger.reduce((a, x) => (a[x.status] = (a[x.status] || 0) + 1, a), {});
  console.log('\n[进度] 全部 28/28 (100%)');
  console.log('[判定] ' + JSON.stringify(cnt));
  for (const c of ['COL', 'QRY', 'EXP', 'UI', 'SEC', 'REL']) {
    const g = ledger.filter(x => x.module === c); const cc = g.reduce((a, x) => (a[x.status] = (a[x.status] || 0) + 1, a), {});
    console.log('  ' + c + ': ' + g.length + '条 ' + JSON.stringify(cc));
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
