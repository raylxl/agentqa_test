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
 *  ⑥ diagrams 图示截图（G85）：几何识别出的流程图/图示（节点矩形+连接线），文档必须有等量的 流程图_ 截图
 *             ——文字层只保阅读序，无图=菱形/分支/连线结构丢失
 *  ⑦ flow     流程图（G91/G93）：可重建出流程图的图示须有等量 ```mermaid 代码块（阅读器直接显示为流程图）；逐块节点/连线数 == 蓝湖节点/箭头数；
 *             标签逐字可溯源；有渲染库时须有等量渲染图；源码被藏进 HTML 注释=用户看不到流程图（红）
 *
 * 用法：node lanhu_reconcile.js <端口> --doc "<md绝对路径>" --menu "<树内菜单名>" [--min-chars 6] [--row-tol 2]
 */
const fs = require('fs');
const {
  connectBrowser, getLanhuPages, enterPrototype, robustClickMenu,
  scrollToBottom, findContentFrame, Logger, extractLanhuContent,
} = require('./browser_utils');
const { resolveLanhuUrl } = require('./config_loader');
const { rebuildFlow, mmUnescape } = require('./lanhu_flowmermaid.js'); // G91：图示拓扑与采集器同一模块重建

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

  // G86（2026-11-24）：活页结构模型与采集器同源——表格/图示取 extractLanhuContent 的几何识别结果。
  // 背景：对账器此前自带一套"文字坐标±25 聚行判表"，与采集器各猜各的版面：采集器把 31 行联系人表挤成 16 行，
  // 对账器按同样规则也挤成 16 行，于是"两边一致"放行（税务信息维护实证）。同源后一错俱错、一对一才过。
  const exg = await extractLanhuContent(frame, logger).catch(e => { logger.warn('extract 同源取数失败，退回自带模型: ' + e.message); return null; });

  // ── live 结构模型（文本/章节/表格/图） ──
  const live = await frame.evaluate((args) => {
    // G86：已入几何表/图示的文字不再参与"聚行判表"（流程图节点标签会被聚成假表）；① miss 仍查全量文字
    const skip = new Set((args.consumed || []).map(c => c.t + '@' + c.y + '@' + c.x));
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
      if (skip.has(t.t + '@' + t.y + '@' + t.x)) continue;
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
  }, { consumed: exg ? (exg.consumed || []) : [] });
  // G86：表格以几何识别（单元格网格）为准；自带模型落在几何表范围内的判定作废，范围外的保留
  let liveDiagrams = 0;
  if (exg && exg.tables && exg.tables.length) {
    const geoTabs = exg.tables.map(gt => ({ top: gt.top, bottom: gt.bottom, headerCells: gt.headerCells, firstDataRowCells: gt.firstDataRowCells, dataRows: gt.dataRows }));
    const rest = live.tables.filter(lt => !geoTabs.some(gt => lt.top >= gt.top - 6 && lt.top <= gt.bottom + 6));
    live.tables = geoTabs.concat(rest).sort((a, b) => a.top - b.top);
  }
  if (exg && exg.diagrams) liveDiagrams = exg.diagrams.length;
  // G91：图示拓扑同源重建（与采集器同一模块、同一批 SVG）——蓝湖上能重建出流程图的图示，文档里必须有对应的流程图块与渲染图。
  const liveFlows = [];
  if (exg && exg.diagrams && exg.diagrams.length) {
    const flowSvg = {};
    const srcs = new Set();
    exg.diagrams.forEach(d => { const g = d.geo || {}; [...(g.cells || []), ...(g.dots || [])].forEach(o => { if (o.src) srcs.add(o.src); }); });
    for (const s of srcs) {
      try { const resp = await page.context().request.get(s, { timeout: 15000 }); if (resp.ok()) flowSvg[s] = (await resp.body()).toString('utf-8').slice(0, 6000); } catch (e) {}
    }
    exg.diagrams.forEach((d, i) => { const r = rebuildFlow(d, src => flowSvg[src]); if (r.ok) liveFlows.push({ idx: i, nodes: r.report.nodes, edges: r.report.methodA }); });
  }

  if (opened) { try { await opened.close(); } catch (e) {} }
  await browser.close();

  // ── doc 模型 ──
  // G86：单元格内的 <br> 分行标记与 &#124; 转义竖线是呈现层记号——比对前还原（蓝湖侧一个多行文本件=文档侧 <br> 分行）
  const raw = fs.readFileSync(docPath, 'utf-8').replace(/<br\s*\/?>/gi, '').replace(/&#124;/g, '|').replace(/#(38|34|60|62|124);/g, (_, n) => String.fromCharCode(Number(n))); // G91：流程图标签实体还原
  const docLines = raw.split('\n');
  const docHeadings = [], docTables = [], docCanvasImgs = [], docBandImgs = [], docDiagramImgs = [], docFlowRenders = [];
  let ti = null;
  let inFence = false; // G91：围栏代码块内的行不参与标题/表格/图片解析
  let inComment = false; // G92：HTML 注释段（流程图结构块在此）不参与解析
  for (const l of docLines) {
    const t = l.trim();
    if (!inComment && t.startsWith('<!--')) inComment = true;
    if (inComment) { if (t.includes('-->')) inComment = false; ti = null; continue; }
    if (t.startsWith('```')) { inFence = !inFence; continue; }
    if (inFence) { ti = null; continue; }
    if (t.startsWith('!')) { /* 图片引用 → 落入下方 image 分类 */ }
    else if (/^[|#>]/.test(t)) { /* 表行/标题行/引用行：不参与标题提取（表行落入下方表解析） */ }
    else if (HEAD_RE.test(t) && !/[、）、]\s*[0-9:{，]/.test(t) && !/），/.test(t)) { docHeadings.push(t); ti = null; continue; }
    // G80：doc 侧粘连行对称处理（正文行内含标题模式也收，如"…所有公司 一、通用提醒"）
    {
      const re = /([一二三四五六七八九十]+[、）、][^一二三四五六七八九十]{2,18}|优化点[一二三四五六七八九十]+[：:].{0,28})/g;
      let mm, got = [];
      while ((mm = re.exec(t)) !== null) {
        if (/[、）、]\s*[0-9:{，]/.test(mm[1])) continue; // G80：示例时间线（"一、10:10:01…"）非标题
        if (/^[一二三四五六七八九十]+[）]\s*，/.test(mm[1]) || mm[1].includes('），')) continue; // G80：散文括号枚举（"三），其它…"）非标题
        if (mm[1].includes('_图') || mm[1].includes('.png') || mm[1].includes('](') || mm[1].includes('|')) continue; // G80：图片引用行/表格碎片伪标题
        if (/^[一二三四五六七八九十]+[）]\s*、/.test(mm[1])) continue; // G83：枚举小项（"一）、保价费专用模板"）非章节标题
        got.push(mm[1]);
      }
      if (got.length && t.length > 30) { docHeadings.push(...got); }
    }
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
      // G85（2026-11-24）：流程图_ 前缀=axure 矢量流程图区域截图（DOM 文本节点被拍扁后的视觉结构增补，非 live img）——同 G77 口径不计画布图对账
      if (/^流程图_/.test(f)) { docDiagramImgs.push(f); docBandImgs.push(f); } // G85：图示截图另计数（见 ⑥）
      else if (/^流程图渲染_/.test(f)) { docFlowRenders.push(f); docBandImgs.push(f); } // G91：流程图渲染图另计数（见 ⑦）
      else if (/^界面_|^查询条件_|^表格全景_/.test(f) || /弹窗|隐藏图/.test(f)) docBandImgs.push(f);
      else if (/弹窗/.test(f)) { /* 弹窗裁剪不计画布图 */ }
      else docCanvasImgs.push(f);
    }
  }

  // ── ① miss ──
  const docNorm = norm(raw);
  // G87：隐形格里的文字（同一滚动容器内被后画的格子整列盖住，页面上看不见）不入核对目标——与采集器同源判定
  const hiddenKeys = new Set(((exg && exg.hidden) || []).map(h => norm(h.t)));
  const targets = live.texts.filter(t => norm(t).length >= minChars && !hiddenKeys.has(norm(t)));
  const missing = [];
  let covered = 0;
  for (const t of targets) { if (docNorm.includes(norm(t))) covered++; else missing.push(t.replace(/\s+/g, ' ').slice(0, 60)); }

  // ── ② extra ──
  const liveAllFull = live.texts.map(t => norm(t)).filter(Boolean).join('||');
  const extras = [];
  {
    let inf = false, inc = false; // G91/G92：围栏内、HTML 注释内的行不走正文溯源（流程图块在下面按标签逐个溯源）
    for (const l0 of docLines) {
      const l = l0.trim();
      if (!inc && l.startsWith('<!--')) inc = true;
      if (inc) { if (l.includes('-->')) inc = false; continue; }
      if (l.startsWith('```')) { inf = !inf; continue; }
      if (inf) continue;
      if (!l || /^[#>|!]/.test(l) || l.startsWith('|') || l.startsWith('<')) continue;
      const nl = norm(l);
      if (nl.length < minChars) continue;
      if (liveAllFull.includes(nl)) continue;
      const segs = l.split(/\s+/).map(x => norm(x)).filter(x => x.length >= 2);
      if (segs.length) { const hit = segs.filter(sg => liveAllFull.includes(sg)).length; if (hit * 2 >= segs.length) continue; }
      extras.push(l.slice(0, 60));
    }
  }
  // G91：流程图块——每块记节点数/连线数，并取出全部标签（节点文字、连线标注；数字实体还原）。
  // 标签必须逐字来自蓝湖文字（采集器只许搬运、不许改写），与正文行的整行溯源分开算
  const docMermaid = []; // 每块 {nodes, edges, labels, visible}；按文档中出现序
  {
    const src = fs.readFileSync(docPath, 'utf-8').split('\n');
    let kind = null, cur = null; // kind: 'fenced'（```mermaid 代码块，现行形态）| 'hidden'（源码被藏进 HTML 注释——判红，照常记节点/连线/标签）
    for (const l0 of src) {
      const s = l0.trim();
      if (!kind && s.startsWith('<!--')) {
        if (s.includes('流程图结构')) { kind = 'hidden'; docMermaid.push(cur = { nodes: 0, edges: 0, labels: [], visible: false }); }
        else continue; // 其他 HTML 注释不在本检查范围
        continue;
      }
      if (!kind && s.startsWith('```')) {
        if (s.slice(3).trim().toLowerCase() === 'mermaid') { kind = 'fenced'; docMermaid.push(cur = { nodes: 0, edges: 0, labels: [], visible: true }); }
        continue;
      }
      if (!kind || !cur) continue;
      if (kind === 'hidden' && s === '-->') { kind = null; cur = null; continue; }
      if (kind === 'fenced' && s.startsWith('```')) { kind = null; cur = null; continue; }
      if (/^n\d+\s*(-->|==>)/.test(s)) cur.edges++; // ==> 藏注释写法（已废）；--> 现行可见代码块写法
      else if (/^n\d+[(\[({]/.test(s)) cur.nodes++;
      for (const m of s.matchAll(/"([^"]*)"/g)) cur.labels.push(mmUnescape(m[1]));
    }
  }
  const liveAll = live.texts.map(t => norm(t)).filter(Boolean);
  const flowLabelMiss = []; // 流程图标签在蓝湖文字里找不到的
  // 溯源判据：标签整体（去掉 <br> 分行记号后）== 蓝湖某个文字件 —— 对应"一个多行文字件整块成了连线标注"；
  // 或标签按 <br> 拆开的每一段都 == 蓝湖某个文字件 —— 对应"一个节点/一条连线挂了多个文字件"
  const liveSet = new Set(liveAll);
  docMermaid.forEach((b, k) => b.labels.forEach((lb) => {
    const whole = norm(lb.replace(/<br\s*\/?>/gi, ''));
    const parts = lb.split(/<br\s*\/?>/i).map(x => norm(x.trim())).filter(Boolean);
    const ok = (whole && liveSet.has(whole)) || (parts.length && parts.every(x => liveSet.has(x)));
    if (!ok) flowLabelMiss.push('块' + (k + 1) + ': ' + lb.replace(/<br\s*\/?>/gi, ' ').slice(0, 30));
  }));

  // ── ③ headings 序（G80：live 标题常与正文粘连在同一 _text 节点（"…所有公司 一、通用提醒"）——
  //    每节点只取第一处标题行，且标题必须处于行首或行尾的粘连位（中段截断行丢弃） ──
  const HEAD_LINE = /^[一二三四五六七八九十]+[、）、][^一二三四五六七八九十]{2,18}$|^[一二三四五六七八九十]+[、）、].{0,40}$|^优化点[一二三四五六七八九十]+[：:].{0,30}$/;
  const lh = [];
  for (const node of live.texts) {
    const lines = String(node).split('\n').map(s => s.trim()).filter(Boolean);
    for (const line of lines) {
      if (!HEAD_RE.test(line) && !/\s[一二三四五六七八九十]+[、）、]/.test(line) && !/\s优化点[一二三四五六七八九十]+[：:]/.test(line)) continue;
      // G80：粘连行（"…所有公司 一、通用提醒"）取最后一个标题模式起点；一行可含多个标题则逐个取
      const re = /([一二三四五六七八九十]+[、）、][^一二三四五六七八九十]{2,18}|优化点[一二三四五六七八九十]+[：:].{0,28})/g;
      let mm, last = [];
      while ((mm = re.exec(line)) !== null) {
        if (/[、）、]\s*[0-9:{]/.test(mm[1])) continue; // G80：示例时间线非标题
        last.push(mm[1]);
      }
      if (last.length) lh.push(...last);
      else if (HEAD_RE.test(line)) lh.push(line.slice(0, 26));
    }
  }
  const headingIssue = [];
  {
    // G80：同页重复注解块（通用提醒×N 重复画）——严格交错序无意义。判据：
    // ①标题集合双向包含（norm+去冒号+前缀匹配——live 提取器截 28 字 vs doc 收全行，同标题长度不同）②去重后首现序按前缀配对一致
    const key = (h) => norm(h).replace(/[：:]$/, '');
    const seqOf = (arr) => { const seen = new Set(); const s = []; for (const h of arr) { const k = key(h); if (!seen.has(k)) { seen.add(k); s.push(k); } } return s; };
    const liveSeq = seqOf(lh), docSeq = seqOf(docHeadings);
    const pmatch = (a, b) => { const L = Math.min(a.length, b.length); return L >= 4 && (a === b || a.slice(0, L) === b.slice(0, L)); };
    const inSet = (k, arr) => arr.some(k2 => pmatch(k, k2));
    const missInDoc = liveSeq.filter(k => !inSet(k, docSeq));
    const extraInDoc = docSeq.filter(k => !inSet(k, liveSeq));
    if (missInDoc.length) headingIssue.push({ idx: -1, live: 'live标题doc缺失×' + missInDoc.length, doc: missInDoc.slice(0, 3).join(' | ') });
    if (extraInDoc.length) headingIssue.push({ idx: -2, live: 'doc多出标题×' + extraInDoc.length, doc: extraInDoc.slice(0, 3).join(' | ') });
    if (!headingIssue.length) {
      // 首现序：前缀配对贪心
      let j = 0, orderOk = true;
      for (const k of liveSeq) {
        let found = -1;
        for (let d2 = j; d2 < docSeq.length; d2++) { if (pmatch(k, docSeq[d2])) { found = d2; break; } }
        if (found < 0) { orderOk = false; break; }
        j = found + 1;
      }
      if (!orderOk) headingIssue.push({ idx: -3, live: '首现序不一致', doc: 'live:' + liveSeq.slice(0, 4).join('›') + ' doc:' + docSeq.slice(0, 4).join('›') });
    }
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
    if (usedLive.has(L)) continue;
    // G80：枚举/按钮行被 live 侧误判为表头（"全部/99+/已处理"）——doc 以查询条件带截图表达属正确形态，豁免
    const hc = live.tables[L].headerCells;
    const t = hc.join(' ');
    const enumish = hc.length >= 2 && (
      ((t.match(/未审核|审核通过|审核驳回|未生效|生效中|已失效|未处理|已处理|全部/g) || []).length >= 2) ||
      hc.every(c => /^(全部|未处理|已处理|99\+|\d+)$/.test(c.trim()))
    );
    if (enumish) { tableNotes.push({ kind: '枚举行误判表头(豁免)', liveHeader: hc.slice(0, 4).join('/') }); continue; }
    // G80：内容溯源豁免——表单元格全部可在 live 文本池找到=形态差异（同 sourced）
    if (sourced(hc) && sourced(live.tables[L].firstDataRowCells || [])) {
      tableNotes.push({ kind: 'live未聚表但内容在(豁免)', liveHeader: hc.slice(0, 4).join('/') });
      continue;
    }
    tableIssues.push({ kind: '蓝湖表未入文档', liveHeader: hc.slice(0, 5).join('/') });
  }

  // ── ⑤ 画布图数量 ──
  const liveImgCount = live.imgs.length;
  const imgIssue = liveImgCount !== docCanvasImgs.length
    ? { liveImgs: liveImgCount, docCanvasImgs: docCanvasImgs.length, sample: docCanvasImgs.slice(0, 4) } : null;

  // ── ⑥ 图示截图：几何识别出的流程图/图示，文档必须有等量截图（无图=结构丢失，v1 四道闸门全绿却拍扁的堵口） ──
  const diagramIssue = liveDiagrams !== docDiagramImgs.length ? { liveDiagrams, docDiagrams: docDiagramImgs.length } : null;
  // ── ⑦ 流程图（G91）：蓝湖上可重建出流程图的图示，文档里须有等量的流程图块；逐块节点数/连线数 == 蓝湖节点数/箭头数；
  //    标签全部可溯源；本机有渲染库时还须有等量渲染图 ──
  const liveFlowN = liveFlows.length;
  const flowIssues = [];
  if (docMermaid.length !== liveFlowN) flowIssues.push({ kind: '流程图块数', live: liveFlowN, doc: docMermaid.length });
  const visibleFlow = docMermaid.filter(b => b.visible).length;
  // G93（2026-11-24 用户实证“流程图没了，还没上次展示的好”）：源码必须是可见的 ```mermaid 代码块——用户阅读器把它画成流程图；
  // 藏进 HTML 注释=用户看不到流程图（v5 实证被驳）
  const hiddenFlow = docMermaid.length - visibleFlow;
  if (hiddenFlow) flowIssues.push({ kind: '流程图源码被藏进注释（用户看不到流程图）', doc: hiddenFlow });
  docMermaid.forEach((b, k) => { const lf = liveFlows[k]; if (lf && (b.nodes !== lf.nodes || b.edges !== lf.edges)) flowIssues.push({ kind: '节点/连线数', live: lf.nodes + '/' + lf.edges, doc: b.nodes + '/' + b.edges }); });
  if (flowLabelMiss.length) flowIssues.push({ kind: '流程图标签未溯源', count: flowLabelMiss.length, top: flowLabelMiss.slice(0, 5) });
  const hasVendor = fs.existsSync(require('path').join(__dirname, 'vendor', 'mermaid.min.js'));
  if (hasVendor && liveFlowN && docFlowRenders.length !== liveFlowN) flowIssues.push({ kind: '渲染图数', live: liveFlowN, doc: docFlowRenders.length });

  const result = {
    menu, doc: docPath,
    coverage: targets.length ? +(covered / targets.length).toFixed(4) : null,
    missingCount: missing.length, missingTop: missing.slice(0, 8),
    extraCount: extras.length, extraTop: extras.slice(0, 8),
    headings: { live: lh.length, doc: docHeadings.length, issueCount: headingIssue.length, issues: headingIssue },
    tables: { live: live.tables.length, doc: docTables.length, matched: matches.length, issueCount: tableIssues.length, issues: tableIssues.slice(0, 8), noteCount: tableNotes.length, notes: tableNotes.slice(0, 4) },
    images: imgIssue || { liveImgs: liveImgCount, docCanvasImgs: docCanvasImgs.length, ok: true },
    bands: docBandImgs.length,
    diagrams: diagramIssue || { live: liveDiagrams, doc: docDiagramImgs.length, ok: true },
    hiddenCellTexts: hiddenKeys.size,
    flow: flowIssues.length ? { live: liveFlowN, flowBlocks: docMermaid.length, hidden: hiddenFlow, renders: docFlowRenders.length, issues: flowIssues } : { live: liveFlowN, flowBlocks: docMermaid.length, hidden: 0, renders: docFlowRenders.length, ok: true },
  };
  const red = missing.length > 0 || extras.length > 0 || headingIssue.length > 0 || tableIssues.length > 0 || !!imgIssue || !!diagramIssue || flowIssues.length > 0;
  result.VERDICT = red ? 'RED' : 'GREEN';
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = red ? 1 : 0;
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
