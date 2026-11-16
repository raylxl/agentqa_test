/**
 * CDP 实例池（分层执行模式 · 拍板#2：探测占用→用空闲端口→不够就新开）
 *
 * 用法：
 *   node cdp_pool.js                 # 探测 9333~9338，打印状态表
 *   node cdp_pool.js --ensure-exec   # 拿执行端口：优先已活的执行段端口(9334+)，没有则在第一个空闲端口新开无头实例
 *
 * 约定：9333=交互主实例（有头，对话/探索用，不抢）；9334~9338=执行段；
 *       新实例 profile=D:\ZCodetest\.chrome-cdp-<port>（独立目录，登录态各自持久化）
 * 启动参数与 launch_chrome_9333.ps1 一致（防 https 升级三参数为红线，缺了 SSO 链路断）
 */
const { spawn } = require('child_process');
const http = require('http');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORTS = [9333, 9334, 9335, 9336, 9337, 9338];
// 自动选择顺序：9335=执行专用实例（历史拍板）→ 9336+ 空闲新开；
// 9334=遗留执行实例、占用方可能不明，仅 --port 9334 显式指定才用（拍板#2：不抢被占用的）
const AUTO_ALIVE = [9335];
const AUTO_NEW = [9336, 9337, 9338];
const EXEC_PORTS = PORTS.filter(p => p >= 9334);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function probe(port) {
  return new Promise(res => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 2000 }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try {
          const j = JSON.parse(d);
          res({ port, alive: true, browser: j.Browser, headless: /headless/i.test(j['User-Agent'] || '') });
        } catch { res({ port, alive: false }); }
      });
    });
    req.on('timeout', () => { req.destroy(); res({ port, alive: false }); });
    req.on('error', () => res({ port, alive: false }));
  });
}

function launch(port) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=D:\\ZCodetest\\.chrome-cdp-${port}`,
    '--no-first-run', '--no-default-browser-check', '--ignore-certificate-errors',
    '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,HttpsFirstModeV2ForEngagedSites',
    '--headless=new', '--disable-gpu', '--window-size=1920,1080',
  ];
  spawn(CHROME, args, { detached: true, stdio: 'ignore' }).unref();
}

async function ensureExecPort(verbose) {
  for (const p of AUTO_ALIVE) {
    const s = await probe(p);
    const lk = s.alive ? readLock(p) : null;
    if (s.alive && !lk) { if (verbose) console.log(`[pool] 复用执行专用实例 port=${p}`); return s; }
    if (lk && verbose) console.log(`[pool] ${p} 被「${lk.purpose}」持锁，跳过`); // 2026-11-09：有锁不复用（其余行为不变）
  }
  for (const p of AUTO_NEW) {
    const s = await probe(p);
    if (!s.alive) {
      launch(p);
      for (let i = 0; i < 10; i++) {
        await sleep(1000);
        const s2 = await probe(p);
        if (s2.alive) { if (verbose) console.log(`[pool] 新开无头实例 port=${p}`); return s2; }
      }
      throw new Error(`端口 ${p} 启动失败`);
    }
  }
  throw new Error('执行段端口耗尽（9334~9338）');
}

// ── 独占调度（2026-11-09 多会话撞车教训：两个会话同用 9335——同实例共用 localStorage token，任一会话切租户，全实例页面同变）──
const fs = require('fs');
const path = require('path');
// 锁与 jt_chrome/browser_pool.js 同目录同格式（{port,purpose,ts,pid}，60 分钟过期）——两套调度器互认
const LOCK_DIR = 'D:/ZCodetest/jt_chrome/locks';
const LOCK_TTL_MIN = 60;
function readLock(port) {
  const f = `${LOCK_DIR}/${port}.lock`;
  if (!fs.existsSync(f)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
    if ((Date.now() - new Date(j.ts).getTime()) / 60000 > LOCK_TTL_MIN) return null; // 过期视同无锁
    return j;
  } catch (_) { return null; }
}
function writeLock(port, purpose) { // 也用作心跳：重写时间戳
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  fs.writeFileSync(`${LOCK_DIR}/${port}.lock`, JSON.stringify({ port, purpose, ts: new Date().toISOString(), pid: process.pid }));
}
function removeLock(port) { try { fs.unlinkSync(`${LOCK_DIR}/${port}.lock`); } catch (_) {} }

// 占用检测：任一页签停在业务路由（#/…）即视为有人在用——browser_pool 只看第一个页签，曾把别人正在用的 9335 判为空闲
async function busyPages(port) {
  try {
    const { chromium } = require(path.join('D:', 'ZCodetest', 'ai-test-bench', 'node_modules', 'playwright'));
    const b = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 5000 });
    const urls = [];
    for (const c of b.contexts()) for (const pg of c.pages()) { try { urls.push(pg.url()); } catch (_) {} }
    await b.close(); // 只断 CDP 连接，不关浏览器
    return urls.filter(u => /jt-ll\.test\.ztoeco\.com\/(app\/)?#\//.test(u));
  } catch (_) { return ['(实例不可达)']; }
}

/**
 * 独占取实例（pw_layered 回归用）：prefer 顺序逐个看——活着 且 无有效锁 且 无业务页签 → 上锁取用；
 * 都不满足 → 在第一个未启动的端口新开无头实例并上锁。调用方每条用例 writeLock 心跳（防长批次超 60 分钟锁过期），结束 removeLock
 */
async function ensureExecPortExclusive({ prefer = [9336, 9337, 9338], purpose = 'pw_layered脚本回归', verbose = false } = {}) {
  const log = (...a) => { if (verbose) console.log('[pool]', ...a); };
  for (const p of prefer) {
    const s = await probe(p);
    if (!s.alive) continue;
    const lk = readLock(p);
    if (lk) { log(`跳过 ${p}：被「${lk.purpose}」持锁`); continue; }
    const busy = await busyPages(p);
    if (busy.length) { log(`跳过 ${p}：有业务页签 ${busy[0].slice(0, 70)}`); continue; }
    writeLock(p, purpose);
    log(`独占取用 port=${p}（已上锁）`);
    return s;
  }
  for (const p of prefer) {
    const s = await probe(p);
    if (s.alive) continue;
    launch(p);
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      const s2 = await probe(p);
      if (s2.alive) { writeLock(p, purpose); log(`新开无头实例 port=${p}（已上锁）`); return s2; }
    }
    throw new Error(`端口 ${p} 启动失败`);
  }
  throw new Error('独占端口均被占用：' + prefer.join('/'));
}

module.exports = { probe, ensureExecPort, ensureExecPortExclusive, readLock, writeLock, removeLock, busyPages, launch, PORTS, EXEC_PORTS };

if (require.main === module) {
  (async () => {
    if (process.argv.includes('--ensure-exec')) {
      const s = await ensureExecPort(true);
      console.log(`EXEC_PORT=${s.port} ${s.browser || ''}`);
      return;
    }
    for (const p of PORTS) {
      const r = await probe(p);
      console.log(`${String(r.port).padEnd(6)} ${r.alive ? 'ALIVE ' + (r.headless ? '(headless)' : '(headed)  ') + ' ' + (r.browser || '') : 'free'}`);
    }
  })().catch(e => { console.error('ERR', e.message); process.exit(1); });
}
