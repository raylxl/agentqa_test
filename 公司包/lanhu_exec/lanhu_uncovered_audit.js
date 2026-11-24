#!/usr/bin/env node
/**
 * lanhu_uncovered_audit.js — 采集覆盖残留审计（2026-11-24 全量重采立，G93）
 *
 * 为什么要有它：对账器的"覆盖"只核 ≥6 字的文字件，且 mockup 面板/查询条件带里的内容按"截图覆盖"豁免；
 * 文字忠实闸的"疑似丢失(黄)"只提示不拦截。于是"页面上看得见、文档里既没有文字、也不在任何截图范围内"
 * 的内容（短标签、小面板里的字、独立按钮…）没有一道闸门会拦。本脚本把这类残留逐条找出来。
 *
 * 做法：与采集器同构导航、同一模块取几何（extractLanhuContent）→ 枚举页面全部可见文字件与控件值（逐行）→
 *       凡不在文档文字里的，按几何给出"去向"：
 *         hidden      隐形格（被后画的格盖住，页面上看不见）
 *         diagram     图示内（流程图截图 + Mermaid 覆盖）
 *         panel       mockup 面板内（界面_N 截图覆盖）
 *         band        查询条件带内（查询条件_N 截图覆盖）
 *         table       几何表内但文字没进 MD 表 —— 真漏（GAP）
 *         control     表单控件值（按钮/下拉选中项/占位），按介质忠实原则不入文字
 *         uifilter    界面噪音词（确定/取消/关闭/保存/提交…，采集器有意过滤）
 *         UNCOVERED   以上都不是 —— 页面可见、文档无文字、无截图覆盖，真漏，须逐条看
 *       另核：面板数 vs 文档 界面_ 图数（面板截图失败=该面板内容无覆盖）。
 *
 * 用法：node lanhu_uncovered_audit.js <端口> --doc "<md绝对路径>" --menu "<树内菜单名>" [--out <json>] [--min-chars 2]
 * 退出码：0=无残留；1=有 UNCOVERED/GAP/面板缺图；2=参数或连接错
 */
const fs = require('fs');
const path = require('path');
const {
  connectBrowser, getLanhuPages, enterPrototype, robustClickMenu,
  scrollToBottom, findContentFrame, Logger, extractLanhuContent,
} = require('./browser_utils');
const { resolveLanhuUrl } = require('./config_loader');

const A = {};
process.argv.slice(2).forEach((s, i, arr) => { if (s.startsWith('--')) A[s.slice(2)] = arr[i + 1]; });
const port = process.argv[2];
const docPath = A.doc, menu = A.menu;
const minChars = parseInt(A['min-chars'] || '2', 10);
if (!docPath || !menu) { console.error('need --doc --menu'); process.exit(2); }

const norm = (s) => String(s || '').replace(/\s+/g, '');
const UI_FILTER = /^(img|arrow|folder|search|button|input|icon|确定|取消|关闭|保存|提交|返回|上一步|下一步|ESC|即可退出演示模式|额，好像没有权限|知道啦|移出团队通知|你已被|移出当前团队，你可创建新的团队|创建团队|🎉|知道了|正在加载|Created with Sketch\.|sheji2|wenzi2|暂无搜索结果|more_vert|chevron_right|上传产品文档|团队共享|上传文件|支持 Word|Axure 文档上传|下载蓝湖客户端|添加文档链接|支持添加任意网页链接|在区域内点击|财务需求\d+\.rp)$/i;

(async () => {
  const logger = new Logger('lanhu_uncovered_audit');
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

  const ex = await extractLanhuContent(frame, logger);
  const sy0 = await frame.evaluate(() => window.scrollY || 0);
  // 与 extract 同一滚动状态下枚举（视口坐标）：文字件逐行 + 表单控件值
  const leaves = await frame.evaluate(() => {
    const out = [];
    const shown = (el) => { try { return el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true }) : true; } catch (e) { return true; } };
    document.querySelectorAll('[id$="_text"]').forEach((el, k) => {
      const text = (el.innerText || '').trim();
      if (!text) return;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return;
      const vis = shown(el);
      const lines = String(text).split(/\n+/).map(s => s.trim()).filter(Boolean);
      lines.forEach((ln, i) => out.push({ t: ln, top: Math.round(r.top) + i * 16, left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), tag: 'text', vis }));
    });
    document.querySelectorAll('input,select,textarea,button').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const ty = (el.type || '').toLowerCase();
      if (el.tagName === 'INPUT' && (ty === 'checkbox' || ty === 'radio' || ty === 'hidden')) return;
      let t = '';
      if (el.tagName === 'SELECT') t = el.selectedIndex >= 0 ? el.options[el.selectedIndex].text : '';
      else t = el.value || el.placeholder || '';
      t = (t || '').replace(/[\r\n]+/g, ' ').trim();
      if (!t) return;
      out.push({ t, top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), tag: 'input', vis: shown(el) });
    });
    return out;
  });
  if (opened) { try { await opened.close(); } catch (e) {} }
  await browser.close();

  // ── 文档文字（还原呈现层记号后比对）──
  const raw = fs.readFileSync(docPath, 'utf-8')
    .replace(/<br\s*\/?>/gi, '').replace(/&#124;/g, '|').replace(/#(38|34|60|62|124);/g, (_, n) => String.fromCharCode(Number(n)));
  const docNorm = norm(raw);
  const imgRefs = [...raw.matchAll(/^!\[.*?\]\((.+?)\)/gm)].map(m => m[1].split('/').pop());
  const nPanelImgs = imgRefs.filter(f => /^界面_/.test(f)).length;
  const nBandImgs = imgRefs.filter(f => /^查询条件_/.test(f)).length;
  const nDiagImgs = imgRefs.filter(f => /^流程图_/.test(f)).length;

  // ── 区域（统一成视口坐标）──
  // 隐形内容：被后画的格子盖住、页面上看不见的文字件与控件值（采集器按同一判据不入文档）——不算遗漏
  const hiddenKeys = new Set([...(ex.hidden || []), ...(ex.hiddenInputs || [])].map(h => norm(h.t) + '@' + h.y + '@' + h.x));
  // 零星单个控件：采集器有意不拍（G97：一块 ≥2 个控件才拍截图）——单独计数，不算遗漏
  const singleKeys = new Set((ex.looseSingles || []).map(h => norm(h.t) + '@' + h.y + '@' + h.x));
  const rectsOf = (arr) => (arr || []).map(r => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right }));
  const R = {
    diagram: rectsOf((ex.diagrams || []).map(d => ({ top: d.top, bottom: d.bottom, left: d.left, right: d.right }))),
    panel: rectsOf((ex.panels || []).map(p => ({ top: p.top - sy0, bottom: p.bottom - sy0, left: p.left, right: p.right }))),
    band: rectsOf(ex.bands || []),
    table: rectsOf(ex.tables || []),
  };
  const inside = (rs, L) => rs.some(r => L.left + L.w / 2 >= r.left - 2 && L.left + L.w / 2 <= r.right + 2 && L.top + 8 >= r.top - 2 && L.top + 8 <= r.bottom + 2);

  const counts = {};
  const list = { UNCOVERED: [], GAP_table: [], control_outside: [], invisible: [], sample: {} };
  for (const L of leaves) {
    const t = norm(L.t);
    if (t.length < minChars || docNorm.includes(t)) continue;
    let cls;
    if (!L.vis) cls = 'invisible';
    else if (hiddenKeys.has(t + '@' + L.top + '@' + L.left)) cls = 'hidden';
    else if (inside(R.diagram, L)) cls = 'diagram';
    else if (inside(R.panel, L)) cls = 'panel';
    else if (inside(R.band, L)) cls = 'band';
    else if (inside(R.table, L)) cls = 'GAP_table'; // 表内文字/行按钮没进 MD 表=真漏（叠放格的隐形内容已在上一行排除）
    else if (L.tag === 'input' && singleKeys.has(t + '@' + L.top + '@' + L.left)) cls = 'control_single';
    else if (L.tag === 'input') cls = UI_FILTER.test(L.t.trim()) ? 'uifilter' : 'control_outside';
    else if (UI_FILTER.test(L.t.trim())) cls = 'uifilter';
    else cls = 'UNCOVERED';
    counts[cls] = (counts[cls] || 0) + 1;
    const item = { t: L.t.slice(0, 80), top: L.top, left: L.left, tag: L.tag };
    if (cls === 'UNCOVERED' || cls === 'GAP_table' || cls === 'control_outside' || cls === 'invisible') list[cls].push(item);
    else (list.sample[cls] = list.sample[cls] || []).push(L.t.slice(0, 40));
  }
  const panelMissing = (ex.panels || []).length - nPanelImgs;
  const res = {
    menu, doc: path.basename(docPath),
    leaves: leaves.length,
    classes: counts,
    regions: { panels: (ex.panels || []).length, panelImgs: nPanelImgs, bands: (ex.bands || []).length, bandImgs: nBandImgs, diagrams: (ex.diagrams || []).length, diagramImgs: nDiagImgs, tables: (ex.tables || []).length },
    panelMissing,
    samples: Object.keys(list.sample).reduce((o, k) => { o[k] = list.sample[k].slice(0, 8); return o; }, {}),
    GAP_table: list.GAP_table.slice(0, 50),
    UNCOVERED: list.UNCOVERED.slice(0, 80),
    control_outside: list.control_outside.slice(0, 30),
    invisible: list.invisible.slice(0, 10),
    bandRects: R.band.map((r, i) => ({ i, top: r.top, bottom: r.bottom, left: r.left, right: r.right, loose: !!(ex.bands[i] || {}).loose, controls: (ex.bands[i] || {}).controls || 0 })), // 排障用：各查询条件带的矩形
  };
  if (A.out) { try { fs.writeFileSync(A.out, JSON.stringify(res, null, 1), 'utf-8'); } catch (e) { logger.warn('写结果失败: ' + e.message); } }
  console.log(JSON.stringify(res, null, 1));
  const bad = list.UNCOVERED.length + list.GAP_table.length + (panelMissing > 0 ? panelMissing : 0);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(2); });
