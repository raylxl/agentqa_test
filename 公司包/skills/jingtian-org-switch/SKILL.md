# Skill: jingtian-org-switch
# 鲸天机构切换（Chrome 9333 · UI 拟人法优先）

## 环境事实（2026-10-29 实测，冷链快运租户）

| 项目 | 值 |
|------|-----|
| 承载页面 | `http://jt-ll.test.ztoeco.com/dashboard`（Chrome 9333 实例，CDP `127.0.0.1:9333`） |
| 机构入口 | 界面**左上角**当前机构展示位（如"总部"）：`.org-menu .org-dropdown .drop-wrapper` |
| 下拉清单 | 点击后 `.org-popper` 弹出，`.org-item` 逐项展示**当前登录人员配置的机构**（人员专属，换账号清单会变化；执行前以 `list` 实时结果为准） |
| 确认弹窗 | 点机构项后弹 `.el-dialog__wrapper`："切换机构——确定要切换到【X】吗？"（取消/确认）；点**确认**才生效，左上角随即展示新机构 |
| 切换接口（兜底） | `POST http://gateway-ll.test.ztoeco.com/uas/auth/changeOrg/<orgCode>`，body `{}`；必带请求头 `Authorization` 与 `authtoken` = jt-ll 页 `localStorage.MICRO_APP_MAIN_TOKEN_KEY`（JWT）、`PlatformCode: ZTOCC_PLATFORM_001`、`client-Type: pc`；**响应不含新 token**（与切租户不同），成功后 reload 页面即可 |
| 机构清单接口 | `POST gateway-ll/uas/user/queryDetailInfo`（body `{"containsOrg":true}`）→ `data.organizes[]`（orgCode/orgName/orgType/orgTypeCode/isDefault）+ `data.currentOrgId/Name/Code` |
| 当前机构 | `localStorage.authInfo` 的 currentOrgId/currentOrgName/currentOrgCode；⚠️ authInfo 只在登录/真实切换后刷新，API 换 token 不更新它；核对左上角 DOM 展示最稳 |
| 机构作用域 | 机构挂在**租户之下**且按登录人配置：切租户后机构清单整体变化；菜单按 租户+机构 双维度生效 |

## 标准流程

本技能脚本目录（下称 `$SKILL`）：当前宿主加载本技能时的 `scripts/` 子目录（ZCode/WorkBuddy/Codex 等均由部署器接线，禁止写死用户名或宿主目录）

1. **前提**：Chrome 9333 在跑且鲸天已登录（jingtian-login 技能）；**机构随租户变化**，跨租户操作先用 jingtian-tenant-switch 切对租户（本技能脚本会显示当前租户名提醒）。
2. **按需执行**（幂等，支持机构编码或名称）：
   ```bash
   node "$SKILL/chrome_jt_org.js" list                 # 当前人员可切换机构（实时，含默认标记与类型码）
   node "$SKILL/chrome_jt_org.js" current              # 当前机构（authInfo + 左上角 DOM）
   node "$SKILL/chrome_jt_org.js" switch 630200        # 切接口测试青海海东分拨陆（按编码）
   node "$SKILL/chrome_jt_org.js" switch 总部          # 按名称切回
   ```
3. **切换实现**：UI 拟人法优先（左上下拉→机构项→确认弹窗，弹窗文案含目标机构名才点确认）；UI 元素失效自动降级 API 法（changeOrg + reload）。
4. **校验**（对用户报告前必做）：`RESULT: switch-success / already-on-org` 即通过；脚本已核对 authInfo.currentOrgCode = 目标 且 左上角展示含目标机构名，并截图 `org_<code>_after.png`。

## 成功判据

左上角机构展示 = 目标机构名；`authInfo.currentOrgCode` = 目标编码；正文含凭证配置的 `jt_login.display`（或预发环境标识）；租户名与预期一致（机构清单是 租户×人员 二维的，别在错误租户下切）。

## 故障排查

| 症状 | 原因 | 处理 |
|------|------|------|
| `RESULT: no-jt-tab` | 没有鲸天页签 | 先跑 jingtian-login 的 `chrome_jt_login.js` |
| `RESULT: api-failed`（清单拿不到） | 登录态过期 | 重跑 `chrome_jt_login.js` 后重试 |
| `RESULT: org-not-found` | 编码/名称没匹配上 | 先跑 `list` 看实时清单（人员专属，勿信旧文档） |
| UI 点击无弹窗/点了没反应 | DOM `.click()` 不触发 Vue 事件 | 脚本已用真实鼠标事件并自动降级 API 法；手写脚本时勿用 el.click() |
| 切换后左上角没变 | 弹窗没点确认（只点了机构项） | 确认弹窗必须点"确认"按钮才生效 |

## 红线

- 机构清单**专属登录人员**：登录人正源=项目管理系统「鲸天执行账号」配置；给任何账号操作前先 `list` 以实时接口为准。显示名正源=`agent-secrets.json` 的 `jt_login.display`，`JT_DISPLAY` 仅作临时覆盖。注意「总部」与「总部财务中心」是两个机构，选机构须精确匹配全名。
- playwright 的 `browser.close()` 只断 CDP 连接不关浏览器，保持此用法；绝不 `taskkill /IM chrome.exe`。
- 本技能只管机构身份切换；切租户用 jingtian-tenant-switch，业务操作（查菜单/开页面/测试）按各自技能或操作规范执行，切完机构后注意页面数据随机构过滤。
- 操作规范正本：公司包 `jt_exec/鲸天系统操作规范_我的v1.md`

## 补充参考

- 机构类型码字典与人员机构清单以实时接口 `list` 为准；个人历史采集文件不随包分发。
- 机构组织详情（上级机构）：`POST gateway-ll/merak/orgBranch/queryInfo` body `{"orgCode":"630200","tenantId":1}`。
