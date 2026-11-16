# 分层执行模式（AI 首跑 → 沉淀 → 脚本回归 → 失败回流）

2026-11-09 用户拍板建立（6 项拍板见会话记录），试点=货量考核 3 条，4 轮验证全绿；同日全册沉淀 24 条 spec，**当日回归 23 条通过**，TC_018 待用户确认新口径（控件上限钳制）后改 spec（含三项拍板闭环与 139/140 三次回流修通）。

## 四阶段

```
新用例 ──→ ① AI 首跑（CDP，usecase-executor 流程）
              ↓ PASS
           ② 沉淀：转写为本目录 spec（禁入清单：坐标定位/any降级断言/判重造撞类不沉淀）
              ↓
           ③ 脚本回归：pw_runner.js 无人值守（CI/发版后/夜间）
              ↓ 脚本红
           ④ 回流：AI 用 CDP+诊断脚本定性 → 改版=自愈更新 spec / 真缺陷=走 usecase-feedback-loop
```

## 组件

| 文件 | 作用 |
|---|---|
| `cdp_pool.js` | 实例池：`ensureExecPortExclusive`=回归独占取实例（9336+ 优先、避开 9335；有锁/有业务页签即跳过；锁与 browser_pool 同格式互认）；`ensureExecPort`=旧接口（AI 执行用，仅加"有锁不复用"） |
| `pw_login.js` | 登录 preflight：幂等（已登录直过/过期自动账密重登/渲染等待） |
| `pw_tenant.js` | 租户 preflight：查当前（DOM selected-icon）+ 不对自动切（changeTenant API） |
| `pw_runner.js` | 运行器：preflight→逐 spec 新页签→网络流采集→台账→汇总 |
| `helpers.js` | 兼容壳 = 框架公共层 + 货量配方层（旧引用零改动；新代码请直接 require lib/modules） |
| `lib/jt_common.js` | **框架公共层**：真实点击/浮层驱散/菜单清单解析 resolveMenu/**菜单导航 openMenuViaNav**（2026-11 鲸天菜单改版适配，坑库 H1c）/业务页渲染判定 waitBizRendered |
| `modules/huoliang.js` | **货量考核配方层**（原 helpers 按行原样拆出）+ MODULE 元数据 + NUM_FIELDS 明细上限表（diag10 实测，坑库 H6） |
| `modules/cangnei.js` | **仓内作业价格配方层**（2026-11-11 沉淀，第二菜单接入）：正本引用 C/D 轮成熟引擎（执行记录 _A/_RA/_B2 的 A/RA/b5lib）+ API 造数/过审/自清（d5/d9 同型）+ 导入导出引擎（openpyxl 通道）+ 五页签 UI 新增配方；造数台账带 tab 维度防跨页签误标 |
| `modules/_template.js` | **新菜单接入模板**：配方契约与接入四步；报价族建议包装成熟引擎 jt_chrome/lib_pt.js（坑库第五节），勿重写 DOM 配方 |
| `specs/spec_*.js` | 沉淀 spec：声明 id/tenant/dataPrefix，run({page,log}) 返回 {status,evidence}；`spec_cn_*`=仓内作业价格族（2026-11-11 沉淀 27 条：tc001~024 后第二菜单族；`module.exports.blocked` 置位的 spec 被 runner 跳过并记「阻塞·blocked」——沉淀期已知缺陷 ISS261111001005 用） |
| `ledger.jsonl` | 台账（Execution ID=LX-YYYYMMDD-NNN，channel=script）；沉淀登记行={tcId,specFile,source,firstRun,depositedAt,status,blocked} |
| `created_names.jsonl` | **造数名称台账**：spec 点确定前登记、自清按台账精确删（只删本模式自己造的数据） |
| `historical_TEST_snapshot.json` | 库内历史 TEST_ 数据快照（2026-11-09 拍板保留，50 条）；`node diag17.js cmp` 比对原封未动 |
| `diag*.js` | 回流诊断工具（页面结构快照/网络层直查） |

## 用法

```bash
node pw_runner.js --specs tc138,tc001,tc005          # 自动选端口
node pw_runner.js --specs tc005 --port 9335          # 指定实例
node pw_login.js --port 9335                          # 单独查/补登录
node pw_tenant.js --port 9335 current                 # 单独查租户
node cdp_pool.js                                      # 实例池状态
```

## 状态语义（拍板#3：四态）

- **通过**：脚本断言全绿（证据=断言摘要）
- **待复核**：脚本断言红 → 必经 AI 回流定性后才可终判（不直接=不通过）
- **阻塞**：环境/基建异常（登录超时、页面不可达）
- 不通过：仅 AI 回流定性后写入（usecase-feedback-loop 流程）

## 铁律

1. 造数自清双向（拍板#4）+ **只清自己造的**（2026-11-09 拍板：库内历史 TEST_ 数据保留）：spec 点「确定」前 `recordCreated` 登记名称台账（created_names.jsonl）→ 跑前/跑后 `cleanupOwn` 按台账名称逐条精确删；**spec 禁止按前缀模糊删**（会误伤同命名格式的历史/他人数据），`deleteByPrefix` 仅留诊断用且带数量闸
2. 日期禁手输，面板直选；Esc 禁令；真实鼠标键盘事件
3. 禁入清单：坐标定位 / any 降级断言 / 判重造撞类用例不沉淀
4. 回归窗口内执行实例**独占**：runner 全程持锁、每条心跳续锁、结束解锁；他人持锁端口拒用（`--force` 才强用）——多会话共用实例会租户互切、结果互相污染（坑库 G36）；9333 永不自动征用
5. 沉淀定位一律走 helpers 配方（v2 已固化 2026-11-09 页面实测结构），勿照抄 11-06 旧脚本选择器
