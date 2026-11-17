/**
 * 项目管理中心登录（Chrome 9333 · pm-center-login 技能自带脚本）
 *
 * 策略（用户指定 2026-10-27）：
 *   1) 已登录（project-manage 且菜单可见）→ 直接返回
 *   2) SSO 页有账密表单 → 填账密提交（读公司层凭证文件 agent-secrets.json 的 pm_login 字段）
 *   3) 无表单（统一入口现状）→ 点"一键登录"（注意：是 div 不是 button）
 *   4) 出现"人脸验证"提示 → 控制台大字提醒用户去手机宝盒操作，轮询等待（默认 240s），
 *      用户完成后页面自动跳转
 *
 * 用法：node pm_center_login.js [等待人脸验证秒数，默认240]
 * 输出：RESULT: already-logged-in | login-success(password) | login-success(oneclick) | login-timeout
 */
const path = require('path');

let chromium;
try { chromium = require('playwright').chromium; }
catch (_) { console.error('找不到 playwright：重跑部署器自动安装，或在部署根执行 npm i playwright'); process.exit(1); }

const PM_URL = 'http://project-manage.ztll-cpx.ft.ztoeco.com/';
// 账密只存公司层私有凭证文件（2026-11-14 拍板：技能/脚本零明文账密；接入方法见手艺包 02_提示词与模板/07）
// 文件路径可用 PM_SECRETS 重定向
// 凭证文件定位（2026-11-14 目录化重构·改名免疫）：环境变量 → 自身逐级上溯，每级查本目录及其一级子目录内的 agent-secrets.json
function _secretsPath(envName) {
  const fs = require('fs'), path = require('path');
  if (process.env[envName]) return process.env[envName];
  let dir = fs.realpathSync(__dirname);
  for (let i = 0; i < 5; i++) {
    const c = path.join(dir, 'agent-secrets.json');
    if (fs.existsSync(c)) return c;
    try {
      for (const n of fs.readdirSync(dir)) {
        const s = path.join(dir, n, 'agent-secrets.json');
        if (fs.existsSync(s)) return s;
        try {
          for (const m of fs.readdirSync(path.join(dir, n))) {
            const s2 = path.join(dir, n, m, 'agent-secrets.json');
            if (fs.existsSync(s2)) return s2;
          }
        } catch (e2) {}
      }
    } catch (e) {}
    dir = path.dirname(dir);
  }
  return path.join(dir, 'agent-secrets.json');
}
let _pm = {};
try {
  _pm = JSON.parse(require('fs').readFileSync(_secretsPath('PM_SECRETS'), 'utf8')).pm_login || {};
} catch (e) { console.error('读公司层凭证文件失败（agent-secrets.json）：' + e.message); }
const ACCOUNT = _pm.user;
const SECRET = _pm.pass;
if (!ACCOUNT || !SECRET) { console.error('未取到账密：检查公司层凭证文件 agent-secrets.json 的 pm_login 字段'); process.exit(1); }
const FACE_WAIT_MS = (parseInt(process.argv[2], 10) || 240) * 1000;
const SHOT_DIR = __dirname;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const visCount = page => page.evaluate(() => [...document.querySelectorAll('input')].filter(el => el.offsetWidth || el.offsetHeight).length).catch(() => 0);
const bodyText = (page, n = 200) => page.evaluate(s => document.body.innerText.replace(/\s+/g, ' ').slice(0, s), n).catch(() => '');
const isPMHome = url => url.includes('project-manage') && !url.includes('oauth');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333', { timeout: 10000 });
  const ctx = browser.contexts()[0];
  const all = () => ctx.pages();

  // 1) 找页签：project-manage 或其 SSO 链（统一入口/测试SSO），否则新开
  let tab = all().find(p => /project-manage|sso\.zt-express\.com|sso\.test\.ztosys/.test(p.url()));
  if (!tab) {
    tab = await ctx.newPage();
    await tab.goto(PM_URL, { timeout: 30000, waitUntil: 'domcontentloaded' });
    await sleep(5000); // 等 OAuth 跳到统一入口
  }
  await tab.bringToFront().catch(() => {});
  console.log('[tab]', tab.url().slice(0, 100));

  // 2) 已登录检查
  if (isPMHome(tab.url())) {
    const t = await bodyText(tab, 300);
    if (/迭代管理|缺陷管理|用例库/.test(t)) {
      console.log('RESULT: already-logged-in');
      await tab.screenshot({ path: path.join(SHOT_DIR, 'login_success.png') });
      await browser.close();
      return;
    }
  }

  // 3) 等待 SSO 页稳定
  for (let i = 0; i < 10 && !tab.url().includes('sso.'); i++) await sleep(1000);

  // 3a) 账密表单路径
  if (await visCount(tab) >= 2) {
    console.log('[path] 账密表单（页面提供了账号密码选项）');
    const form = await tab.evaluate(() => {
      const vis = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      return [...document.querySelectorAll('input')].filter(vis).map(el => ({ type: el.type, name: el.name || '', ph: el.placeholder || '' }));
    });
    const acc = form.find(i => /^(text|tel)$/.test(i.type)) || form[0];
    const pwd = form.find(i => i.type === 'password' || /动态|密码/.test(i.ph || '')) || form[1];
    await tab.fill(acc.name ? `input[name="${acc.name}"]` : `input[type="${acc.type}"]`, ACCOUNT);
    await tab.fill(pwd.name ? `input[name="${pwd.name}"]` : `input[type="${pwd.type}"]`, SECRET);
    await tab.locator('button.login-btn, button:has-text("登录")').first().click({ timeout: 5000 });
    console.log('[submit] 已提交账密');
  } else {
    // 3b) 一键登录路径
    console.log('[path] 无账密表单 → 一键登录');
    let clicked = false;
    for (let i = 0; i < 6 && !clicked; i++) {
      clicked = await tab.evaluate(() => {
        const cands = [...document.querySelectorAll('div, span, a')].filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && (el.textContent || '').trim() === '一键登录';
        });
        if (!cands.length) return false;
        cands[cands.length - 1].click();
        return true;
      }).catch(() => false);
      if (!clicked) {
        // 可能在扫码态：点切换链接/二维码图标轮换模式
        await tab.evaluate(() => {
          const sw = document.querySelector('a.login-switch-link') || document.querySelector('a.login-switch');
          if (sw) sw.click();
        }).catch(() => {});
        await sleep(2000);
      }
    }
    if (!clicked) throw new Error('未找到一键登录入口（页面可能改版，用 pm_center_probe.js 摸页面）');
    console.log('[click] 一键登录');
  }

  // 4) 等待结果：人脸验证 / 直接跳转
  const t0 = Date.now();
  let faceReminded = false, mode = '';
  while (Date.now() - t0 < FACE_WAIT_MS + 30000) {
    await sleep(2000);
    const u = tab.url();
    const b = await bodyText(tab, 260);

    if (isPMHome(u) && /迭代管理|缺陷管理|用例库/.test(b)) {
      mode = (await visCount(tab) >= 0) && b ? mode : mode;
      console.log('[ok] 登录成功 URL =', u.slice(0, 80));
      await tab.screenshot({ path: path.join(SHOT_DIR, 'login_success.png') });
      console.log('RESULT: login-success(' + (mode || 'auto') + ')');
      await browser.close();
      return;
    }
    if (b.includes('人脸验证') && !faceReminded) {
      faceReminded = true; mode = 'oneclick+face';
      console.log('\n==================================================');
      console.log('>>> 【需要您操作】请在手机宝盒 App 上完成人脸验证 <<<');
      console.log('>>> 若宝盒未自动弹出人脸验证：结束 App 进程后重新打开 <<<');
      console.log('>>> 完成后本页自动跳转，脚本持续等待中（' + (FACE_WAIT_MS / 1000) + '秒内） <<<');
      console.log('==================================================\n');
      await tab.screenshot({ path: path.join(SHOT_DIR, 'login_face_wait.png') });
    }
    if (b.includes('人脸验证')) continue; // 等用户
    // 账密提交后如果又回到 SSO（如密码错），输出失败线索
    if (u.includes('sso.') && /密码|错误|失败/.test(b)) {
      await tab.screenshot({ path: path.join(SHOT_DIR, 'login_error.png') });
      console.log('[error] 登录失败提示:', b);
      console.log('RESULT: login-failed');
      await browser.close();
      process.exit(2);
    }
    if (!mode) mode = 'password';
  }
  await tab.screenshot({ path: path.join(SHOT_DIR, 'login_timeout.png') });
  console.log('RESULT: login-timeout | URL =', tab.url().slice(0, 100));
  await browser.close();
  process.exit(3);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
