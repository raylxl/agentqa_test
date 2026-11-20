# 测试 Agent 全量体检整改验收 v1

- 验收时间：2026-11-20
- 验收对象：《测试Agent全量体检报告_v1.md》所列 H1-H3、M1-M6、L1-L6 共 15 项
- 验收结论：**15/15 完成**；实施过程拆为 6 个整改提交 + 本验收记录提交
- 边界约束：全程未修改用户既有脏项 `公司包/skills/jingtian-login/scripts/login_success.png`，未跟踪目录 `Agent体检/`（本验收文件除外）与 `总用例库设计文档/`；v1 体检报告本体未改

## 整改结论

| 项 | 结论 | 关键整改与证据 | 提交 |
|---|---|---|---|
| H-1 zbase 双正本 | 完成 | 公司包成为唯一正本：合入保守查询口径、失败取证章节、zbase-login 日志查询说明；`zlog_query.js` 补 `input` 后 `change` 双事件；本体侧原实体目录隔离到 `_git归档/zbase双正本隔离_20261120/`，原位改 Junction。`Get-Item` 验证两个 `LinkType=Junction` 且 Target 均为公司包。经 `D:/ZCodetest/.zcode/skills/zbase-log-query/scripts/zlog_query.js` 实测：不存在词 `zlog_probe_zzz_notexist123` 得 `total=0`；真实单号 `1794923846`（3 天、`ztocc-phecda-quote-wbms-mq`）得 `total=18`，与本体版修复后的精确值一致 | `1c032c0` |
| H-2 ⑦段口径 | 完成 | 采用方案 c。四处均统一为：⑤执行段尾部完成坑库沉淀、标准回写候选与置信度；⑦=usecase-qc 独立质检（六查证伪→红清零＋复检绿=放行），放行后停机等签字。终验 rg 在台账、executor、orchestrator、全景总览四处均命中同一归属口径 | `1062885` |
| H-3 rewire 安全网 | 完成 | `make_junction()` 先验目标目录；`rename()` 支持 `--dry-run`、配置备份与异常逆序回滚；接线表扩为 devops-login/zbase-login/zbase-log-query 三个环境技能。`rewire.py --status` 全绿，含 zbase 两联接；dry-run 复核无落盘 | `38d1f26` |
| M-1 备份与运行产物跟踪 | 完成 | 唯一跟踪的 `assemble_universal.py.bak_20261109` 取消跟踪并移入 `_git归档/公司包-tools-legacy/`；`.gitignore` 补 `*.bak`、`*.bak_*`、`logs/`。仓库内不再有被跟踪 `.bak` | `e7b846f` |
| M-2 hooks 口径 | 完成 | README 与 rewire 注释统一“5 道机器闸 / hooks 五件”；终验 `3 hooks`、`3 道` 零命中，rewire/README 中“四件/三件”旧口径零残留 | `e7b846f` |
| M-3 质疑路由 | 完成 | 五道门均具备宾语化触发：设计稿质疑、执行判定复核、提单前质疑、规格保真复核、交付物质检；orchestrator 分工表补 spec-gate、execution-challenger、defect-challenger、usecase-qc 及调用时点。终验五个短语逐一命中对应技能 | `36041a2`、`7aeeb42` |
| M-4 硬编码路径 | 完成 | lanhu-req-extract 改 `{paths.需求文档}`；zbase-log-query 改 `{integrations.dev_git.clone_root}`；orchestrator/executor 的 `gate_scan.py`、`book_lock.py` 改 `{paths.执行工具}` 前缀。终验 `Agent本体/skills` 与 `公司包/skills` 的 `SKILL.md` 契约层绝对路径扫描零命中 | `36041a2`、`7aeeb42` |
| M-5 report_sync 契约 | 完成 | 主脚本缺参打印用法并 `exit=2`；lite 文件头与运行输出均声明“仅烟雾回归用，不作出口门依据”；executor §6.9 明确出口门唯一依据为 `report_sync.py`。终验公司包主脚本与 lite 缺参均 `exit=2`，lite banner 含降级声明 | `36041a2` |
| M-6 技能清单 | 完成 | README 按 H-1 收敛后的实际形态重列：14 个实体技能 + 3 个环境技能联接 + 5 hooks + `_company_profile.py` 辅助模块，并声明以 `skills/` 目录与 `hook_templates()` 为准 | `e7b846f` |
| L-1 缓存与运行残留 | 完成 | 11 个未跟踪 `__pycache__/` 与 `locks/` 内 2 个 `login_*.js`、3 个 `launch_*.ps1` 移入 `_git归档/L系运行残留隔离_20261120/`；locks 下仅保留锁文件。打包器全局排除 `logs/`、`locks/`、名称含 `.bak` 的文件与既有 `.log/.pyc/__pycache__` | `7aeeb42` |
| L-2 入口与登录模板 | 完成 | 删除 `自举.bat`、`自举.command`、`chrome_jt_login_9334.js`；`部署.command` 改调仓根 `deploy.py` ASCII 跳板；操作性文档改称“部署”。鲸天池化登录继续由 `chrome_jt_login.js` 单模板加端口改写生成，`pw_layered/pw_login.js` 作为分层执行机制保留 | `7aeeb42` |
| L-3 端口参数化 | 完成 | `chrome_jt_switch_tenant_api.js`、`chrome_jt_tenant_tour.js`、技能侧 `chrome_jt_tenant.js` 支持 `--port`（默认 9333）；`chrome_jt_open_menu.js` 用 `execFileSync` 透传端口，并删除“非 9333 勿带 --tenant”例外说明。4 个 JS 均 `node --check` 通过 | `7aeeb42` |
| L-4 客户端目录可配 | 完成 | `rewire.py`、`reread_reminder.py`、`memory_health_check.py` 支持 `ZCODE_HOME` / `CLAUDE_HOME` 覆盖，默认路径不变；README 补说明。环境变量探针验证路径按覆盖值生效，`reread_reminder.py` 能命中覆盖后的 config.json | `7aeeb42` |
| L-5 文档去重与路径 | 完成 | 删除 executor 分层执行段尾部 5 行重复块；requirement-qa-loop 标题改“阶段①”；usecase-pipeline 明确通用组装引擎为 `../usecase-generator/scripts/assemble_universal.py`，本体与手艺包副本均同步 | `7aeeb42` |
| L-6 跨平台与共享配置 | 完成 | 新增仓根 `pathfilter_layout.json`，pathfilter 与 migrate_paths 共读同一布局配置；pathfilter 增加 `--selftest`；`.command` 统一走 `deploy.py`。自测覆盖普通根路径、jt_chrome 布局映射与无命中串，smudge→clean 往返一致 | `7aeeb42` |

## 提交映射

| 提交 | 范围 |
|---|---|
| `1c032c0` | H-1 zbase 双正本收敛与真机修复 |
| `1062885` | H-2 ⑦段口径统一 |
| `38d1f26` | H-3 rewire 安全网与接线扩展 |
| `e7b846f` | M-1/M-2/M-6 仓库与文档卫生 |
| `36041a2` | M-3/M-4/M-5 路由、路径与出口门契约 |
| `7aeeb42` | L-1~L-6 清理、入口、端口、目录覆盖与 pathfilter 自测 |
| 本提交 | 整改验收记录 |

## 回归验证

1. **接线与联接**：`python Agent本体/tools/rewire.py --status` 结论“全绿”；zbase-login、zbase-log-query 均为 Junction 且目标为公司包正本。
2. **ZBASE 真机**：9338 在线；经 `.zcode` 运行位执行不存在词对照 `total=0`，真实单号 `1794923846` 复查 `total=18`。
3. **⑦段一致性**：`D:/ZCodetest/需求流水线台账_v1.md`、executor、orchestrator、`D:/ZCodetest/AiTest/Agent全景总览_当前agent_v2.md` 四处口径一致。
4. **语法检查**：改动 Python 文件全部 `py_compile` 通过；4 个改动 JavaScript 文件全部 `node --check` 通过。
5. **过滤器**：`python pathfilter.py --selftest` 输出 `[OK] pathfilter smudge->clean roundtrip`；`migrate_paths.py` 从共享 JSON 读到 3 条布局映射。
6. **出口门**：公司包 `report_sync.py` 与 `report_sync_lite.py` 缺参均输出用法并退出 2；lite 输出“仅烟雾回归用，不作出口门依据”。
7. **打包**：internal 安全包试打包写入 `_git归档/pack_trial_L6/`，产物 261 项、CRC 与安全门禁全绿；检查清单无 `logs/`、`locks/`、`__pycache__/`、`.bak`、`.pyc`。
8. **口径扫描**：`3 hooks`、`3 道` 零命中；rewire/README 仅保留“hooks 五件/5 道”口径；五个质疑/复核/质检宾语短语均命中对应技能。
9. **工作区边界**：最终仅剩用户原有 `login_success.png` 修改与 `Agent体检/`、`总用例库设计文档/` 两个未跟踪目录；本次新增验收文件提交后，仍不触碰其余内容。

## 边界说明

- 本机未安装 `bash`，无法执行 `bash -n 部署.command`；该文件已收敛为 ASCII 目标路径 `deploy.py` 跳板，内容复核无中文路径参数。
- L-1 按安全策略采用隔离移动而非递归删除；隔离区均位于 `_git归档/` 且被忽略。
- Chrome 启动脚本保留既有“部署根探测兜底”：先按脚本相对层级与已存在 profile 探测，只在用户级联接相对层级错位时使用兜底候选；这不属于 M-4 点名的技能流程/查询路径。
