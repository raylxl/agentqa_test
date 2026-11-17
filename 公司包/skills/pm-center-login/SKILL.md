---
name: pm-center-login
description: 登录"中通冷链-项目管理中心"系统（project-manage.ztll-cpx.ft.ztoeco.com），用本地 Chrome 9333 实例经中通统一入口 SSO。当用户说"登录项目管理中心/打开项目管理中心/进 PM 系统/登录 project-manage"，或要在该系统里查迭代、需求、用例、缺陷前需要先登录时使用。含"账密优先→一键登录兜底→人脸验证提醒用户"的完整登录策略。
---

# 项目管理中心登录（Chrome 9333）

## 环境事实（2026-10-27 实测）

| 项目 | 值 |
|------|-----|
| 地址 | `http://project-manage.ztll-cpx.ft.ztoeco.com/`（登录成功后 `#/home`，标题"中通冷链-项目管理中心"） |
| 浏览器 | 与鲸天共用 Chrome 独立实例 CDP `127.0.0.1:9333`，用户目录为部署根 `.chrome-cdp`（登录态持久化） |
| SSO 链路 | 根路径 → 测试 SSO（sso.test.ztosys.com，appid ztMYNDhf4mWfecuiFr55W87A）→ **强制跳中通统一入口**（https://sso.zt-express.com）→ 授权后带 code 回 project-manage |
| 账号 | 读本机 `agent-secrets.json` 的 `pm_login`（user/pass/display）；文档不记录个人手机号或账号真值 |
| 一级菜单 | 首页 / 迭代管理 / 用例库 / 缺陷管理 / 报表管理 / 基础资料 / 需求库 / 项目管理 |

**关键事实**：统一入口（sso.zt-express.com）**没有账号密码表单**——实测只有"宝盒扫码"和"一键登录"两种方式（页面检测到电脑宝盒客户端会自动切成一键登录态，模式会自动翻转）。直连测试 SSO 也会被弹回统一入口（该应用 SSO 配置如此）。

## 登录策略（用户指定，2026-10-27）

1. **先探测账密表单**：若 SSO 页出现 ≥2 个可见输入框（未来页面改版可能提供），填鲸天账号密码提交。
2. **没有 → 一键登录**：入口是**文本为"一键登录"的 div（不是 button 标签）**；若处于扫码态，先点 `a.login-switch-link`（"扫一扫"）轮换模式再找。
3. **触发人脸验证 → 立即提醒用户**：页面出现"本次登录需进行人脸验证"字样时，**明确告知用户拿手机宝盒 App 完成人脸识别**（页面原话：若宝盒未自动唤起，结束 App 进程后重新打开）。用户完成后页面**自动跳转**，无需再操作。

## 标准流程

技能脚本目录（下称 `$SKILL`）：当前宿主加载本技能时的 `scripts/` 子目录（部署器接线，禁止写死用户名或宿主目录）

1. 检查 Chrome 实例：`curl -s --max-time 3 http://127.0.0.1:9333/json/version`
   - 不通 → 先按 `jingtian-login` 技能的 launch 脚本启动实例（两系统共用）：
     先调用 jingtian-login 技能目录下的 `scripts/launch_chrome_9333.ps1`（Mac 用 `.sh`）
2. 执行登录（幂等，已登录直接返回）：
   ```bash
   node "$SKILL/pm_center_login.js"
   ```
   - 输出 `RESULT: already-logged-in | login-success(password) | login-success(oneclick+face)` 即成功
   - **脚本出现"【需要您操作】请在手机宝盒 App 上完成人脸验证"时，把这句话转告用户并耐心等待**（脚本默认轮询 240 秒，可传参调大：`node pm_center_login.js 600`）
3. 校验：URL 为 `project-manage.ztll-cpx.ft.ztoeco.com/#/home` 且页面含 迭代管理/缺陷管理 等菜单。

## 故障排查

| 症状 | 处理 |
|------|------|
| `RESULT: login-timeout` 且截图停在"人脸验证" | 用户未完成人脸验证——再次提醒，或加大等待参数重跑 |
| 找不到一键登录入口 | 页面可能改版：跑 `$SKILL\pm_center_probe.js` dump 页面结构，按实测调整 |
| 账密提交后回到 SSO（提示密码错误） | 查 `$SKILL\scripts\login_error.png`；动态码不再兼容静态密码时改走一键登录 |
| 页签打开了但白屏 | Chrome 实例缺防 https 升级参数——按红线流程重启实例（见 jingtian-login 技能） |

## 红线

- 只允许 kill 9333 端口对应 PID；绝不 `taskkill /IM chrome.exe`。
- 不确定页面结构时先跑 probe 脚本实测，**不要猜选择器**；该 SSO 页模式会自动翻转（宝盒检测），探测时留意多状态。
- 人脸验证只能由用户本人在手机上完成，脚本只负责提醒与等待。

## 补充

- 登录态持久化在 `.chrome-cdp`（sso.zt-express.com cookie），Chrome 重启通常免登录。
- 系统业务知识（菜单结构、缺陷列表等）见项目记忆与 `公司包 jt_exec/（部署器当前路径）` 下的实测文档，勿与鲸天的参考文档混用。
