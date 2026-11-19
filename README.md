# agentqa_test —— 测试 Agent 产品总目录

> 建立：2026-11-14（用户拍板"抽离 agent 为独立文件夹，再分手艺包/公司包，整体收拢于 agentqa_test"）。
> 本目录 = 测试 Agent 的**物理正本**。ZCode 的固定运行位（`.zcode\skills`、用户级 skills、hook 配置）通过**目录联接（junction）**指到这里，单一正本、无副本。

## 三包结构

| 目录 | 是什么 | 出门规则 |
|---|---|---|
| `Agent本体\` | 运行本体：10 个流程技能（参数化通用）+ 5 hooks（机器闸：正本拦截/重读提醒/拍板对账/记忆守卫/计时底账）+ tools\rewire.py（接线与改名）+ pack_for_colleague.py（一键分发）+ memory_health_check.py（记忆体检）+ migrate_paths.py（换机路径换算）+ timeline_check.py（计时校验） | 参数化后可出门；hooks 逻辑通用 |
| `手艺包\` | 通用方法论分发件（标准 v4.0/接口 v1.2 + 提示词与模板八件 + 机检 + 十技能通用副本），git 管理 | **发版机检全绿才出门**（零公司数据） |
| `公司包\` | 公司家底：agent-company.json（公司适配 48+ 值）+ agent-secrets.json（**明文账密/DB 连接唯一落点**）+ 词表 + param_check + 5 个环境登录技能 | **整包永不出门**（已列禁发清单） |

## 接线（运行位 → 物理正本）

| 运行位（ZCode 认这里） | 联接到 |
|---|---|
| `D:/ZCodetest\.zcode\skills` | `agentqa_test\Agent本体\skills`（devops-login 再联到公司包） |
| `C:\Users\…\.zcode\skills\{jingtian×3, pm-center-login}` | `agentqa_test\公司包\skills\…` |
| `C:\Users\…\.zcode\cli\hooks` | `agentqa_test\Agent本体\hooks`（旧路径兼容联接；新会话直接走 config.json 新路径，稳定后可删） |
| `D:/ZCodetest\通用测试agent包` | `agentqa_test\手艺包`（旧名兼容联接） |

改接线/改目录名：`python agentqa_test\Agent本体\tools\rewire.py --status|--repair|--rename 旧名 新名`（目录改名免疫：脚本按文件名逐级定位公司配置与凭证，不写死目录名）。

## 新机直接克隆本仓（同事常态通道·git 唯一更新通道，2026-11-19 定谳）

本仓=私有仓·过渡期全量（公司包在内）。**同事侧永远=获取 git 即可**（2026-11-19 用户定谳：首次自举一次，此后更新一律纯 `git pull`；安全包 zip 只作一次性首装件给 git 不可达者，不再二次发版）。**克隆 ≠ 可用**：`公司包/agent-company.json` 的 paths 全指向发起人 `D:/ZCodetest/...`，新机（尤其 macOS）不可达；不处理就开工，技能会误判"无配置→降级通用模式"，**整层 L2 族标准静默丢失**（首例=外部参考价首轮 229 条缺族标准返工）。

**首次部署一次，此后日常更新=纯 `git pull`（零额外动作）**：Windows 双击根目录 `部署.bat`（或 `自举.bat`，同一部署器）/ macOS 双击或 `bash 部署.command`（克隆/安全包两布局自适应；zip 包内同名部署入口=同一个东西）。自举自动完成：git pull → 路径换算 → 宿主接线 → 依赖自装 → param_check → **装路径过滤器**（本地 `.gitattributes` `* filter=agentpath` + smudge/clean：检出自动把发起人路径换成本机路径、比较时自动换回——无本地改动、无 pull 冲突）。此后：

- **拉最新=直接 `git pull`**：新内容自动本地化，什么都不用再做（技能/标准有更新需重开宿主会话才生效；你新建的文件不受影响）；
- 仅这些情况重跑自举：换宿主/换机器、拉到"新增依赖"提示、或 pull 出现意外冲突（自举会先备份你本地改过的文件到 `_local_edits_backup_*/`）；
- 你手工改过仓内跟踪文件（如 agent-company.json 三段换线值）再遇远端同文件更新 → pull 会正常报冲突，重放你的改动即可（属 git 正常语义）。

发起人正本机（D:/ZCodetest）跑克隆通道部署会被防呆拦截（`--force` 才放行）。正式分发仍优先下一节**安全包+部署器**（真机首验清单已含 WorkBuddy 软闸档）；裸克隆是过渡期协作通道。

## 发给同事（一键打包，2026-11-14 立）

`python D:/ZCodetest\agentqa_test\Agent本体\tools\pack_for_colleague.py --mode internal`

- `internal`＝公司内同事**安全包**：三包方法/标准/技能+5份L4域标准+精简执行内核+XMind工具链；不含需求库/台账/截图/抓包/运行结果/个人数据，凭证恒为空骨架。产物唯一：`dist\测试agent_同事安全包.zip`，写后安全门禁红即删包；
- `company` 与 `--full` 历史危险模式已禁用；
- **更新通道定谳（2026-11-19 用户拍板）**：zip 只作**一次性首装**（仅 git 不可达者）；此后一切更新走 git——已装 zip 的机器升级=克隆本仓+跑一次自举（一次性迁移），之后纯 `git pull`。不再二次发 zip，部署器 zip 升级模式仅历史保留；
- `external`＝外发通用方法论：手艺包整包，先过 generic_layer_check 机检（红=禁出包）→ `dist\手艺包_发版件.zip`；
- **同事部署**：解压到任意目录，Windows 双击 `部署.bat` / macOS 运行 `部署.command`，在菜单选择要接入的宿主；依赖、路径迁移、接线和校验由部署器自动完成。

手工等价步骤（无脚本时）：装 ZCode→拷 `手艺包\` 整包+按需拷 `Agent本体\skills`→建 `公司包`（agent-company.json 填公司值、agent-secrets.json 填账密、环境登录技能自建）→参照 `手艺包\04_技能包\INSTALL.md` 验证三步。

## 工作区数据（不在本目录、被 agent 引用）

需求文档库/用例文件/标准体系/台账/jt_chrome/AiTest —— 见 agent-company.json `paths`。

## 文件归属与 git

**《Agent与工作区文件存放位置标准_v1.md》**（本目录根）＝文件归属（通用/手艺/公司三分）与放置正本：根目录准入白名单、`_归档区\` 政策、搬迁纪律（锚点目录禁搬、只经 rewire/migrate_paths）、git 终态两仓制+过渡期全量（私有仓=github raylxl/agentqa_test，agent-secrets.json 永不入库）、R1~R5 分轮治理路线图。

## 隔离验收入口

- 验收报告：`D:/ZCodetest\AiTest\05_问题与台账\Agent本体_手艺包物理隔离验收报告_v1.md`
- 本体规则：只保留流程/通用引擎/适配器契约；公司值、环境连接、域词、执行工具和凭证在公司包。
- 手艺包门禁：`generic_layer_check.py` + 外置公司词表；机检自测样例使用运行时拼接，避免把样例当泄漏。

