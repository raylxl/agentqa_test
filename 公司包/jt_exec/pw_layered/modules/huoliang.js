/**
 * 货量考核政策维护 · 配方层（modules/huoliang）
 * 2026-11-09 跨菜单泛化重构：从 helpers.js 按行原样拆出（代码零改写）；框架通用件（sleep/ts/realClick/dismissPoppers/抽屉开菜单）移至 lib/jt_common.js
 * 原 helpers 版本史：v2 首跑回流自愈（列表查询框多策略/机构打字过滤/日期面板直选）→ 查询先重置+政策名称框定位 → 单条循环删除+数量闸 → 清空/接口直查
 * 接入事实：租户=冷链快运；入口=SPA 直连（菜单链 冷链财务管理/新报价管理/货量考核政策维护）；新增弹窗标识=input[placeholder*="政策名称"]
 */
const { sleep, p2, ts, realClick, dismissPoppers } = require('../lib/jt_common');

const MODULE = {
  key: 'huoliang',
  name: '货量考核政策维护',
  tenant: '冷链快运',
  entry: { spa: 'http://jt-ll.test.ztoeco.com/#/phecda/quote/quantityPolicy', menu: { column: '冷链财务管理', name: '货量考核政策维护' } },
  dialogMarker: 'input[placeholder*="政策名称"]',
  listApi: 'http://gateway-ll.test.ztoeco.com/phecda/api/phecda/queryPolicyAssessmentList',
};

// 明细行 7 个数字框（重量维度）上下限=控件 aria-valuemin/max（diag10 实测，坑库 H6）；超限静默钳制到 max
// api 字段仅列已实证映射（TC_017→exemptionPackAssessment / TC_018→totalVolumeAssessment）
const NUM_FIELDS = [
  { i: 0, label: '重量段·开始', min: 0, max: 999999.99 },
  { i: 1, label: '重量段·结束', min: 0, max: 999999.99 },
  { i: 2, label: '仓位免考核量（kg/天）', api: 'exemptionPackAssessment', min: 0, max: 99999999 },
  { i: 3, label: '总仓位考核量（kg/天）', min: 0, max: 99999999 },
  { i: 4, label: '仓位考核单价（元/kg）', min: 0, max: 99999999.99 },
  { i: 5, label: '总货量考核量（kg/天）', api: 'totalVolumeAssessment', min: 0, max: 99999999 },
  { i: 6, label: '货量考核单价（元/kg）', min: 0, max: 99999999.99 },
];

const POLICY_URL = 'http://jt-ll.test.ztoeco.com/#/phecda/quote/quantityPolicy';

// v3（2026-11-09 全池回归：两次「业务页未就绪」——一次零网络请求（应用未启动）、一次接口已调用但 20s 内无「新增」）
// 坑库 G11/E2：SPA 偶发卡「资源加载中」→ 自愈=强刷重试；最多 3 次（直达→强刷→重新导航），失败时记录页面文字供定性
async function openPolicyPage(page, log) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt === 2) {
      log('业务页未就绪 → 强刷重试（坑库 G11/E2）');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    } else {
      if (attempt === 3) log('强刷后仍未就绪 → 重新导航');
      await page.goto(POLICY_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }
    await sleep(5000);
    await page.bringToFront().catch(() => {}); // 防后台节流（run_eval 配方）
    for (let i = 0; i < 10; i++) {
      try {
        if (await page.evaluate(() => [...document.querySelectorAll('button')].some(b => (b.offsetParent || b.getClientRects().length) && b.textContent.trim() === '新增'))) {
          log(`业务页就绪（SPA 直连${attempt > 1 ? '·第' + attempt + '次' : ''}）`);
          return true;
        }
      } catch (_) {}
      await sleep(1500);
    }
    const snap = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 80)).catch(() => '(读取失败)');
    log(`!! 第${attempt}次未就绪，页面文字=[${snap}]`);
  }
  return false;
}

async function openAddDialog(page, log) {
  const findDlg = () => page.evaluate(() => {
    const vis = el => !!(el.offsetParent || el.getClientRects().length);
    const cands = [...document.querySelectorAll('.el-dialog, .el-overlay')].filter(el => vis(el) && el.textContent.includes('政策名称') && el.querySelector('input[placeholder*="政策名称"]'));
    const dlg = cands.sort((a, b) => b.querySelectorAll('input').length - a.querySelectorAll('input').length)[0];
    return { found: !!dlg, n: cands.length };
  });
  let dlg = await findDlg();
  if (!dlg.found) {
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '新增'); b && b.click(); });
    await sleep(2200);
    dlg = await findDlg();
  }
  if (dlg.found) log('新增弹窗就绪');
  return dlg.found;
}

async function posOf(page, rowName, sel) {
  return page.evaluate(({ rowName, sel }) => {
    const vis = el => !!(el.offsetParent || el.getClientRects().length);
    const cands = [...document.querySelectorAll('.el-dialog, .el-overlay')].filter(el => vis(el) && el.textContent.includes('政策名称') && el.querySelector('input[placeholder*="政策名称"]'));
    const dlg = cands.sort((a, b) => b.querySelectorAll('input').length - a.querySelectorAll('input').length)[0];
    if (!dlg) return null;
    const rows = [...dlg.querySelectorAll('div')].filter(el => vis(el) && el.textContent.replace(/\s+/g, '').startsWith(rowName) && el.textContent.length < rowName.length + 30 && el.querySelector('[class*=select], input'));
    const row = rows.sort((a, b) => a.textContent.length - b.textContent.length)[0];
    if (!row) return null;
    const el = sel ? row.querySelector(sel) : row;
    if (!el || !(el.offsetParent || el.getClientRects().length)) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), rowTxt: row.textContent.trim().slice(0, 24) };
  }, { rowName, sel });
}

async function closeDialog(page) {
  const closed = await page.evaluate(() => {
    const vis = el => !!(el.offsetParent || el.getClientRects().length);
    const cands = [...document.querySelectorAll('.el-dialog, .el-overlay')].filter(el => vis(el) && el.querySelector('input[placeholder*="政策名称"]'));
    const dlg = cands.sort((a, b) => b.querySelectorAll('input').length - a.querySelectorAll('input').length)[0];
    if (!dlg) return true;
    const cancel = [...dlg.querySelectorAll('button')].find(b => /取\s*消/.test(b.textContent));
    if (cancel) { cancel.click(); return true; }
    const x = dlg.querySelector('.el-dialog__headerbtn'); if (x) { x.click(); return true; }
    return false;
  });
  await sleep(800);
  return closed;
}

// 弹窗行内 input 当前值（读联动结果/校验用）
async function readRowInputVal(page, rowName) {
  return page.evaluate(rowName => {
    const vis = el => !!(el.offsetParent || el.getClientRects().length);
    const cands = [...document.querySelectorAll('.el-dialog, .el-overlay')].filter(el => vis(el) && el.querySelector('input[placeholder*="政策名称"]'));
    const dlg = cands.sort((a, b) => b.querySelectorAll('input').length - a.querySelectorAll('input').length)[0];
    if (!dlg) return '';
    const rows = [...dlg.querySelectorAll('div')].filter(el => vis(el) && el.textContent.replace(/\s+/g, '').startsWith(rowName) && el.querySelector('input'));
    const row = rows.sort((a, b) => a.textContent.length - b.textContent.length)[0];
    const inp = row && row.querySelector('input');
    return inp ? inp.value : '';
  }, rowName).catch(() => '');
}

/**
 * 列表查询：按政策名称前缀查（v2 根因修复 diag2/3/4 实测：
 *   查询区无 form-item；第一个「请输入」=政策ID、第二个=政策名称（label 在外层容器）；
 *   且条件框残留会污染查询 → 先点「重置」再填）
 */
async function queryByPrefix(page, prefix) {
  // ① 清场：点重置（防政策ID 等残留条件污染）
  await page.evaluate(() => {
    const vis = el => !!(el.offsetParent || el.getClientRects().length);
    const b = [...document.querySelectorAll('button')].find(x => vis(x) && /重\s*置/.test(x.textContent)); b && b.click();
  }).catch(() => {});
  await sleep(600);
  // ② 定位「政策名称」框：父容器文本以政策名称开头者优先
  const ok = await page.evaluate(pfx => {
    const vis = el => !!(el.offsetParent || el.getClientRects().length);
    const ins = [...document.querySelectorAll('input.el-input__inner')].filter(i => vis(i) && i.type === 'text');
    let inp = null;
    for (const i of ins) {
      let p = i.parentElement, hops = 0, txt = '';
      while (p && hops < 4 && !txt) { txt = (p.textContent || '').trim().slice(0, 24); if (txt === (i.placeholder || '')) txt = ''; p = p.parentElement; hops++; }
      if (/^政策名称/.test(txt)) { inp = i; break; }
    }
    if (!inp) inp = [...document.querySelectorAll('input')].find(i => vis(i) && /政策名称/.test(i.placeholder || '')); // 兼容旧版
    if (!inp) { const may = ins.filter(i => i.placeholder === '请输入' || i.placeholder === ''); inp = may[1] || may[0]; } // 第二个=政策名称（实测位序）
    if (!inp) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(inp, pfx); inp.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, prefix);
  if (!ok) return false;
  await sleep(400);
  await page.evaluate(() => {
    const vis = el => !!(el.offsetParent || el.getClientRects().length);
    const b = [...document.querySelectorAll('button')].find(x => vis(x) && /查\s*询/.test(x.textContent)); b && b.click();
  });
  await sleep(2200);
  return true;
}

/**
 * 造数自清（拍板#4 双向）·v3 单条循环删除 + 数量闸 + 删除明细
 * 教训链：批量勾选删除实际删0（v2改单条循环）；2026-11-09 终验事故——宽前缀 TEST_ 命中50条
 * （含他人 zt1029 数据）未做数量核对即自动删——v3 立闸：命中数超过 maxExpect（默认8）拒删报人工，
 * 且每条删除记录名称（删除明细进 deletedNames）。工序1.8 三步校验法的②③落地。
 */
async function deleteByPrefix(page, prefix, log, maxExpect = 8) {
  if (!(await queryByPrefix(page, prefix))) return { ok: false, why: '查询框未找到' };
  // 数量闸：先数一遍（首屏命中行数），超阈拒删
  const firstCount = await page.evaluate(pfx => {
    const vis = el => !!(el.offsetParent || el.getClientRects().length);
    return [...document.querySelectorAll('.el-table__row, tr')].filter(vis).filter(t => t.textContent.includes(pfx)).length;
  }, prefix);
  if (firstCount > maxExpect) {
    log(`!! 数量闸：命中 ${firstCount} 条 > 上限 ${maxExpect}，拒删待人工确认（前缀=${prefix}）`);
    return { ok: false, why: `count-gate:${firstCount}>${maxExpect}`, count: firstCount };
  }
  let total = 0;
  const deletedNames = [];
  for (let round = 0; round < 10; round++) {
    const found = await page.evaluate(pfx => {
      const vis = el => !!(el.offsetParent || el.getClientRects().length);
      const tr = [...document.querySelectorAll('.el-table__row, tr')].filter(vis).find(t => t.textContent.includes(pfx));
      if (!tr) return null;
      const cb = tr.querySelector('input[type=checkbox]');
      if (!cb) return null;
      cb.click(); return tr.textContent.trim().slice(0, 60);
    }, prefix);
    if (!found) break;
    total++;
    deletedNames.push(found);
    if (total === 1) log(`自清：发现遗留，单条循环删除中`);
    await sleep(600);
    await page.evaluate(() => {
      const vis = el => !!(el.offsetParent || el.getClientRects().length);
      const b = [...document.querySelectorAll('button')].find(x => vis(x) && x.textContent.trim() === '删除'); b && b.click();
    });
    await sleep(1200);
    await page.evaluate(() => {
      const vis = el => !!(el.offsetParent || el.getClientRects().length);
      const mb = [...document.querySelectorAll('button')].filter(vis).find(b => /确\s*定|确\s*认/.test(b.textContent)); mb && mb.click();
    });
    await sleep(1800);
    await queryByPrefix(page, prefix); // 重查进入下一轮判定
  }
  const remain = await page.evaluate(pfx => {
    const vis = el => !!(el.offsetParent || el.getClientRects().length);
    return [...document.querySelectorAll('.el-table__row, tr')].filter(vis).filter(t => t.textContent.includes(pfx)).length;
  }, prefix);
  return remain === 0 ? { ok: true, deleted: total, deletedNames } : { ok: false, deleted: total, remain, deletedNames };
}

/**
 * 机构类下拉选择（v2：filterable 打字过滤优先 + 滚动加载兜底；真实鼠标点选项）
 * pickOrgDropdown(page, '被考核机构', '萧山') / (page, '剔除目的分拨', '', {fallbackFirst:true})
 * 返回 { ok, picked } 或 { ok:false, sample:[前5项] }
 */
async function pickOrgDropdown(page, rowName, kw, { fallbackFirst = false } = {}) {
  const pos = await posOf(page, rowName);
  if (!pos) return { ok: false, why: 'row-not-found' };
  await realClick(page, pos.x, pos.y);
  await sleep(600);
  if (kw) { // filterable：打字触发本地过滤/远程搜索
    await page.keyboard.type(kw, { delay: 40 });
    await sleep(1200);
  }
  const r = await page.evaluate(async ({ kw, fallbackFirst }) => {
    const vis = el => !!(el.offsetParent || el.getClientRects().length);
    const list = () => [...document.querySelectorAll('.el-select-dropdown__list li, .el-select-dropdown__item')].filter(vis);
    const rc = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; };
    const hit = () => list().find(l => !kw || l.textContent.trim().includes(kw)) || (fallbackFirst ? list()[0] : null);
    let h = hit();
    if (h) return { ok: true, picked: h.textContent.trim(), ...rc(h) };
    const wrap = [...document.querySelectorAll('.el-select-dropdown__wrap, .el-scrollbar__wrap')].filter(vis).pop();
    for (let i = 0; i < 30 && wrap; i++) {
      wrap.scrollTop += 300; wrap.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise(r2 => setTimeout(r2, 200));
      h = hit();
      if (h) return { ok: true, picked: h.textContent.trim(), ...rc(h) };
    }
    return { ok: false, sample: list().slice(0, 5).map(l => l.textContent.trim()) };
  }, { kw, fallbackFirst });
  if (r.ok) { await page.mouse.click(r.x, r.y); await sleep(600); }
  return r;
}

/**
 * 日期面板直选（操作细则红线：日期禁手输必须面板直选；支持跨月翻页；真实鼠标）
 * pickDateFromPanel(page, '生效日期', '2026-11-10') → bool
 */
async function pickDateFromPanel(page, rowName, dateStr, log) {
  const [y, m, d] = dateStr.split('-').map(Number);
  for (let round = 0; round < 4; round++) {
    const pos = await posOf(page, rowName, 'input');
    if (!pos) { log(`!! ${rowName} 行未定位到`); return false; }
    await dismissPoppers(page); // 清残留下拉浮层，防挡面板
    await realClick(page, pos.x, pos.y); // 打开面板
    await sleep(700);
    for (let flip = 0; flip < 4; flip++) {
      const act = await page.evaluate(({ y, m, d }) => {
        const vis = el => !!(el.offsetParent || el.getClientRects().length);
        const panels = [...document.querySelectorAll('.el-date-picker, .el-picker-panel')].filter(vis);
        const panel = panels[panels.length - 1];
        if (!panel) return { step: 'no-panel' };
        const title = (panel.textContent || '').replace(/\s+/g, '');
        const mm = title.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
        const rc = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; };
        if (mm && +mm[1] === y && +mm[2] === m) {
          const cell = [...panel.querySelectorAll('td')].filter(td => vis(td) && !/disabled/.test(td.className) && td.textContent.trim() === String(d))[0];
          if (cell) return { step: 'pick', ...rc(cell) };
          return { step: 'stuck', title: title.slice(0, 24) };
        }
        if (mm) {
          const target = y * 12 + m, cur = +mm[1] * 12 + +mm[2];
          const btns = [...panel.querySelectorAll('button')].filter(vis);
          const b = target > cur
            ? btns.find(el => /arrow-right/.test(el.className + '') && !/d-arrow/.test(el.className + ''))
            : btns.find(el => /arrow-left/.test(el.className + '') && !/d-arrow/.test(el.className + ''));
          if (b) return { step: 'flip', ...rc(b) };
        }
        return { step: 'stuck', title: title.slice(0, 24) };
      }, { y, m, d });
      if (act.step === 'pick') {
        await page.mouse.click(act.x, act.y);
        await sleep(700);
        const val = await readRowInputVal(page, rowName);
        if (val === dateStr) { log(`${rowName} 面板直选成功=${val}`); return true; }
        log(`!! ${rowName} pick后值=${val}（目标${dateStr}），重开面板`);
        break;
      }
      if (act.step === 'flip') { await page.mouse.click(act.x, act.y); await sleep(500); continue; }
      log(`${rowName} round${round} step=${act.step} ${act.title || ''}`);
      await sleep(700);
    }
  }
  log(`!! ${rowName} 面板直选未成（目标=${dateStr}）`);
  return false;
}

// 读弹窗内某 select 行的显示文本（如「产品类型全部」「产品类型请选择」）
async function readSelectRowText(page, rowName) {
  return page.evaluate(rn => {
    const vis = el => !!(el.offsetParent || el.getClientRects().length);
    const dlg = [...document.querySelectorAll('.el-dialog, .el-overlay')].filter(el => vis(el) && el.querySelector('input[placeholder*="政策名称"]')).sort((a, b) => b.querySelectorAll('input').length - a.querySelectorAll('input').length)[0];
    if (!dlg) return '';
    const rows = [...dlg.querySelectorAll('div')].filter(el => vis(el) && el.textContent.replace(/\s+/g, '').startsWith(rn) && el.querySelector('[class*=select], input'));
    const row = rows.sort((a, b) => a.textContent.length - b.textContent.length)[0];
    return row ? row.textContent.trim().slice(0, 40) : '';
  }, rowName).catch(() => '');
}

/**
 * 清空多选 select 的已选值，返回清空后行文本（diag5/diag9 定型）
 * - 下拉 li 无选中标记（aria-selected 全 false）：点 li=选中而非取消，勿用
 * - 正路=聚焦后 Backspace；兜底=hover tag 点右端关闭区
 * - 失焦=恢复默认值（产品类型→「全部」，TC_002 拍板机制）：清空态必须在任何失焦动作前读——
 *   dismissPoppers 点弹窗标题本身就是失焦，会把刚清空的值恢复成默认（曾误判"Backspace 无效"）
 */
async function clearSelectRow(page, rowName) {
  const pos = await posOf(page, rowName, '.el-select__wrapper, .el-select');
  if (!pos) return '';
  await page.mouse.click(pos.x, pos.y);
  await sleep(500);
  await page.keyboard.press('Backspace');
  await sleep(600);
  let t = await readSelectRowText(page, rowName); // 不 dismiss，防失焦恢复
  if (!/全部|鲸|冷链/.test(t)) return t;
  const tagPos = await page.evaluate(rn => {
    const vis = el => !!(el.offsetParent || el.getClientRects().length);
    const dlg = [...document.querySelectorAll('.el-dialog, .el-overlay')].filter(el => vis(el) && el.querySelector('input[placeholder*="政策名称"]')).sort((a, b) => b.querySelectorAll('input').length - a.querySelectorAll('input').length)[0];
    const rows = [...dlg.querySelectorAll('div')].filter(el => vis(el) && el.textContent.replace(/\s+/g, '').startsWith(rn) && el.querySelector('[class*=select], input'));
    const row = rows.sort((a, b) => a.textContent.length - b.textContent.length)[0];
    const tag = row && row.querySelector('.el-tag');
    if (!tag) return null;
    const r = tag.getBoundingClientRect();
    return { x: Math.round(r.right - 10), y: Math.round(r.y + r.height / 2) };
  }, rowName).catch(() => null);
  if (tagPos) {
    await page.mouse.move(tagPos.x - 25, tagPos.y); await sleep(300);
    await page.mouse.move(tagPos.x, tagPos.y); await sleep(300);
    const btn = await page.evaluate(() => { const c = document.querySelector('.el-dialog .el-tag__close'); if (c) { c.click(); return 'clicked'; } return 'none'; });
    if (btn === 'none') await page.mouse.click(tagPos.x, tagPos.y);
    await sleep(600);
  }
  return readSelectRowText(page, rowName);
}

// 接口直查政策（列表接口按政策名称查），返回首条记录（入库值断言用；须在自清前调用）
async function apiQueryPolicy(page, name) {
  return page.evaluate(async nm => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const resp = await fetch('http://gateway-ll.test.ztoeco.com/phecda/api/phecda/queryPolicyAssessmentList', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify({ page: 1, pageSize: 3, policyName: nm }) });
    const j = await resp.json();
    return ((j.result && j.result.items) || [])[0] || null;
  }, name).catch(() => null);
}

// ── 造数名称台账（2026-11-09 用户拍板：库内历史 TEST_ 数据保留不动 → 自清只删本模式自己造的数据）──
// 前缀模糊删会误伤同命名格式的历史数据（如 11-06 遗留 TEST_TC_016_20261106150247），故改为按台账名称逐条精确删
const fs = require('fs');
const path = require('path');
const OWN_LEDGER = path.join(__dirname, '..', 'created_names.jsonl');

// 造数登记：点「确定」前调用（保存成败都登记；崩溃遗留也能被下次跑前自清兜住）
function recordCreated(name) {
  fs.appendFileSync(OWN_LEDGER, JSON.stringify({ name, ts: new Date().toISOString() }) + '\n');
}
function markGone(name) {
  fs.appendFileSync(OWN_LEDGER, JSON.stringify({ name, gone: true, ts: new Date().toISOString() }) + '\n');
}
// 台账中以 prefix 开头、尚未确认删除的名称（同名以最后一条记录为准）
function ownPending(prefix) {
  if (!fs.existsSync(OWN_LEDGER)) return [];
  const st = new Map();
  for (const line of fs.readFileSync(OWN_LEDGER, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.name && r.name.startsWith(prefix)) st.set(r.name, !!r.gone); } catch (_) {}
  }
  return [...st].filter(([, gone]) => !gone).map(([n]) => n);
}

// 按完整名称删一条：查 → 勾选该行 → 删除 → 确认 → 复查；返回 { gone, deleted }
async function deleteOneByName(page, name, log = () => {}) {
  if (!(await queryByPrefix(page, name))) return { gone: false, why: '查询框未找到' };
  const present = () => page.evaluate(nm => {
    const vis = el => !!(el.offsetParent || el.getClientRects().length);
    return [...document.querySelectorAll('.el-table__row, tr')].filter(vis).some(t => t.textContent.includes(nm));
  }, name).catch(() => true); // 读不到按"仍在"处理，不误记已删
  if (!(await present())) return { gone: true, deleted: false }; // 未入库或已被删
  const checked = await page.evaluate(nm => {
    const vis = el => !!(el.offsetParent || el.getClientRects().length);
    const tr = [...document.querySelectorAll('.el-table__row, tr')].filter(vis).find(t => t.textContent.includes(nm));
    const cb = tr && tr.querySelector('input[type=checkbox]');
    if (!cb) return false;
    cb.click(); return true;
  }, name);
  if (!checked) return { gone: false, why: '行勾选框未找到' };
  await sleep(600);
  await page.evaluate(() => {
    const vis = el => !!(el.offsetParent || el.getClientRects().length);
    const b = [...document.querySelectorAll('button')].find(x => vis(x) && x.textContent.trim() === '删除'); b && b.click();
  });
  await sleep(1200);
  await page.evaluate(() => {
    const vis = el => !!(el.offsetParent || el.getClientRects().length);
    const mb = [...document.querySelectorAll('button')].filter(vis).find(b => /确\s*定|确\s*认/.test(b.textContent)); mb && mb.click();
  });
  await sleep(1800);
  await queryByPrefix(page, name);
  const still = await present();
  if (!still) log(`自清：已删 ${name}`);
  return { gone: !still, deleted: !still };
}

/**
 * 只清自己造的：按名称台账逐条精确删除本模式造的、尚未确认删除的数据（返回形状同 deleteByPrefix：{ ok, deleted, failed? }）
 * deleteByPrefix 保留给诊断场景（带数量闸），spec 自清一律用本函数
 * 2026-11-09 全池回归教训：TC_014 跑后自清偶发异常被外层 .catch 兜成 ok(0)，残留连锁挡住后续 4 条——
 *   现每条单独捕获异常并重试一次，失败如实列入 failed（含原因），本函数不向外抛；跑前自清用 prefix='TEST_'（=台账内全部自己造的遗留）
 */
async function cleanupOwn(page, prefix, log = () => {}) {
  const pending = ownPending(prefix);
  if (!pending.length) return { ok: true, deleted: 0 };
  let deleted = 0;
  const failed = [];
  for (const nm of pending) {
    let r = null, err = '';
    for (let attempt = 1; attempt <= 2 && !(r && r.gone); attempt++) {
      try { r = await deleteOneByName(page, nm, log); err = ''; }
      catch (e) { r = null; err = String((e && e.message) || e).slice(0, 100); log(`!! 自清异常（第${attempt}次）${nm}：${err}`); await sleep(1500); }
    }
    if (r && r.gone) { markGone(nm); if (r.deleted) deleted++; }
    else failed.push(nm + '｜' + (err || (r && r.why) || '复查仍在'));
  }
  return failed.length ? { ok: false, deleted, failed } : { ok: true, deleted };
}

module.exports = {
  MODULE, NUM_FIELDS, POLICY_URL,
  openPolicyPage, openAddDialog, posOf, closeDialog, readRowInputVal, queryByPrefix, deleteByPrefix,
  pickOrgDropdown, pickDateFromPanel, readSelectRowText, clearSelectRow, apiQueryPolicy,
  recordCreated, markGone, ownPending, deleteOneByName, cleanupOwn,
  // 模板契约名（modules/_template.js）
  openPage: openPolicyPage, apiQuery: apiQueryPolicy,
};
