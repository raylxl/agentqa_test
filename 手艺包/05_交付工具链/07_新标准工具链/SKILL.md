---
name: md-to-xmind-v2
description: 测试用例 MD 转 XMind/Excel 双格式成品的现行标准工具链（07_新标准工具链，§5.5 四层结构）。当用户要求"生成 XMind / MD 转 XMind / 用例转 XMind / 重新生成 XMind / 生成 Excel 用例 / 导出 Excel 表格用例"或交付前验证 XMind/Excel 时使用。
agent_created: true
---

# MD→XMind/Excel 生成 v2（§5.5 新标工具链·双格式）

## 触发场景

用户要求从测试用例 MD 生成 XMind、重出 XMind、生成/导出 Excel 表格用例，或对已有成品做交付前验证。

## 工具位置

`05_交付工具链D:\ZCodetest\MD转XMind生成工具集\07_新标准工具链7_新标准工具链（本包内）\`（**现行唯一标准**，取代 01_核心工具链；方法正本=同目录《MD转XMind生成方法_v1.md》，生成前必读）

## 执行流程（三步纪律，禁止跳步）

```bash
cd "05_交付工具链D:\ZCodetest\MD转XMind生成工具集\07_新标准工具链7_新标准工具链（本包内）"
python -X utf8 xmind_unified_generator_v2.py <md> [<out.xmind>]   # 生成
python -X utf8 xmind_format_validator_v2.py <out.xmind> <md>      # 结构验证：须 0 错 0 警
python -X utf8 compare_md_xmind_v2.py <md> <out.xmind>            # 数据终验：差异=0 才交付
python -X utf8 md2xlsx_v1.py <md> [<out.xlsx>]                     # Excel 成品（三步内置：生成+结构校验+数据终验差异=0，一条命令）
```

## 硬规则

1. 结构=§5.5 固定 4 层：L1=文件名主干+总条数直拼 / L2=章-节合并（全角（**章总条数**条）-节原文）/ L3=#### 行原文 / L4=恰 4 节点（优先级/前置条件/操作步骤/预期结果）；判断依据、测试方法不进 XMind。
2. 无 TC 的章/节（附录、代入表、统计、修改记录区）不进 XMind；验证器见空 L2 = ERROR。
3. 新旧两种 MD 格式自动识别（`TC-…（P0）` 五列表 vs `TC_001｜…[P0]` 加粗表），整册不得混排。**新标五列支持两种排法（2026-11-02 示例账单B补）**：竖排 label 行（`| 前置条件 | 内容 |`）与横排五列（表头行+分隔行+单数据行）逐用例自动识别；横排数据行须恰 5 列，列数异常回落 label 逻辑并由终验暴露。
4. XMind 8 兼容：content.xml + **meta.xml** + manifest，禁 content.json；禁用 xmind 库 1.2 构建（API 有坑），手写 XML。
5. `<br>`→字面换行、`**` 剥离；MD 一律 utf-8-sig 读；L1 以文件名为正源（不取 H1）。
6. 交付提醒用户先关闭 XMind 旧文件再重开。
7. **Excel 成品（2026-11-05 增，交付物规范 §19；脚本 v1.1 对齐参考《示例考核政策_标准测试用例.xlsx》）**：16 列=外部 14 列超集（+判断依据+测试方法，判断依据禁丢）；执行三列留空（设计/执行分离，由执行方回填）；Sheet 顺序=需求映射表（banner+REQ-{节号}）/测试用例（R1 表头）/公共测试数据（banner，承载 PRE，表行式+标题式两形态识别）/统计与说明（内部）；无 TC 附表不进；场景类型=功能/边界/异常三态（方法+负向关键词推断）；执行方式按 TC-API 前缀推断；与 MD/XMind 同 stem 同版本号（_v{N}.xlsx）。

## 验收基线（2026-10-27）

示例仓储流程价格 11.30：978 条重生成与已交付成品逐条全等；退货费旧格式 115 条含 v1 老脚本交叉差异=0。
