// browser_pool.js — 浏览器实例调度器（执行测试前自动选空闲实例，全忙则起新端口并登录）
// 依据《浏览器实例调度标准》（执行操作细则 §X）
// 用法:
//   node browser_pool.js acquire "用途说明"     → 输出 JSON {port, started, login} 并上锁
//   node browser_pool.js release <port>         → 解锁（实例保留复用）
//   node browser_pool.js status                 → 列全部实例状态
const { execSync, spawnSync } = require('child_process');
const os = require('os');
const path = require('path');
// 2026-11-16 分发修复：playwright 改三级 fallback（原写死 WorkBuddy 绝对路径，同事机必挂）
const { chromium } = (() => {
  for (const m of ['playwright', 'd:/ZCodetest/ai-test-bench/node_modules/playwright',
                   'd:/WorkBuddy-projects/testcase/node_modules/playwright']) {
    try { return require(m); } catch (e) { /* 试下一级 */ }
  }
  throw new Error('playwright 三级 fallback 全失败：请在 D:/ZCodetest 下 npm i playwright 后重试');
})();
const fs = require('fs');

const BASE = 9333, MAX = 9345;
// 2026-11-13 补强（坑库 G33）：9335=cdp_pool、9336=pw_layered 是别家框架自管实例——
// 它们不认本池的锁且会主动回收页签（11-12 实录：cdp_pool 关掉了本池租户的菜单页签），永不复用/不租借
const EXCLUDE = new Set([9335, 9336]);
// 判忙要扫"全部"页签：pages[0] 是新标签页、pages[1] 是他人业务页的单页签漏判（11-12 实录）
const IDLE_URL_RE = /welcome|blank|newtab|dashboard|chrome:|about:|^no-page/;
// 2026-11-16 分发修复：锁目录随脚本所在目录走（原写死 D:/ZCodetest）；技能位按当前用户主目录解析（原写死发起人用户名，同事机必挂）
const LOCK_DIR = path.join(__dirname, 'locks');
const SKILL_SCRIPTS = path.join(os.homedir(), '.zcode', 'skills', 'jingtian-login', 'scripts');
const LAUNCH_TPL = path.join(SKILL_SCRIPTS, 'launch_chrome_9333.ps1');
const LOGIN_TPL = path.join(SKILL_SCRIPTS, 'chrome_jt_login.js');

function alive(port) {
  try { execSync(`curl -s --max-time 2 http://127.0.0.1:${port}/json/version`, { stdio: 'pipe' }); return true; } catch (e) { return false; }
}
function lockOf(port) {
  const f = `${LOCK_DIR}/${port}.lock`;
  if (!fs.existsSync(f)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const age = (Date.now() - new Date(j.ts).getTime()) / 60000;
    // 60 分钟超时自动失效（长跑批须周期 touch 续租，见 pool_run.sh 心跳；MSYS pid 在 tasklist 查不到，pid 判活不可靠故不用）
    if (age > 60) { fs.unlinkSync(f); return null; }
    return j;
  } catch (e) { fs.unlinkSync(f); return null; }
}
function touchLock(port) { // 续租：刷新 ts（长跑批防超时收编）
  const f = `${LOCK_DIR}/${port}.lock`;
  if (!fs.existsSync(f)) return false;
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); j.ts = new Date().toISOString(); fs.writeFileSync(f, JSON.stringify(j)); return true; } catch (e) { return false; }
}
function lock(port, purpose) {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  fs.writeFileSync(`${LOCK_DIR}/${port}.lock`, JSON.stringify({ port, purpose, ts: new Date().toISOString(), pid: process.ppid }));
}
function unlock(port) { try { fs.unlinkSync(`${LOCK_DIR}/${port}.lock`); } catch (e) {} }

async function readUrlOnly(port) {
  // 只读现场：拿【全部】页签 URL（不点击不导航）；返回数组，任一非空闲=有人在用
  try {
    const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 4000 });
    const urls = [];
    for (const ctx of b.contexts()) for (const p of ctx.pages()) {
      urls.push(await Promise.race([p.url(), new Promise(r => setTimeout(() => r('timeout'), 2000))]));
    }
    await b.close();
    return urls.length ? urls : ['no-page'];
  } catch (e) { return ['unreachable']; }
}

async function startInstance(port) {
  const tplRaw = fs.readFileSync(LAUNCH_TPL, 'utf-8');
  const tpl = ((typeof HD !== 'undefined') && HD)
    ? tplRaw.split('\n').filter(l => !/headless=new/.test(l) && !/--disable-gpu/.test(l)).join('\n')
        .replace(/9333/g, String(port)).replace(/\.chrome-cdp(?!\d)/g, `.chrome-cdp-${port}`)
    : tplRaw.replace(/9333/g, String(port)).replace(/\.chrome-cdp(?!\d)/g, `.chrome-cdp-${port}`);
  const ps1 = `${LOCK_DIR}/launch_${port}.ps1`;
  fs.writeFileSync(ps1, tpl);
  execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`, { stdio: 'pipe', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));
  if (!alive(port)) throw new Error(`实例 ${port} 启动后端口未监听`);
}

async function loginInstance(port) {
  const js = fs.readFileSync(LOGIN_TPL, 'utf-8').replace(/http:\/\/127\.0\.0\.1:9333/g, `http://127.0.0.1:${port}`);
  const f = `${LOCK_DIR}/login_${port}.js`;
  fs.writeFileSync(f, js);
  try {
    const out = execSync(`node "${f}"`, { stdio: 'pipe', timeout: 120000, cwd: __dirname }).toString();
    return /logged-in|already-logged-in/.test(out);
  } catch (e) { return false; }
}

async function acquire(purpose, startPort) {
  const HD = false;
  const report = [];
  // 第一轮：找 [活着 且 无锁] 的实例直接复用——启动≠占用，无锁即可用（现场URL仅记录参考）
  for (let port = (startPort || BASE); port <= MAX; port++) {
    if (EXCLUDE.has(port)) { continue; } // 9335/9336 别家框架自管，不租不借
    const a = alive(port), l = lockOf(port);
    report.push(`:${port} alive=${a} lock=${l ? l.purpose.slice(0, 12) : '-'}`);
    if (a && !l) {
      const urls = await readUrlOnly(port);
      // 保守判定：任一页签停在业务页=可能有人在用（对方没上锁），跳到下一个
      const allIdle = urls.every(u => IDLE_URL_RE.test(String(u)));
      if (allIdle) {
        lock(port, purpose);
        console.log(JSON.stringify({ port, reused: true, pages: urls.length, note: '空闲复用' }));
        return;
      }
      report[report.length - 1] += ` 现场=${String(urls.find(u => !IDLE_URL_RE.test(String(u)))).slice(0, 50)}(跳过)`;
    }
  }
  // 第二轮：全部有锁（或没有活实例）→ 从最小未占端口起新（9333 共用实例永不"新起"，只允许第一轮空闲复用）
  for (let port = BASE + 1; port <= MAX; port++) {
    if (EXCLUDE.has(port)) continue;
    if (!alive(port)) {
      await startInstance(port);
      await new Promise(r => setTimeout(r, 3000));
      if (!alive(port)) { console.log(JSON.stringify({ error: `start-fail:${port}` })); return; }
      const loginOk = await loginInstance(port);
      lock(port, purpose);
      console.log(JSON.stringify({ port, started: true, login: loginOk, note: `全部占用→新起${loginOk ? '并已登录' : '，登录失败需人工重试一次'}` }));
      return;
    }
  }
  console.log(JSON.stringify({ error: 'no-free-port', report }));
}

async function main() {
  const [cmd, arg1, arg2] = process.argv.slice(2);
  if (cmd === 'acquire') await acquire(arg1 || '未注明用途', arg2 ? parseInt(arg2, 10) : undefined);
  else if (cmd === 'touch') console.log(JSON.stringify({ touched: arg1, ok: touchLock(parseInt(arg1, 10)) }));
  else if (cmd === 'release') {
    const port = parseInt(arg1);
    try {
      const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5000 });
      const p = b.contexts()[0]?.pages()?.[0];
      if (p) await p.goto('http://jt-ll.test.ztoeco.com/welcome', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await b.close();
    } catch (e) {}
    unlock(port);
    console.log(JSON.stringify({ released: port, reset: 'welcome' }));
  }
  else if (cmd === 'status') {
    for (let port = BASE; port <= MAX; port++) {
      const a = alive(port), l = lockOf(port);
      if (a || l) console.log(`:${port} alive=${a} lock=${l ? `${l.purpose}(${new Date(l.ts).toLocaleTimeString()})` : '无'}`);
    }
  } else console.log('用法: node browser_pool.js acquire "<用途>" | release <port> | status');
}
main().catch(e => { console.error('FATAL:', e.message.slice(0, 100)); process.exit(1); });
