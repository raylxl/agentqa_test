---
name: jingtian-login
description: 登录中通冷链"鲸天系统"测试环境（jt-ll.test.ztoeco.com），用本地 Chrome 9333 独立实例 + SSO 账密自动填充。当用户说"登录鲸天/打开鲸天/进鲸天/连上鲸天/鲸天系统"，要在鲸天里查菜单、切租户、看页面前需要先登录，或提到 jt-ll.test.ztoeco.com、鲸天登录态失效时使用。含防 https 升级的 Chrome 启动参数与登录态校验。
---

# 鲸天系统登录（Chrome 9333）

## 环境事实（2026-10-27 实测）

| 项目 | 值 |
|------|-----|
| 鲸天地址 | `http://jt-ll.test.ztoeco.com/welcome`（**全程 http，出现 https 即异常**；登录成功后停在 /welcome） |
| SSO | `http://sso.test.ztoeco.com/oauth2/authorize`，打开鲸天后自动跳转，无需手动进 |
| 浏览器 | Chrome 独立实例，CDP `127.0.0.1:9333`，用户目录为部署根 `.chrome-cdp`（登录态持久化，重启自动恢复） |
| 账号 | 账密读**公司层私有凭证文件** 本机 `agent-secrets.json` 的 `jt_login`（user/pass/display）；SSO"动态密码"框兼容静态密码，文档不记录个人账号真值 |
| 多账号 | 第二账号可填在凭证文件 `jt_login_2`；账号、口令、显示名由同事在本机维护。登录流程**人人一致，仅账密/显示名不同**。**账号正源=项目管理系统「鲸天执行账号」配置维护的鲸天登录账号**（密码平台加密存储，技能不落存）；本技能按配置账密登录，`JT_ACCOUNT/JT_SECRET/JT_DISPLAY` 环境变量仅作临时手工覆盖（缺省读凭证文件）。换人登录后，租户/机构技能同样用 JT_DISPLAY 传显示名校验 |
| 首选租户 | 冷链快运（登录后默认即此租户） |

## 标准流程

本技能脚本目录（下称 `$SKILL`）：当前宿主加载本技能时的 `scripts/` 子目录；部署器会为所选宿主建立联接，禁止写死用户名或宿主目录。

1. **检查实例**：`curl -s --max-time 3 http://127.0.0.1:9333/json/version`
   - 通 → 跳到步骤 3
2. **启动实例**（必须带防 https 升级参数，脚本已封装）：
   ```bash
   powershell -NoProfile -ExecutionPolicy Bypass -File "$SKILL/launch_chrome_9333.ps1"
   ```
   输出 `__RUNNING__` 或 `__STARTED__ <版本>` 即就绪。
3. **执行登录**（幂等）：
   ```bash
   node "$SKILL/chrome_jt_login.js"
   ```
   - 已登录 → 输出 `RESULT: already-logged-in`
   - 未登录 → 自动切"动态码登录"表单、填账号、点登录，成功输出 `RESULT: login-success` + 截图路径
4. **校验**（对用户报告前必做）：脚本 `RESULT` 为 success/already-logged-in 即通过；如需独立复核，用 playwright `connectOverCDP('http://127.0.0.1:9333')` 找 `jt-ll` 页签，确认正文含凭证 `jt_login.display` 或预发环境标识。

**macOS 变体**（2026-11-16 Mac 适配轮；同事 Mac 部署走这条）：
1. 前置：部署根目录跑过 `npm i playwright`（Node 18+；登录脚本 playwright 依赖三级 fallback 的裸 require 在此命中）；
2. 启动实例（防 https 升级参数同款封装）：
   ```bash
   bash "$SKILL/launch_chrome_9333_mac.sh"        # 无头；加 -v 可视化
   ```
   （脚本物理正本在公司包技能目录；用户目录 `.chrome-cdp/` 建在部署根下）
3. 登录脚本同步骤 3：`node "$SKILL/chrome_jt_login.js"`；
4. Mac 排查 https 升级异常：`lsof -ti:9333 | xargs kill` → 重跑启动脚本。

## 登录成功判据

URL 回到 `http://jt-ll.test.ztoeco.com/welcome`，正文含凭证 `jt_login.display` 或预发环境标识，租户行显示 **冷链快运**，侧边菜单（冷链财务管理、仓链账单管理等）已渲染。

## 故障排查

| 症状 | 原因 | 处理 |
|------|------|------|
| URL 变 `https://jt-ll...` 或页面白屏 | Chrome 实例没带防升级参数（http 被自动升级，SSO 链路断） | `netstat -ano \| grep :9333` 找 PID → `taskkill //PID <pid> //F` → 重跑 launch 脚本 → 重跑登录脚本 |
| `RESULT: login-timeout` 且截图显示密码错误 | SSO 动态码不再兼容静态密码 | 把页面停在 SSO 扫码模式，让用户用"中通宝盒"App 扫码；可用 `chrome_jt_probe.js` 观察页面 |
| 表单字段找不到（输入框数=0 切换后仍为 0） | SSO 页面改版 | 跑 `$SKILL\chrome_jt_probe.js` dump 最新页面结构，按实测结构调整登录脚本 |
| `找不到 playwright 库` | 库不可用 | 重跑部署器自动安装，或在部署根执行 `npm i playwright` |
| CDP 连不上 | 实例没起或端口被换 | 重跑 launch 脚本；仍失败查 `netstat -ano \| grep :9333` |

## 红线

- 只允许 kill 9333 端口对应的 PID；**绝不 `taskkill /IM chrome.exe`**（会杀掉用户日常浏览器）。
- 不要改用 Edge / WorkBuddy 的 `jt_login_v*.js` 等脚本——那是参考体系（Edge 9222 环境），与本技能的 Chrome 9333 环境不通用。
- playwright 的 `browser.close()` 只断 CDP 连接、不关浏览器，脚本里保持这个用法；不要真把 Chrome 关掉。
- 历史截图/个人参考目录不随包；浏览器操作一律用本技能自带脚本，业务事实以实时页面和接口为准。

## 补充参考

- **操作规范正本**：公司包 `jt_exec/鲸天系统操作规范_我的v1.md`（实际路径由 `agent-company.json` 的 `paths.执行工具` 提供）。
- SSO 表单实测结构：切换链接 `a.login-switch-link`；账号 `input[name="username"]`；密码/动态码输入框；提交 `button.login-btn`。个人登录手册和截图不随包。
- 登录后的租户/机构切换、菜单结构等业务操作：查参考汇总目录或知识库，不要在本技能里扩展业务逻辑。
