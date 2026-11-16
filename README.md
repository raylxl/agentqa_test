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
| `D:\ZCodetest\.zcode\skills` | `agentqa_test\Agent本体\skills`（devops-login 再联到公司包） |
| `C:\Users\…\.zcode\skills\{jingtian×3, pm-center-login}` | `agentqa_test\公司包\skills\…` |
| `C:\Users\…\.zcode\cli\hooks` | `agentqa_test\Agent本体\hooks`（旧路径兼容联接；新会话直接走 config.json 新路径，稳定后可删） |
| `D:\ZCodetest\通用测试agent包` | `agentqa_test\手艺包`（旧名兼容联接） |

改接线/改目录名：`python agentqa_test\Agent本体\tools\rewire.py --status|--repair|--rename 旧名 新名`（目录改名免疫：脚本按文件名逐级定位公司配置与凭证，不写死目录名）。

## 发给同事（一键打包，2026-11-14 立）

`python D:\ZCodetest\agentqa_test\Agent本体\tools\pack_for_colleague.py --mode internal`（任意命令行整条粘贴即跑；`--no-secrets`/`--full`/`--dry-run`/`--mode external` 变体见 §8.5 速查＝AiTest\Agent全景总览_当前agent_v1.md）

- `internal`＝公司内同事复刻完整能力：三包+外部正本资产（标准/需求用例库/jt_chrome/台账/AiTest 瘦身）→ `dist\测试agent_内部完整包_*.zip`（306MB，包内含部署说明与 MANIFEST；`--no-secrets` 凭证换空值骨架，`--full` 带执行记录等大件）；
- `external`＝外发方法论：手艺包整包，先过 generic_layer_check 机检（红=禁出包）→ `dist\手艺包_<git哈希>_*.zip`；
- **同事侧部署只需一条命令**：解压到 `D:\` 保持同路径 → `python …\Agent本体\tools\rewire.py --repair`（重建联接+幂等写入 hook 配置）→ 重开会话；五步详见包内《部署说明_同事版_v1.md》。

手工等价步骤（无脚本时）：装 ZCode→拷 `手艺包\` 整包+按需拷 `Agent本体\skills`→建 `公司包`（agent-company.json 填公司值、agent-secrets.json 填账密、环境登录技能自建）→参照 `手艺包\04_技能包\INSTALL.md` 验证三步。

## 工作区数据（不在本目录、被 agent 引用）

需求文档库/用例文件/标准体系/台账/jt_chrome/AiTest —— 见 agent-company.json `paths`。

## 文件归属与 git

**《Agent与工作区文件存放位置标准_v1.md》**（本目录根）＝文件归属（通用/手艺/公司三分）与放置正本：根目录准入白名单、`_归档区\` 政策、搬迁纪律（锚点目录禁搬、只经 rewire/migrate_paths）、git 终态两仓制+过渡期全量（私有仓=github raylxl/agentqa_test，agent-secrets.json 永不入库）、R1~R5 分轮治理路线图。

## 隔离验收入口

- 验收报告：`D:\ZCodetest\AiTest\05_问题与台账\Agent本体_手艺包物理隔离验收报告_v1.md`
- 本体规则：只保留流程/通用引擎/适配器契约；公司值、环境连接、域词、执行工具和凭证在公司包。
- 手艺包门禁：`generic_layer_check.py` + 外置公司词表；机检自测样例使用运行时拼接，避免把样例当泄漏。

