#!/usr/bin/env node
/**
 * lanhu_reconcile.js v2 — 采集文档 × 蓝湖原页 对账器（文本双向 + 样式/结构层）
 *
 * 五类检查（任一红=非零退出）：
 *  ① miss     live→doc：蓝湖可见文本节点（≥minChars）必须被文档覆盖
 *  ② extra    doc→live：文档正文行必须能溯源到蓝湖（整行/分段）
 *  ③ headings 章节序：蓝湖章节标题序列 == 文档章节标题序列（顺序+文本）
 *  ④ tables   表格结构：文档表格与蓝湖表格按序匹配——表头单元格集合一致（合并单元格拆分比对）、数据行数差≤容差
 *  ⑤ images   图数量：文档画布图引用数 == 蓝湖画布大图数（含隐藏面板图；带截图/弹窗裁剪不计入）
 *
 * 用法：node lanhu_reconcile.js <端口> --doc "<md绝对路径>" --menu "<树内菜单名>" [--min-chars 6] [--row-tol 2]
 */
const fs = require('fs');
const {
  connectBrowser, getLanhuPages, enterPrototype, robustClickMenu,
  scrollToBottom, findContentFrame, Logger,
} = require('./browser_utils');
const { resolveLanhuUrl } = require('./config_loader');

const norm = (s) => String(s || '').replace(/\s+/g, '');
const HEAD_RE = /^[一二三四五六七八九十]+[、）、]|^优化点[一二三四五六七八九十]+[：:]/;

(async () => {
  const A = {};
  process.argv.slice(2).forEach((s, i, arr) => { if (s.startsWith('--')) A[s.slice(2)] = arr[i + 1]; });
  const port = process.argv[2];
  const docPath = A.doc, menu = A.menu;
  const minChars = parseInt(A['min-chars'] || '6', 10);
  const rowTol = parseInt(A['row-tol'] || '2', 10);
  if (!docPath || !menu) { console.error('need --doc --menu'); process.exit(2); }

  const logger = new Logger('lanhu_reconcile');
  const browser = await connectBrowser(logger);
  let pages = await getLanhuPages(browser);
  let page = pages[0], opened = null;
  if (!page) {
    const ctx = browser.contexts()[0] || await browser.newContext();
    page = await ctx.newPage(); opened = page;
    const url = resolveLanhuUrl();
    if (!url) { console.error('无蓝湖地址'); process.exit(2); }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => logger.warn('goto: ' + e.message));
    await page.waitForTimeout(3500);
    await enterPrototype(page, logger);
  }

  await robustClickMenu(page, menu, logger);
  const frame = await findContentFrame(page, logger);
  if (!frame) { console.error('NO_FRAME'); process.exit(2); }
  await scrollToBottom(frame, logger);

  // ── live 结构模型（文本/章节/表格/图） ──
  const live = await frame.evaluate(() => {
    const texts = [];
    document.querySelectorAll('[id$="_text"]').forEach(el => {
      const t = (el.innerText || '').trim(); if (!t) return;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) texts.push({ t, y: Math.round(r.top), x: Math.round(r.left), w: Math.round(r.width) });
    });
    texts.sort((a, b) => a.y - b.y || a.x - b.x);
    // 行分组（y±25）
    const rows = [];
    for (const t of texts) {
      const row = rows.find(r => Math.abs(r.y - t.y) <= 25);
      if (row) row.cells.push({ t: t.t, x: t.x });
      else rows.push({ y: t.y, cells: [{ t: t.t, x: t.x }] });
    }
    rows.forEach(r => r.cells.sort((a, b) => a.x - b.x));
    // 表格区：连续 ≥3 行且每行 ≥2 个非空格（横线/纯空不算） → 表；表头=首个高填充且非枚举/按钮行
    //（G70c 检查器局限修补：①表头含>80字长文=双栏文本区误判，剔除 ②表头判定剔除枚举/按钮行）
    const filled = (r) => r.cells.filter(c => c.t && !/^[\s\-—–]+$/.test(c.t)).length;
    const rowText = (r) => r.cells.map(c => c.t).join(' ');
    const isEnum = (r) => { const t = rowText(r); return ((t.match(/未审核|审核通过|审核驳回|未生效|生效中|已失效/g) || []).length >= 3) && !/[。；;，]/.test(t); };
    const isBtn = (r) => r.cells.length && r.cells.every(c => !c.t || /^(查询|重置|查\s*询|重\s*置|新\s*增|删\s*除|导\s*入|导\s*出)$/.test(c.t.trim())) && r.cells.some(c => c.t);
    const tables = [];
    let i = 0;
    while (i < rows.length) {
      if (rows[i].cells.filter(c => c.t && !/^[\s\-—–]+$/.test(c.t)).length >= 2) {
        let j = i;
        while (j < rows.length && rows[j].cells.filter(c => c.t && !/^[\s\-—–]+$/.test(c.t)).length >= 2) j++;
        if (j - i >= 3) {
          let h = i;
          while (h < j && !(filled(rows[h]) >= Math.max(3, rows[h].cells.length * 0.7) && !isEnum(rows[h]) && !isBtn(rows[h]))) h++;
          if (h < j) {
            const dataRows = j - h - 1;
            const headerCells = rows[h].cells.map(c => c.t.trim()).filter(Boolean);
            const firstDataRowCells = (rows[h + 1] ? rows[h + 1].cells.map(c => c.t.trim()).filter(Boolean) : []);
            if (headerCells.some(c => c.length > 80)) { i = j; continue; } // G70c：长文表头=文本区误判
            tables.push({ top: rows[i].y, headerCells, firstDataRowCells, dataRows });
          }
        }
        i = j;
      } else i++;
    }
    const imgs = [];
    document.querySelectorAll('img,svg').forEach(el => {
      // G77：panel_state（mockup 面板）内部的 img/svg 由面板截图整体覆盖——不进画布图计数
      const host = el.closest ? el.closest('.panel_state') : null;
      if (host) {
        const hr = host.getBoundingClientRect();
        if (hr.width >= 350 && hr.height >= 250) return;
      }
      const r = el.getBoundingClientRect();
      if (r.width >= 200 && r.height >= 120) {
        // G78：文字型位图（img 区域内 axure 文本重叠 ≥100 字符）不入计数——内容为文字说明，
        // 文档以文本呈现（用户拍板），与生成者跳拍判据同源
        const sy0 = window.scrollY || 0;
        let oc = 0;
        document.querySelectorAll('[id$="_text"]').forEach(t => {
          const tr = t.getBoundingClientRect();
          if (tr.width <= 0 || tr.height <= 0) return;
          const ty = tr.top + sy0;
          if (ty >= r.top + sy0 && ty < r.top + sy0 + r.height) oc += (t.innerText || '').replace(/\s+/g, '').length;
        });
        if (oc >= 100) return;
        imgs.push({ y: Math.round(r.top), h: Math.round(r.height), hidden: false });
      }
      // G77c：hidden img（rect=0, naturalWidth 有效）不入计数——doc 侧隐藏图走"隐藏图_"引用（不进画布计数），口径须一致；
      // 隐藏图存在性由 verify 的 MISSING 检查兜底
    });
    // G70c 复盘：位图覆盖豁免过贪（仓内 4 张真表被吞）——撤除硬豁免，仅作信息计数；
    // 位图区的表若真缺失会由 miss/图数量兜底暴露
    const coveredByImg = tables.filter(t => imgs.some(im => !im.hidden && t.top > im.y - 40 && t.top < im.y + im.h + 200)).length;
    return { texts: texts.map(t => t.t), tables, imgs, skippedByImg: coveredByImg };
  });

  if (opened) { try { await opened.close(); } catch (e) {} }
  await browser.close();

  // ── doc 模型 ──
  const raw = fs.readFileSync(docPath, 'utf-8');
  const docLines = raw.split('\n');
  const docHeadings = [], docTables = [], docCanvasImgs = [], docBandImgs = [];
  let ti = null;
  for (const l of docLines) {
    const t = l.trim();
    if (HEAD_RE.test(t)) { docHeadings.push(t); ti = null; continue; }
    if (t.startsWith('|')) {
      if (!ti) { ti = 0; docTables.push({ headerCells: [], dataRows: 0, dataCells: [] }); }
      if (ti === 0) { docTables[docTables.length - 1].headerCells = t.slice(1, -1).split('|').map(c => c.trim()).filter(Boolean); ti = 1; }
      else if (/^[\s|:-]+$/.test(t)) { /* 分隔行 */ }
      else {
        const T = docTables[docTables.length - 1];
        T.dataRows++;
        if (T.dataRows <= 2) T.dataCells.push(t.slice(1, -1).split('|').map(c => c.trim()).filter(Boolean));
      }
      continue;
    }
    ti = null;
    const m = t.match(/^!\[.*?\]\((.+?)\)/);
    if (m) {
      const f = m[1].split('/').pop();
      // G77：界面_（panel_state 面板截图）/查询条件_/表格全景_/弹窗裁剪/隐藏图 均非 live img 元素——不进画布图计数
      if (/^界面_|^查询条件_|^表格全景_/.test(f) || /弹窗|隐藏图/.test(f)) docBandImgs.push(f);
      else if (/弹窗/.test(f)) { /* 弹窗裁剪不计画布图 */ }
      else docCanvasImgs.push(f);
    }
  }

  // ── ① miss ──
  const docNorm = norm(raw);
  const targets = live.texts.filter(t => norm(t).length >= minChars);
  const missing = [];
  let covered = 0;
  for (const t of targets) { if (docNorm.includes(norm(t))) covered++; else missing.push(t.replace(/\s+/g, ' ').slice(0, 60)); }

  // ── ② extra ──
  const liveAllFull = live.texts.map(t => norm(t)).filter(Boolean).join('||');
  const extras = [];
  for (const l0 of docLines) {
    const l = l0.trim();
    if (!l || /^[#>|!]/.test(l) || l.startsWith('|') || l.startsWith('<')) continue;
    const nl = norm(l);
    if (nl.length < minChars) continue;
    if (liveAllFull.includes(nl)) continue;
    const segs = l.split(/\s+/).map(x => norm(x)).filter(x => x.length >= 2);
    if (segs.length) { const hit = segs.filter(sg => liveAllFull.includes(sg)).length; if (hit * 2 >= segs.length) continue; }
    extras.push(l.slice(0, 60));
  }

  // ── ③ headings 序（G70c：多行文本节点先拆行再判标题） ──
  const lh = live.texts.flatMap(t => String(t).split('\n')).map(s => s.trim()).filter(t => HEAD_RE.test(t));
  const headingIssue = [];
  const n = Math.max(lh.length, docHeadings.length);
  for (let k = 0; k < n; k++) {
    const a = norm(lh[k]), b = norm(docHeadings[k]);
    if (a !== b) { headingIssue.push({ idx: k, live: (lh[k] || '').slice(0, 30), doc: (docHeadings[k] || '').slice(0, 30) }); if (headingIssue.length >= 5) break; }
  }

  // ── ④ tables 结构（按序贪心匹配；G70c：多层表头用"表头∪首数据行"池比对） ──
  const poolOf = (arrs) => { const s = new Set(); for (const a of arrs) for (const c of a) for (const x of String(c).split(/\s+/)) { const nx = norm(x); if (nx.length >= 2) s.add(nx); } return s; };
  // G77：内容溯源豁免——表结构差异若"doc 表全部单元格文本可溯源到 live 文本池"则降级为提示（形态差异非内容缺失）：
  // 多层表头怪物 doc 合并行 vs live 逐层行=行数不可比；panel_state 内表格 live 行分组可能不聚表=表头无匹配但内容在
  const tableNotes = [];
  const sourced = (cells) => {
    const flat = cells.flat(); // G77b：dataCells 是二维（每行 cell 数组）——必须展平，否则 String(数组) 逗号串全 miss（对客报价 noteCount=0 实证）
    if (!flat || !flat.length) return false;
    let hit = 0, total = 0;
    for (const c of flat) {
      const segs = String(c).split(/\s+/).map(norm).filter(x => x.length >= 2);
      for (const sg of segs) { total++; if (liveAllFull.includes(sg)) hit++; }
    }
    return total > 0 && hit >= total * 0.9;
  };
  const tableIssues = [];
  const usedLive = new Set();
  const matches = [];
  for (let d = 0; d < docTables.length; d++) {
    const dPool = poolOf([docTables[d].headerCells, ...(docTables[d].dataCells || [])]);
    if (!dPool.size) { tableIssues.push({ kind: '空表头文档表', docHeader: docTables[d].headerCells.slice(0, 3).join('/') }); continue; }
    let best = -1, bestScore = 0;
    for (let L = 0; L < live.tables.length; L++) {
      if (usedLive.has(L)) continue;
      if (L < (matches.length ? matches[matches.length - 1].live + 1 : 0)) continue; // 保序
      const lPool = poolOf([live.tables[L].headerCells, live.tables[L].firstDataRowCells || []]);
      let inter = 0; for (const x of dPool) if (lPool.has(x)) inter++;
      const score = inter / dPool.size;
      if (score > bestScore) { bestScore = score; best = L; }
    }
    if (best >= 0 && bestScore >= 0.5) {
      usedLive.add(best);
      matches.push({ doc: d, live: best, score: +bestScore.toFixed(2) });
      const dr = docTables[d].dataRows, lr = live.tables[best].dataRows;
      if (Math.abs(dr - lr) > rowTol) {
        if (sourced([...docTables[d].headerCells, ...(docTables[d].dataCells || [])]))
          tableNotes.push({ kind: '行数形态差(内容全溯源)', docHeader: docTables[d].headerCells.slice(0, 3).join('/'), docRows: dr, liveRows: lr });
        else tableIssues.push({ kind: '行数差', docHeader: docTables[d].headerCells.slice(0, 4).join('/'), docRows: dr, liveRows: lr });
      }
    } else {
      if (sourced([...docTables[d].headerCells, ...(docTables[d].dataCells || [])]))
        tableNotes.push({ kind: 'live未聚表但内容在(面板表)', docHeader: docTables[d].headerCells.slice(0, 3).join('/') });
      else tableIssues.push({ kind: '表头无匹配', docHeader: docTables[d].headerCells.slice(0, 5).join('/'), score: bestScore });
    }
  }
  for (let L = 0; L < live.tables.length; L++) {
    if (!usedLive.has(L)) tableIssues.push({ kind: '蓝湖表未入文档', liveHeader: live.tables[L].headerCells.slice(0, 5).join('/') });
  }

  // ── ⑤ 画布图数量 ──
  const liveImgCount = live.imgs.length;
  const imgIssue = liveImgCount !== docCanvasImgs.length
    ? { liveImgs: liveImgCount, docCanvasImgs: docCanvasImgs.length, sample: docCanvasImgs.slice(0, 4) } : null;

  const result = {
    menu, doc: docPath,
    coverage: targets.length ? +(covered / targets.length).toFixed(4) : null,
    missingCount: missing.length, missingTop: missing.slice(0, 8),
    extraCount: extras.length, extraTop: extras.slice(0, 8),
    headings: { live: lh.length, doc: docHeadings.length, issueCount: headingIssue.length, issues: headingIssue },
    tables: { live: live.tables.length, doc: docTables.length, matched: matches.length, issueCount: tableIssues.length, issues: tableIssues.slice(0, 8), noteCount: tableNotes.length, notes: tableNotes.slice(0, 4) },
    images: imgIssue || { liveImgs: liveImgCount, docCanvasImgs: docCanvasImgs.length, ok: true },
    bands: docBandImgs.length,
  };
  const red = missing.length > 0 || extras.length > 0 || headingIssue.length > 0 || tableIssues.length > 0 || !!imgIssue;
  result.VERDICT = red ? 'RED' : 'GREEN';
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = red ? 1 : 0;
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
