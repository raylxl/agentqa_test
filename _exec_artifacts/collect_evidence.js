/**
 * 对客账单增加寄件人信息 — AI 首跑证据采集器
 * 连无头实例 9335，打开对客账单，采集客观证据（表头/列序/数据行/查询区/高亮/分页）。
 * 只读页面、不改数据。输出 JSON 到 stdout（含 EVID_START/EVID_END 包裹）。
 */
const { chromium } = require('D:/ZCodetest/aiagentqa_test/node_modules/playwright');
const PORT = 9335;
const URL = 'http://jt-ll.test.ztoeco.com/app/#/phecda/bill/refactoringCustomerBill';

(async () => {
  const bd = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = bd.contexts()[0];
  let p = ctx.pages().find(x => x.url().includes('jt-ll.test.ztoeco.com'));
  if (!p) { console.log('NO_PAGE'); process.exit(0); }

  // 确保在账单页
  if (!p.url().includes('refactoringCustomerBill')) {
    await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await p.waitForTimeout(6000);
  }
  // 关闭可能残留的导出确认弹窗
  await p.evaluate(() => {
    for (const d of document.querySelectorAll('.el-dialog')) {
      if (d.getBoundingClientRect().width > 0) {
        const cancel = [...d.querySelectorAll('button')].find(b => (b.innerText || '').trim() === '取消');
        if (cancel) cancel.click();
      }
    }
  }).catch(() => {});
  await p.waitForTimeout(800);

  const f = p.frames().find(x => x.url().includes('refactoringCustomerBill') && x.url().includes('#/')) || p.mainFrame();

  // 触发一次查询，确保列表有数据（默认已加载，这里仅等待渲染）
  await p.waitForTimeout(1500);

  const ev = await f.evaluate(() => {
    const out = {};
    // 主表头（data 子表头行，含寄件人姓名那一行）
    const allTh = [...document.querySelectorAll('.el-table__header-wrapper th')].map(e => (e.innerText || '').trim());
    out.allHeaders = allTh;
    // 定位含"寄件人姓名"的表头块（可能有多级表头，取包含它的那一组连续 th）
    const idxSender = allTh.indexOf('寄件人姓名');
    const idxCustName = allTh.indexOf('寄件客户名称');
    const idxCustCode = allTh.indexOf('寄件客户编码');
    out.keyCols = { senderName: idxSender, custName: idxCustName, custCode: idxCustCode,
      adjacent: (idxCustName === idxSender + 1 && idxCustCode === idxCustName + 1) };

    // 数据行：主表体。el-table 可能固定列+主表分开，取行数最多的 tbody
    const tbodies = [...document.querySelectorAll('.el-table__body-wrapper tbody')];
    let rows = [];
    for (const tb of tbodies) {
      const r = [...tb.querySelectorAll('tr')].map(tr => [...tr.querySelectorAll('td')].map(td => (td.innerText || '').trim()));
      if (r.length > rows.length) rows = r;
    }
    out.rowCount = rows.length;
    // 表头与数据列对齐（本表头即data列，无固定列偏移时直接对齐）
    out.rowsSample = rows.slice(0, 12).map((r, i) => ({ i, cells: r.slice(0, 20) }));

    // 查询区标签/占位
    out.formLabels = [...new Set([...document.querySelectorAll('.el-form-item__label,label')].map(e => (e.innerText || '').trim()).filter(Boolean))];
    out.queryInputs = [...document.querySelectorAll('input,textarea')].map(e => ({ ph: e.placeholder || '', val: e.value || '' })).filter(x => x.ph);
    // 寄件客户查询控件形态：下拉还是文本
    const jian = [...document.querySelectorAll('.el-form-item')].find(e => (e.innerText || '').includes('寄件客户'));
    out.jianCustomerControl = jian ? jian.innerText.trim().slice(0, 120) : '(未见寄件客户查询项)';

    // 是否有"寄件人姓名"作为查询项（QRY-02 反向确认）
    out.hasSenderNameQuery = [...document.querySelectorAll('.el-form-item__label,label')].some(e => (e.innerText || '').trim() === '寄件人姓名');

    // 分页
    const pg = document.querySelector('.el-pagination');
    out.pagination = pg ? (pg.innerText || '').trim() : '(无分页)';

    // 寄件人姓名列表头高亮形态（UI-03 观察）：取该 th 的 class 和计算样式
    const senderTh = allTh.length ? [...document.querySelectorAll('.el-table__header-wrapper th')].find(e => (e.innerText || '').trim() === '寄件人姓名') : null;
    if (senderTh) {
      const cs = getComputedStyle(senderTh);
      out.senderThStyle = { className: senderTh.className, bg: cs.backgroundColor, color: cs.color, fontWeight: cs.fontWeight };
    } else out.senderThStyle = null;

    // 完整 body 文本（备查）
    out.bodyHead = (document.body.innerText || '').trim().slice(0, 1600);
    return out;
  });

  console.log('===EVID_START===');
  console.log(JSON.stringify(ev, null, 1));
  console.log('===EVID_END===');
  await bd.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
