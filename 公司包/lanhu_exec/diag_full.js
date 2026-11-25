#!/usr/bin/env node
/**
 * diag_full.js — 诊断/回归（只读）：用 extractLanhuContent 在线取某菜单的"毛坯" md（采集器后处理之前的原始提取结果），落到 --out。
 *
 * 用途：改了采集器的提取逻辑后，证明"只改了要改的、没改坏别的菜单"——同一菜单，用修改前与修改后的 browser_utils 各提取一次，逐字比对。
 *      必须毛坯对毛坯：拿毛坯去比落盘的成品会满屏假差异（@@TBAND@@ 标记、查询条件带文字、流程图节点标签是成品阶段才处理的）。
 *
 * 用法（经浏览器池：POOL_START=9334 bash ../jt_exec/pool_run.sh <本脚本绝对路径> …）：
 *   ① 建基准（修改前版本 = git 里某个提交；基准目录放 out/ 下，不入库）：
 *        node diag_full.js --make-baseline <基准目录> [--rev HEAD~1]
 *      把该版本的公司包/lanhu_exec/browser_utils.js 导出到基准目录，并放一张 config_loader 转发片
 *      （蓝湖地址配置只存在正式目录一份，不往基准目录复制；没有转发片，基准版按"自己所在目录"找配置 → 取不到地址 → 进不了原型）。
 *   ② 提取：
 *        … --menu "<树内菜单名>" --out <绝对路径.md>                        # 修改后（工作区现行代码）
 *        … --menu "<树内菜单名>" --out <绝对路径.md> --impl before --base <基准目录>   # 修改前
 *   ③ 比对两份 md（逐行 diff）。预期只有要改的菜单有差异，其余逐字相同。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const A = {};
process.argv.slice(2).forEach((s, i, arr) => { if (s.startsWith('--')) A[s.slice(2)] = arr[i + 1]; });

if (A['make-baseline']) {
  const base = path.resolve(A['make-baseline']);
  const rev = A.rev || 'HEAD~1';
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: __dirname, encoding: 'utf8' }).trim();
  const rel = path.relative(root, __dirname).split(path.sep).join('/');           // 仓库根到本目录的相对路径（如 公司包/lanhu_exec）
  const src = execFileSync('git', ['show', rev + ':' + rel + '/browser_utils.js'], { cwd: root, maxBuffer: 64 << 20 });
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'browser_utils.js'), src);
  const up = path.relative(base, __dirname).split(path.sep).join('/');           // 从基准目录到本目录的相对路径（转发片按自己所在目录解析）
  fs.writeFileSync(path.join(base, 'config_loader.js'),
    '// 基准环境转发片：地址解析与被测的几何代码无关，统一转发到正式目录的 config_loader（蓝湖地址配置只存在正式目录一份）。\n' +
    'module.exports = require(require(\'path\').join(__dirname, ' + JSON.stringify(up) + ', \'config_loader.js\'));\n');
  console.log('基准已建：' + base + '（' + rev + ' 的 ' + rel + '/browser_utils.js，' + src.length + ' 字节）');
  process.exit(0);
}

const menu = A.menu, out = A.out;
if (!menu || !out) { console.error('need --menu --out（或 --make-baseline <目录>）'); process.exit(2); }
let implDir = __dirname;
if (A.impl === 'before') {
  if (!A.base) { console.error('--impl before 需要 --base <基准目录>（先跑 --make-baseline）'); process.exit(2); }
  implDir = path.resolve(A.base);
  if (!fs.existsSync(path.join(implDir, 'browser_utils.js'))) { console.error('基准目录里没有 browser_utils.js：' + implDir); process.exit(2); }
}
const { connectBrowser, getLanhuPages, enterPrototype, robustClickMenu, scrollToBottom, findContentFrame, Logger, extractLanhuContent } = require(path.join(implDir, 'browser_utils.js'));
const { resolveLanhuUrl } = require(path.join(implDir, 'config_loader.js'));

(async () => {
  const logger = new Logger('diag_full');
  const browser = await connectBrowser(logger);
  let pages = await getLanhuPages(browser);
  let page = pages[0], opened = null;
  if (!page) {
    const ctx = browser.contexts()[0] || await browser.newContext();
    page = await ctx.newPage(); opened = page;
    await page.goto(resolveLanhuUrl(), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3500);
    await enterPrototype(page, logger);
  }
  await robustClickMenu(page, menu, logger);
  const frame = await findContentFrame(page, logger);
  if (!frame) { console.error('NO_FRAME'); process.exit(2); }
  await scrollToBottom(frame, logger);
  const ex = await extractLanhuContent(frame, logger);
  if (opened) { try { await opened.close(); } catch (e) {} }
  await browser.close();
  fs.writeFileSync(out, String(ex.md || ''), 'utf-8');
  console.log('written ' + out + ' (' + String(ex.md || '').split('\n').length + ' lines' + (A.impl === 'before' ? '，修改前基准 ' + implDir : '，工作区现行代码') + ')');
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(2); });
