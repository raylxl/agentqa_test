---
name: jingtian-tenant-switch
description: 鲸天系统（jt-ll.test.ztoeco.com）内切换租户、查当前租户、列全部租户。当用户说"切换租户/切到XX租户/切回冷链快运/鲸天换租户/看当前租户/列出鲸天所有租户"，或要在鲸天里以智冷仓链、财务中台、项目管理等其他租户身份查菜单、看页面前需要先切租户时使用。走 Chrome 9333 实例 + changeTenant API（下拉 UI 点击法已失效勿用）；前置依赖 jingtian-login 技能先登录。
---

# Skill: jingtian-tenant-switch
# 鲸天租户切换（Chrome 9333 · API 法）

## 环境事实（2026-10-27 全 8 租户实测遍历）

| 项目 | 值 |
|------|-----|
| 承载页面 | `http://jt-ll.test.ztoeco.com/dashboard`（Chrome 9333 实例，CDP `127.0.0.1:9333`） |
| 切换接口 | `POST http://gateway-ll.test.ztoeco.com/uas/auth/changeTenant`，body `{platformCode:"ZTOCC_PLATFORM_001", tenantId:<id>}` |
| 必带请求头 | `Authorization` 与 `authtoken` = jt-ll 页 `localStorage.MICRO_APP_MAIN_TOKEN_KEY`（JWT）；`PlatformCode: ZTOCC_PLATFORM_001`；`client-Type: pc` |
| 切换后处理 | 新 token 写回 `MICRO_APP_MAIN_TOKEN_KEY` → 删 `MICRO_APP_MAIN_MENU_LIST`、`MICRO_APP_MAIN_MICRO_ROUTES` → `location.href=/dashboard` → 等 ~8s |
| 租户清单接口 | `POST gateway-ll/merak/user/queryOwnershipTenant`（同上请求头，body 只有 platformCode） |
| 会话特性 | SSO 全局共用，**切租户不重新登录**；localStorage 菜单全页签共享，旧页签刷新即变新租户 |

## 租户总表（2026-10-27 实测；以 `list` 实时结果为准）

| tenantId | code | 名称 | 备注 |
|---|---|---|---|
| 1 | ZTOCC | 冷链快运 | 主租户(type2)，32 顶级菜单，登录默认；回切首选；**别名：快运、总部** |
| 43 | T00011 | 智冷仓链 | 28 顶级菜单（OMS订单中心/仓链重构/冷链财务管理/数据预警…）；**别名：冷链云仓、云仓**（用户说云仓=此租户） |
| 46 | T00044 | 物料商城 | 菜单为空（仅首页） |
| 48 | T00048 | 客户服务平台 | 菜单为空（仅首页） |
| 49 | T00049 | 网络货运 | 8 顶级菜单 |
| 77 | T00077 | 冷链智运 | 36 顶级菜单（含测试栏目；自有 domain=zhiyun.test.ztoeco.com） |
| 78 | 99 | 财务中台 | code 是异常值"99"，**以 tenantId 为准** |
| 81 | T00081 | 项目管理 | 1 顶级菜单 |

## 标准流程

本技能脚本目录（下称 `$SKILL`）：当前宿主加载本技能时的 `scripts/` 子目录（部署器按所选宿主接线，禁止写死用户名或宿主目录）

1. **前提**：Chrome 9333 在跑且鲸天已登录（`curl -s --max-time 3 http://127.0.0.1:9333/json/version` 通；不通先跑 jingtian-login 技能）。
2. **按需执行**（幂等，支持租户ID或名称）：
   ```bash
   node "$SKILL/chrome_jt_tenant.js" list                 # 全量租户（实时）
   node "$SKILL/chrome_jt_tenant.js" current              # 当前租户
   node "$SKILL/chrome_jt_tenant.js" switch 43            # 切智冷仓链（按ID）
   node "$SKILL/chrome_jt_tenant.js" switch 财务中台      # 按名称也行
   ```
3. **校验**（对用户报告前必做）：`RESULT: switch-success / already-on-target` 即通过；脚本内部核对 `.tenant-item` 选中态=目标租户，且正文含凭证 `jt_login.display` 或预发环境标识。

## 成功判据

URL 在 `http://jt-ll.test.ztoeco.com/dashboard`；`.tenant-item` 带 `.selected-icon` 或 `.tenant-item.active`=目标租户名；正文含凭证 `jt_login.display` 或预发环境标识；菜单签名仅作辅助，以 `list/current` 实时结果为准。

## 故障排查

| 症状 | 原因 | 处理 |
|------|------|------|
| `RESULT: no-jt-tab` | 没有鲸天页签 | 先跑 jingtian-login 的 `chrome_jt_login.js` |
| `RESULT: api-failed`（401/token失效） | 登录态过期 | 重跑 `chrome_jt_login.js` 后重试本技能 |
| `RESULT: login-lost`（页面跳 SSO） | 切换途中会话断 | 同上，重登后重试 |
| `RESULT: tenant-not-found` | ID/名称没匹配上 | 先跑 `list` 看实时清单（以接口为准，勿信旧文档） |
| 切换成功但某页签内容怪 | 菜单缓存全页签共享 | 把旧 jt-ll 页签刷新一遍即对齐新租户 |

## 红线

- **多账号**：切租户操作人人一致，仅登录人不同。账号/显示名正源=`agent-secrets.json` 的 `jt_login`；脚本使用当前浏览器 token，`JT_DISPLAY` 只作临时覆盖，换人先用 jingtian-login 重新登录。
- **不要用下拉 UI 点击法**（点 `.el-dropdown-menu__item`）：2026-10-27 实测点击无弹窗、无接口调用、无跳转，纯浪费时间。
- playwright 的 `browser.close()` 只断 CDP 连接不关浏览器，保持此用法；绝不 `taskkill /IM chrome.exe`。
- 业务操作（切完租户后查菜单/页面）用各自技能或即时脚本，本技能只管租户身份切换；**切完后按操作规范做页签对齐**（reload 待操作 jt-ll 页签 + 核对菜单签名）再操作菜单。
- **操作规范正本（切租户后要开菜单/测试前必读）**：公司包 `jt_exec/鲸天系统操作规范_我的v1.md`；个人历史截图/实测记录不随包，租户清单以实时接口为准。
