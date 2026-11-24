#!/usr/bin/env node
/**
 * lanhu_flowmermaid.js — 流程图拓扑重建：axure 图示（节点框 + 连接线 + 箭头）→ Mermaid 流程图源码（G91，2026-11-24）
 *
 * 为什么能"精确读出"而不靠模型看图：
 *   Axure 原生连接器经蓝湖导出后，每个箭头小图（20×20 SVG）里带整条连线路径 `M 起点 L 拐点… L 终点`，
 *   坐标 = SVG 坐标 − viewBox 左上角 + 图片在页面上的位置。节点 = 带边框矩形（_div）或菱形图片（SVG 只有 path）。
 *
 * 采信闸门（两套独立方法必须一致，否则降级为"截图 + 逐行文字"）：
 *   方法A（首选）：解析箭头 SVG 路径，起终点落到节点框上；
 *   方法B（交叉验证/兜底）：线段拼成"线束"，按箭头位置定方向。
 *   另：A 每条路径起终点都必须落在节点框上；连线数 == 箭头数；B 全部可定向。
 *
 * 用法（采集器/对账器调用）：
 *   const { rebuildFlow } = require('./lanhu_flowmermaid');
 *   const r = rebuildFlow(diagram, src => svgTextOf(src));   // r.ok / r.mermaid / r.report / r.leftover
 */
'use strict';

const fs2 = require('fs');

const TOL_NODE = 16;   // 路径端点到节点框的容差（px）
const TOL_GAP = 48;    // 端点与节点框"轴向对齐"但留缝时的容差（产品挪过框、连线没跟动，再用线段补缝）
const TOL_LABEL = 26;  // 文字到连线的最大距离（px），以内视为连线标注

const bbox = (o) => [o.x, o.y, o.x + o.w, o.y + o.h];
const distPtBbox = (p, b) => Math.hypot(Math.max(b[0] - p[0], 0, p[0] - b[2]), Math.max(b[1] - p[1], 0, p[1] - b[3]));
const inter = (a, b, tol) => a[0] - tol < b[2] && b[0] - tol < a[2] && a[1] - tol < b[3] && b[1] - tol < a[3];

/** SVG path d → 点列（M/L 取坐标；A 圆角取终点） */
function parseD(d) {
  const toks = d.match(/[MLAZ]|-?\d*\.?\d+/g) || [];
  const pts = [];
  let i = 0, cmd = null;
  while (i < toks.length) {
    const t = toks[i];
    if ('MLAZ'.includes(t)) { cmd = t; i += 1; continue; }
    if ((cmd === 'M' || cmd === 'L') && i + 1 < toks.length) { pts.push([parseFloat(toks[i]), parseFloat(toks[i + 1])]); i += 2; }
    else if (cmd === 'A' && i + 6 < toks.length) { pts.push([parseFloat(toks[i + 5]), parseFloat(toks[i + 6])]); i += 7; }
    else i += 1;
  }
  return pts;
}

/** 箭头小图 → 视口坐标下的整条折线（第二个 path=箭头头部多边形，取质心判朝向） */
function routeFromArrow(o, svg) {
  if (!svg) return null;
  const i = svg.indexOf('viewBox="');
  if (i < 0) return null;
  const vx = svg.slice(i + 9, svg.indexOf('"', i + 9)).replace(/,/g, ' ').trim().split(/\s+/).map(Number);
  if (vx.length !== 4 || vx.some(Number.isNaN)) return null;
  // 源码里有换行：d= 前只保证是空白；排除 id="… 这类以 d 结尾的属性名
  const paths = [];
  let k = 0;
  for (;;) {
    k = svg.indexOf('d="', k);
    if (k < 0) break;
    if (k > 0 && /\s/.test(svg[k - 1])) { const e = svg.indexOf('"', k + 3); if (e < 0) break; paths.push(svg.slice(k + 3, e)); k = e + 1; }
    else k += 3;
  }
  if (!paths.length) return null;
  const sx = vx[2] ? o.w / vx[2] : 1, sy = vx[3] ? o.h / vx[3] : 1;
  const raw = parseD(paths[0]);
  if (raw.length < 2) return null;
  let pts = raw.map(([x, y]) => [o.x + (x - vx[0]) * sx, o.y + (y - vx[1]) * sy]);
  if (paths.length > 1) {
    const hp = parseD(paths[1]);
    if (hp.length) {
      const hx = o.x + (hp.reduce((s, p) => s + p[0], 0) / hp.length - vx[0]) * sx;
      const hy = o.y + (hp.reduce((s, p) => s + p[1], 0) / hp.length - vx[1]) * sy;
      if (Math.hypot(hx - pts[0][0], hy - pts[0][1]) < Math.hypot(hx - pts[pts.length - 1][0], hy - pts[pts.length - 1][1])) pts.reverse();
    }
  }
  return pts;
}

/** 路径端点 → 节点：先按 16px 贴框；不中则允许"轴向对齐 + 缝隙 ≤48px"（且只能对上一个节点）。返回 [距离, 下标] 或 null */
function nodeAt(p, nodes) {
  let best = null;
  nodes.forEach((b, i) => { const d = distPtBbox(p, b); if (d <= TOL_NODE && (!best || d < best[0])) best = [d, i]; });
  if (best) return best;
  const align = [];
  nodes.forEach((b, i) => {
    const dx = Math.max(b[0] - p[0], 0, p[0] - b[2]), dy = Math.max(b[1] - p[1], 0, p[1] - b[3]);
    if ((dx <= 8 || dy <= 8) && Math.hypot(dx, dy) <= TOL_GAP) align.push([Math.hypot(dx, dy), i]);
  });
  return align.length === 1 ? align[0] : null;
}

/** 文字框到折线的近似距离 */
function polylineDist(rect, pts) {
  let best = Infinity;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [x1, y1] = pts[k], [x2, y2] = pts[k + 1];
    const n = Math.max(2, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 4));
    for (let j = 0; j <= n; j++) { const t = j / n; best = Math.min(best, distPtBbox([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t], rect)); }
  }
  return best;
}

/** 方法B：线段拼成线束，按箭头位置定方向。返回 [[源, 目标, 状态]] */
function methodB(lines, dots, nodes) {
  const segs = lines.filter(o => Math.max(o.w, o.h) >= 2 * Math.max(1, Math.min(o.w, o.h)));
  const par = segs.map((_, i) => i);
  const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    if (inter(bbox(segs[i]), bbox(segs[j]), 2)) { const a = find(i), b = find(j); if (a !== b) par[a] = b; }
  }
  const wires = new Map();
  segs.forEach((s, i) => { const r = find(i); if (!wires.has(r)) wires.set(r, []); wires.get(r).push(s); });
  const edges = [];
  for (const ws of wires.values()) {
    const attached = nodes.map((b, i) => i).filter(i => ws.some(s => inter(nodes[i], bbox(s), 14)));
    const arrs = dots.filter(a => ws.some(s => inter(bbox(a), bbox(s), 10)));
    if (!arrs.length) { for (let k = 0; k + 1 < attached.length; k++) edges.push([attached[k], attached[k + 1], 'noarrow']); continue; }
    const targets = [];
    for (const a of arrs) {
      const c = [a.x + a.w / 2, a.y + a.h / 2];
      let cand = attached.filter(i => inter(nodes[i], bbox(a), 14)).map(i => [distPtBbox(c, nodes[i]), i]);
      if (!cand.length) {
        const near = nodes.map((b, i) => [distPtBbox(c, b), i]).sort((p, q) => p[0] - q[0]);
        cand = near.length && near[0][0] <= TOL_GAP ? [near[0]] : [];
      }
      if (cand.length) targets.push(cand.sort((p, q) => p[0] - q[0])[0][1]);
    }
    const sources = attached.filter(i => !targets.includes(i));
    for (const t of targets) {
      if (sources.length) sources.forEach(s => edges.push([s, t, 'ok']));
      else edges.push([-1, t, 'undirected']);
    }
  }
  return edges;
}

function shapeOf(c, svg) {
  if (c.tag !== 'DIV') {
    if (/<path/.test(svg) && !/<rect/.test(svg)) return 'diamond';
    if (/<ellipse|<circle/.test(svg)) return 'round';
    return 'rect';
  }
  const r = parseFloat(String(c.radius || '0')) || 0;
  return r >= 8 ? 'round' : 'rect';
}

/** Mermaid 标签转义：先转义特殊字符（数字实体），再把换行变成 <br>（顺序不能反）。对账器按同一张表还原 */
const MM_ESC = { '&': '#38;', '"': '#34;', '<': '#60;', '>': '#62;', '|': '#124;' };
const mmText = (t) => String(t).replace(/[&"<>|]/g, ch => MM_ESC[ch]).replace(/\r?\n/g, '<br>');
const mmUnescape = (t) => t.replace(/#(38|34|60|62|124);/g, (_, n) => String.fromCharCode(Number(n)));

/**
 * 重建一张图示的拓扑
 * @param {object} dg  extractLanhuContent 返回的 diagrams[i]（含 geo{cells,lines,dots} 与 items[{x,y,w,h,text}]）
 * @param {(src:string)=>string|undefined} svgOf  图片 src → SVG 源码
 * @returns {{ok:boolean, mermaid?:string, leftover:string[], report:object}}
 *   leftover = 图内但没归到任何节点/连线的文字（必须原样留在文档里，不能因为出了流程图而丢）
 */
function rebuildFlow(dg, svgOf) {
  const rep = { nodes: 0, arrows: 0, methodA: 0, methodB: 0, bad: [], gaps: [], agree: false, dirOk: false };
  const geo = dg.geo || {};
  if (!geo.cells || !geo.dots || !geo.lines || geo.dots.length < 2 || geo.cells.length < 2 || geo.cells.length > 60) {
    return { ok: false, leftover: (dg.items || []).map(t => t.text), report: Object.assign(rep, { skip: '非节点+箭头结构' }) };
  }
  const svgCache = new Map();
  const svg = (src) => { if (!svgCache.has(src)) svgCache.set(src, (svgOf && svgOf(src)) || ''); return svgCache.get(src); };
  let cells = geo.cells.slice().map(c => Object.assign({}, c, { bbox: bbox(c) })).sort((a, b) => a.y - b.y || a.x - b.x);
  const items = dg.items || [];
  const centerIn = (t, b) => { const cx = t.x + t.w / 2, cy = t.y + t.h / 2; return b[0] <= cx && cx <= b[2] && b[1] <= cy && cy <= b[3]; };
  // 无文字且没有任何路径端点落上的"格子"不是节点（标签底框之类）
  {
    const touched = new Set();
    geo.dots.forEach(a => { const r = routeFromArrow(a, svg(a.src)); if (!r) return; [r[0], r[r.length - 1]].forEach(p => { const n = nodeAt(p, cells.map(c => c.bbox)); if (n) touched.add(n[1]); }); });
    cells = cells.filter((c, i) => items.some(t => centerIn(t, c.bbox)) || touched.has(i));
  }
  const nodes = cells.map(c => ({ bbox: c.bbox, shape: shapeOf(c, svg(c.src)), texts: items.filter(t => centerIn(t, c.bbox)).sort((a, b) => a.y - b.y || a.x - b.x) }));
  const free = items.filter(t => !nodes.some(n => n.texts.includes(t)));
  nodes.forEach(n => { n.label = n.texts.map(t => mmText(t.text)).join('<br>'); });
  // —— 方法 A ——
  const edgesA = [];
  geo.dots.forEach(a => {
    const pts = routeFromArrow(a, svg(a.src));
    if (!pts) { rep.bad.push({ arrow: [a.x, a.y], why: '无路径' }); return; }
    const s = nodeAt(pts[0], nodes.map(n => n.bbox)), t = nodeAt(pts[pts.length - 1], nodes.map(n => n.bbox));
    if (!s || !t || s[1] === t[1]) { rep.bad.push({ arrow: [a.x, a.y], why: '端点未落在节点上' }); return; }
    [['起点', s], ['终点', t]].forEach(([end, nd]) => { if (nd[0] > TOL_NODE) rep.gaps.push({ end, px: Math.round(nd[0]) }); });
    edgesA.push({ s: s[1], t: t[1], pts, label: null });
  });
  // 连线标注：离哪条连线最近就归哪条（并列最近的不归）
  const leftover = [];
  free.forEach(ft => {
    const ds = edgesA.map((e, k) => [polylineDist(bbox(ft), e.pts), k]).sort((p, q) => p[0] - q[0]);
    if (ds.length && ds[0][0] <= TOL_LABEL && (ds.length === 1 || ds[0][0] < ds[1][0] - 2)) {
      const e = edgesA[ds[0][1]];
      e.label = (e.label ? e.label + '<br>' : '') + mmText(ft.text);
    } else leftover.push(ft.text);
  });
  // —— 方法 B 交叉验证 ——
  const edgesB = methodB(geo.lines, geo.dots, nodes.map(n => n.bbox));
  const key = (a, b) => Math.min(a, b) + ':' + Math.max(a, b);
  const setA = edgesA.map(e => key(e.s, e.t)).sort(), setB = edgesB.map(e => key(e[0], e[1])).sort();
  rep.setA = setA; rep.setB = setB;
  rep.dirOk = edgesB.every(e => e[2] === 'ok');
  rep.agree = setA.length === setB.length && setA.every((v, i) => v === setB[i]);
  Object.assign(rep, { nodes: nodes.length, arrows: geo.dots.length, methodA: edgesA.length, methodB: edgesB.length });
  const ok = rep.bad.length === 0 && rep.agree && edgesA.length === geo.dots.length && rep.dirOk;
  if (!ok) return { ok: false, leftover: items.map(t => t.text), report: rep };
  // —— 流向：看箭头"进入目标节点"的方向（取路径末段里第一条 ≥20px 的线段）——
  //    多数横向进入=LR，多数纵向进入=TD（不能按外框宽高判：上下结构的树常常"又宽又矮"）
  const enterDir = (pts) => { for (let k = pts.length - 2; k >= 0; k--) { if (Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]) >= 20) return Math.abs(pts[k + 1][0] - pts[k][0]) > Math.abs(pts[k + 1][1] - pts[k][1]) ? 'H' : 'V'; } return 'H'; };
  const horiz = edgesA.filter(e => enterDir(e.pts) === 'H').length;
  const orient = horiz * 2 >= edgesA.length ? 'LR' : 'TD';
  // 分支顺序与原图一致（Mermaid 按声明序排分支）：LR 按连线最上沿，TD 按终点横坐标
  edgesA.sort(orient === 'LR' ? (a, b) => a.s - b.s || Math.round(Math.min(...a.pts.map(p => p[1])) / 10) - Math.round(Math.min(...b.pts.map(p => p[1])) / 10) || a.pts[a.pts.length - 1][1] - b.pts[b.pts.length - 1][1]
    : (a, b) => a.s - b.s || a.pts[a.pts.length - 1][0] - b.pts[b.pts.length - 1][0]);
  const lines = ['flowchart ' + orient];
  nodes.forEach((n, i) => { const lab = n.label || ' '; lines.push(n.shape === 'diamond' ? `  n${i}{"${lab}"}` : n.shape === 'round' ? `  n${i}("${lab}")` : `  n${i}["${lab}"]`); });
  edgesA.forEach(e => { lines.push(e.label ? `  n${e.s} -->|"${e.label}"| n${e.t}` : `  n${e.s} --> n${e.t}`); });
  return { ok: true, mermaid: lines.join('\n'), leftover, report: Object.assign(rep, { orient }) };
}

/**
 * 存进文档的"不可见结构块"（G92，2026-11-24 用户拍板展示原则：蓝湖怎么展示，文档就怎么展示，且任何工具打开都要看得到流程图）：
 *   文档里只展示图（原图截图 + 重绘流程图），结构文字放进 HTML 注释——人看不到，读文档的技能/模型读得到。
 *   注意 Mermaid 的箭头 `-->` 恰好是 HTML 注释的结束符，直接放进去会把注释提前关掉；
 *   存入时改写成 Mermaid 同样支持的粗箭头 `==>`（拓扑不变）。标签里若真含 `-->` 之类序列则不能入注释（返回 ok=false，调用方退回可见代码块）。
 */
const FLOW_MARK = '流程图结构（Mermaid）';
function hiddenSource(mermaid) {
  const src = String(mermaid).replace(/\s+$/, '');
  // 标签文字里带 "-->" 的：改写箭头会连标签一起改（节点文字就不逐字了）→ 不能入注释，由调用方退回可见代码块
  //（逐个标签判，不能用 "[^"]*-->[^"]*" 一把抓——那会把前一个标签的收尾引号和后一个标签的起始引号配成一对，正常情况也误判）
  const labels = src.match(/"[^"]*"/g) || [];
  if (labels.some(x => /-->|--!>|<!--/.test(x))) return { ok: false };
  const body = src.replace(/-->/g, '==>');
  if (/-->|--!>|<!--/.test(body)) return { ok: false };
  return { ok: true, text: '<!-- ' + FLOW_MARK + '\n' + body + '\n-->' };
}

/**
 * 2 倍像素截图（G92）：直接走 CDP Page.captureScreenshot——Playwright 的 page.screenshot 会把图归一成 1 倍像素尺寸，
 * 即使设备像素密度已设成 2（实测：同一区域 page.screenshot 200x100、CDP 直拍 400x200）。clip 用 CSS 像素坐标。
 */
async function cdpShot2x(cdp, clip, file) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip: Object.assign({ scale: 1 }, clip), captureBeyondViewport: false });
  fs2.writeFileSync(file, Buffer.from(r.data, 'base64'));
}

module.exports = { rebuildFlow, mmText, mmUnescape, hiddenSource, FLOW_MARK, cdpShot2x };
