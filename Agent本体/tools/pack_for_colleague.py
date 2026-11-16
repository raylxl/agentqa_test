# -*- coding: utf-8 -*-
"""pack_for_colleague.py — 一键打包"发给同事"的分发包（2026-11-14 立，触发=第二实例出现）

两种模式升级为三种（发谁用哪种）：
  --mode internal   公司内同事·复刻完整能力：agentqa_test 三包 + 外部正本资产
                    （标准体系 / jt_chrome〔默认瘦身〕——2026-11-16 裁剪：需求用例库/台账/AiTest 等工作数据不随包）
                    → dist\测试agent_内部完整包[_无凭证].zip（固定名；包内含 部署说明_同事版 + MANIFEST）
  --mode company    公司层包（2026-11-16 三层拆分 v2.0）：公开层+公司层+域层起步模板，
                    **不含域层资产**（用例库/台账/标准正本/jt_chrome 域工件）——同事按《域层起步指引》自建
                    → dist\测试agent_公司层包.zip（固定名）
  --mode external   外部/别家公司·只要方法论：手艺包整包，先过发版机检 generic_layer_check
                    （红=禁止出包）→ dist\手艺包_发版件.zip（固定名）
  --no-secrets      仅 internal：不带走 agent-secrets.json 明文凭证，替换为同结构空值骨架（同事自己填）
  --full            仅 internal：jt_chrome 连日志/截图/无头profile 等运行产物一起带（默认瘦身不带）
  --dry-run         只列收集清单与体积，不出包

典型用法：
  python pack_for_colleague.py --mode internal               # 内网同事，凭证随包（内网同权）
  python pack_for_colleague.py --mode internal --no-secrets  # 凭证留骨架
  python pack_for_colleague.py --mode external               # 外发方法论
同事侧部署只需一条命令：rewire.py --repair（详见包内 部署说明_同事版_v2.md）。
"""
import argparse
import io
import json
import os
import subprocess
import sys
import time
import zipfile
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

AGENT_ROOT = Path(__file__).resolve().parents[2]      # …\agentqa_test\Agent本体\tools\ 上溯两级
DIST = AGENT_ROOT / "dist"

# 通用排除（任何模式都不带）：git 元数据 / Python 缓存 / 本脚本自己的产出目录 /
# playwright 工具缓存目录 / 运行日志（.log 属运行产物，2026-11-14 出包 QC 发现 AiTest 混入 5 个）
COMMON_EXCLUDE_NAMES = {"__pycache__", ".git", "dist", ".playwright-cli"}
COMMON_EXCLUDE_SUFFIX = (".log", ".pyc")
# jt_chrome 瘦身：日志与截图、无头浏览器 profile 属运行垃圾，非家底
JT_EXCLUDE_NAMES = {"ego_shots", "shots"}
JT_EXCLUDE_PREFIX = (".headless",)
JT_EXCLUDE_SUFFIX = ()


def is_reparse(p):
    try:
        return bool(os.lstat(p).st_file_attributes & 0x400)
    except (OSError, AttributeError):
        return False


def load_company_cfg():
    """与 rewire.py 同款：agentqa_test 下按内容特征定位公司包（改名免疫），拿 paths"""
    for d in sorted(AGENT_ROOT.iterdir()):
        try:
            if d.name.startswith(".") or not d.is_dir() or is_reparse(d):
                continue
            f = d / "agent-company.json"
            if f.exists():
                return json.loads(io.open(f, encoding="utf-8").read()), d
        except OSError:
            continue
    sys.exit("[RED] 未定位到 agent-company.json（公司包缺失或位置异常），中止")


def open_lp(p):
    s = str(p)
    return io.open("\\\\?\\" + s if len(s) > 240 else s, "rb")


def walk_collect(src, arc_prefix, skip=None):
    """迭代收集文件清单；跳过联接（记录，同事侧由 rewire --repair 重建）与排除规则命中的项"""
    files, junctions = [], []
    stack = [(Path(src), arc_prefix)]
    while stack:
        d, pref = stack.pop()
        try:
            entries = sorted(os.scandir(d), key=lambda e: e.name)
        except OSError as e:
            print(f"  [WARN] 无法读取 {d}：{e}")
            continue
        for ent in entries:
            p = Path(ent.path)
            try:
                isd = ent.is_dir(follow_symlinks=False)
            except OSError:
                continue
            if p.name in COMMON_EXCLUDE_NAMES:
                continue
            if not isd and p.name.lower().endswith(COMMON_EXCLUDE_SUFFIX):
                continue
            if skip and skip(p, isd):
                continue
            if is_reparse(p):
                try:
                    tgt = os.readlink(p)
                except OSError:
                    tgt = "?"
                junctions.append((f"{pref}/{p.name}", str(tgt)))
                continue
            if isd:
                stack.append((p, f"{pref}/{p.name}"))
            else:
                files.append((p, f"{pref}/{p.name}"))
    return files, junctions


def human(n):
    return f"{n / 1048576:.1f}MB" if n >= 1048576 else f"{n / 1024:.0f}KB"


def secrets_skeleton(src):
    """按真实凭证文件生成同结构空值骨架：只保留键名与 _ 开头说明键，值全清空（不经过打印）"""
    data = json.loads(io.open(src, encoding="utf-8").read())

    def blank(o):
        if isinstance(o, dict):
            return {k: (blank(v) if not k.startswith("_") else v) for k, v in o.items()}
        return ""
    out = blank(data)
    out["_说明"] = ("骨架：由 pack_for_colleague.py --no-secrets 生成，值已清空、键结构与原文件一致。"
                    "填入你的账号凭证后保存；本文件=明文凭证唯一落点，仅限公司内使用，永不再外发。")
    return json.dumps(out, ensure_ascii=False, indent=2) + "\n"


def make_skip(names=(), prefixes=(), suffixes=()):
    names = set(names)

    def skip(p, isd):
        return (p.name in names or p.name.startswith(prefixes)
                or (not isd and p.name.lower().endswith(suffixes)))
    return skip


def deploy_note(secrets_included, roots_desc, full):
    cred = ("已含 agent-secrets.json（明文账密，内网同权直接可用）" if secrets_included
            else "凭证为空值骨架（agent-secrets.json），部署后填你的账号")
    extra = "" if full else "（默认瘦身：jt_chrome 不带日志/截图/无头profile）"
    return f"""# 测试 Agent 同事部署说明（内部完整包）

> 本包 = 发起人测试 Agent 的完整复刻件：agentqa_test 三包 + 标准体系正本 + 执行工具与坑库{extra}
> 不含发起人的工作数据（需求用例库/流水线台账/AiTest 汇报调研）——同事用自己的需求与数据跑（2026-11-16 定）
> 凭证状态：{cred}

## 部署五步（约 10 分钟）

1. 装 ZCode 客户端并登录（与发起人同款客户端）；电脑需 Python 3.8+ 且在 PATH。
   Python 第三方库仅 2 个：`pip install pymysql openpyxl`（DB 连通 / xlsx 载体生成用，不装则对应脚本挂）。
   脚本回归/接口通道层（`jt_chrome\\pw_layered`）另需 **Node.js 18+**；Playwright 库三级 fallback 解析
   （裸 require → ai-test-bench → WorkBuddy），同事机最简装法＝在 `D:\\ZCodetest\\` 下执行 `npm i playwright`。
2. 把 zip 整包解压到 `D:\\` 根 → 得到 `D:\\ZCodetest\\…`。**仅支持同路径部署**：jt_chrome 数百个执行脚本内嵌
   `D:\\ZCodetest` 绝对路径，换盘/换路径会大面积断。确需换路径：解压后先跑
   `python agentqa_test\\Agent本体\\tools\\migrate_paths.py <新根路径>`（默认 dry-run 预览，确认后加 `--apply`
   落改）——它会把公司配置 paths 与代码内路径全量换算并登记迁移别名；跑完再 `rewire.py --repair`
   重建联接，`param_check.py --check` 应回到全绿。
3. 打开 ZCode，workspace 选 `D:\\ZCodetest`。
4. 接线（一条命令 = 重建全部联接 + 幂等写入 hook 配置）：
   `python D:\\ZCodetest\\agentqa_test\\Agent本体\\tools\\rewire.py --repair`
   （首次执行会自动备份并写 `C:\\Users\\你\\.zcode\\cli\\config.json` 的 hooks 段——属重启级配置）
5. **重开 ZCode 会话**（hook 与配置生效）。

## 验证四道（全绿 = 部署成功）

1. `python D:\\ZCodetest\\agentqa_test\\Agent本体\\tools\\rewire.py --status` → 结论：全绿
2. `python D:\\ZCodetest\\agentqa_test\\公司包\\param_check.py --check` → 48 值 PASS（同路径部署时）
3. 冒烟：会话里说"登录鲸天"→ jingtian-login 技能应起 Chrome 9333 并自动登录
4. 冒烟：把包内 `agentqa_test\\公司包\\验证素材\\示例需求_公告管理_v1.md`（或你手头任一需求文档）丢进会话说"熟悉下这个需求"→ requirement-qa-loop 应走五段式提问

## 红线三条

- `agent-secrets.json` = 明文凭证唯一落点：仅限公司内，永不再外发/截图/贴聊天。
- 改 `agent-company.json` 须按硬规则 8 向使用者宣告（改配置必宣告 + 重开会话）。
- 手艺包对外发版必须先过 `generic_layer_check.py` 机检（内部互发不受此限，但公司包/环境登录技能仍禁出公司）。

## 包内根目录

{roots_desc}
- `00_Agent入口.md` — 第一入口（agent 全景导航，问"agent 有什么/流程"先看它）
- `部署说明_同事版_v2.md`（本文件）、`MANIFEST.json`（逐目录文件数/体积/排除规则/联接登记）

## 包外可选件（缺了不影响主干，按需自装）

- **LibreOffice 渲染链**（Word/PDF 转 PDF、出图）：发起人机为便携版 `D:\\LO_portable`，未随包；需要时自装并在相关脚本中替换指路。
- **MCP 两类未随包**（weknora 知识库 / 图片 flash 分流，属同事自己的 config.json 自管范畴）：知识库可内网直连替代，图片分析自动降级主模型直读。
- **bsk 浏览器技能**：用户级自装件不在包内；核心执行链走 Chrome CDP 9333，不依赖它。

## 常见问题

- 技能提示"先建公司配置/降级通用模式" = agent-company.json 没被找到 → 检查解压路径是否 `D:\\ZCodetest\\agentqa_test\\公司包\\`
- hook 不生效 → 确认重开过会话；`python --version` 能出 3.8+
- `Agent本体\\skills\\devops-login` 在包里不存在是正常的（联接不进 zip，`rewire --repair` 会重建）
"""


def pack_internal(cfg, company_dir, no_secrets, full, dry):
    paths = cfg["paths"]
    p_std, p_jt = Path(paths["标准体系"]), Path(paths["执行工具"])
    p_entry = AGENT_ROOT.parent / "00_Agent入口.md"          # 第一入口（2026-11-16 起随包）
    for p in (AGENT_ROOT, p_std, p_jt, p_entry):
        if not p.exists():
            sys.exit(f"[RED] 打包源不存在：{p}")

    jt_skip = None if full else make_skip(JT_EXCLUDE_NAMES, JT_EXCLUDE_PREFIX, JT_EXCLUDE_SUFFIX)

    # 2026-11-16 用户拍板裁剪：参考数据/工作状态不给同事——需求用例库、流水线台账、AiTest 移出 internal 包；
    # 保留运行必需（标准体系+jt_chrome 工具坑库规范）+三包+入口。
    plan = [                                   # (源, 包内前缀, 排除规则, 说明)
        (AGENT_ROOT, "agentqa_test", None, "三包本体（本体+手艺包+公司包）"),
        (p_std, p_std.name, None, "标准体系正本 L0~L7"),
        (p_jt, p_jt.name, jt_skip, "执行工具与坑库" + ("（瘦身：无日志/截图/无头profile）" if not full else "")),
        (p_entry, p_entry.name, None, "第一入口（agent 全景导航）"),
    ]

    all_files, junctions, roots_desc, manifest_roots = [], [], [], []
    print("── 收集清单 ──")
    for src, prefix, skip, note in plan:
        if src.is_file():
            files = [(src, prefix)]
            junc = []
        else:
            files, junc = walk_collect(src, prefix, skip)
        size = sum(os.path.getsize(f[0]) for f in files)
        print(f"  {prefix:<44} {len(files):>6} 文件  {human(size):>9}   （{note}）")
        all_files += files
        junctions += junc
        roots_desc.append(f"- `{prefix}/` — {note}")
        manifest_roots.append({"包内": prefix, "源": str(src), "文件数": len(files),
                               "字节": size, "排除": note})
    total = sum(os.path.getsize(f[0]) for f in all_files)
    print(f"  合计 {len(all_files)} 文件，{human(total)}")
    if junctions:
        print(f"  跳过联接 {len(junctions)} 处（同事侧 rewire --repair 重建）：")
        for a, t in junctions:
            print(f"    {a} → {t}")
    if dry:
        print("[dry-run] 未出包")
        return

    DIST.mkdir(exist_ok=True)
    name = f"测试agent_内部完整包{'_无凭证' if no_secrets else ''}.zip"   # 固定名（2026-11-16 用户拍板去日期：复制到别处永远覆盖同名不堆积；版本信息在 MANIFEST）
    out = DIST / name
    secrets_path = company_dir / "agent-secrets.json"
    print(f"── 写 zip：{out} ──")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for i, (f, arc) in enumerate(all_files, 1):
            if no_secrets and str(f).lower() == str(secrets_path).lower():
                continue                        # 骨架在收尾统一写入，避免真实凭证进包
            with open_lp(f) as fh:
                z.writestr(arc, fh.read())
            if i % 2000 == 0:
                print(f"    …{i}/{len(all_files)}")
        if no_secrets:
            z.writestr("agentqa_test/公司包/agent-secrets.json", secrets_skeleton(secrets_path))
            print("  [凭证] 已用空值骨架替换 agent-secrets.json")
        z.writestr("部署说明_同事版_v2.md",
                   deploy_note(not no_secrets, "\n".join(roots_desc), full))
        z.writestr("MANIFEST.json", json.dumps({
            "打包时间": time.strftime("%Y-%m-%d %H:%M:%S"), "模式": "internal",
            "含凭证": not no_secrets, "瘦身": not full,
            "生成器": str(Path(__file__)), "roots": manifest_roots,
            "跳过的联接": dict(junctions),
            "合计": {"文件数": len(all_files), "字节": total}}, ensure_ascii=False, indent=2))
    bad = None
    with zipfile.ZipFile(out) as z:
        bad = z.testzip()
        n = len(z.namelist())
    print(f"完成：{out.name}  {human(out.stat().st_size)}  校验 {'OK（CRC全过）' if not bad else '[RED] 损坏:' + str(bad)}  条目 {n}")


def deploy_note_company():
    return f"""# 测试 Agent 同事部署说明（公司层包 v3 · 三层拆分版，2026-11-16）

> 本包=公开层方法论（手艺包）+公司层（鲸天环境+执行框架 jt_exec）+域层起步模板——**域层数据（用例库/台账/需求文档/域标准）不随包分发，由你按《域层起步指引》自建自生成**。
> 凭证为空值骨架（agent-secrets.json），部署后填你的账号。

## 部署六步（约 15 分钟）

1. 装 ZCode 客户端并登录（与发起人同款客户端）；电脑需 Python 3.8+ 且在 PATH。
   Python 第三方库仅 2 个：`pip install pymysql openpyxl`；执行回归另需 **Node.js 18+** 与
   `D:\\<解压根>\\` 下 `npm i playwright`。
2. 把 zip 整包解压到固定根（**仅支持同路径部署**，换路径先跑 `agentqa_test\\Agent本体\\tools\\migrate_paths.py <新根> --apply`）。
3. 接线：`python <解压根>\\agentqa_test\\Agent本体\\tools\\rewire.py --repair`（重建联接+幂等写 hooks；也可加 `--workbuddy` 同时接入 WorkBuddy 客户端技能位）。
4. 建你的域配置：复制 `agentqa_test\\公司包\\agent-company.company-template.json` 为同目录 `agent-company.json`，
   **公司节已预填不动，域节【待填】按《域层起步指引》第二步填齐**（paths 四目录/naming/域词）；
   填完后先建你的机检基线：`python <解压根>\\agentqa_test\\公司包\\param_check.py --snapshot`（此后每次改动用 --check 校验）。
5. 填 `agentqa_test\\公司包\\agent-secrets.json` 你的账号四组。
6. **重开 ZCode 会话**，然后按《域层起步指引》第三步跑你的第一个需求。

## 验证四道（全绿=部署成功）

1. `python <解压根>\\agentqa_test\\Agent本体\\tools\\rewire.py --status` → 全绿
2. 域配置填完并 `--snapshot` 建基线后 `python <解压根>\\agentqa_test\\公司包\\param_check.py --check` → PASS
3. 冒烟：说"登录鲸天"→ 应起 Chrome 9333 自动登录
4. 冒烟：对 agent 说 **"熟悉下这个需求 <解压根>\\agentqa_test\\公司包\\验证素材\\示例需求_公告管理_v1.md"**
   → 应走五段式提问且**一问一停**（验证件随包，勿到处找文件）

## 红线

- agent-secrets.json=明文凭证唯一落点：仅限公司内，永不再外发。
- 公司词表 company_wordlist.json 与域层全部数据禁出公司。
- 你的域层数据由流水线自动生成，勿手工拷贝他人域数据（会污染你的正本治理）。
"""


def pack_company(cfg, company_dir, dry):
    """公司层包=可运行的公司版 agent 框架（公开+公司+本体）减域层资产。内网分发，凭证骨架。"""
    agent = AGENT_ROOT                      # agentqa_test
    craft = next((d for d in sorted(agent.iterdir())
                  if not d.name.startswith(".") and d.is_dir()
                  and (d / "03_检查脚本" / "generic_layer_check.py").exists()), None)
    if craft is None:
        sys.exit("[RED] 未定位到手艺包，中止")

    def skip_company(p, isd):
        rel = p.relative_to(company_dir).as_posix()
        if rel.startswith(("agent-company.json", "agent-secrets.json", "publish_rules.json",
                           "tools/legacy", "dist", "jt_exec/locks", "jt_exec/pw_layered/locks")):
            return True
        return False

    plan = [
        (agent / "Agent本体", "agentqa_test/Agent本体", None, "公司版技能+hooks+tools（rewire/pack/migrate）"),
        (craft, "agentqa_test/" + craft.name, None, "公开层方法论（标准/模板/机检/十技能通用副本）"),
        (company_dir / "skills", "agentqa_test/公司包/skills", None, "鲸天环境技能 5 件（全产品线共用）"),
        (company_dir / "jt_exec", "agentqa_test/公司包/jt_exec", None, "执行框架（登录/开菜单/切租户/pw_layered/校验器/Mock骨架）"),
        (company_dir / "执行环境适配细则.md", "agentqa_test/公司包/执行环境适配细则.md", None, "公司运行细则"),
        (company_dir / "agent-company.company-template.json", "agentqa_test/公司包/agent-company.company-template.json", None, "域配置模板（公司节预填+域节待填）"),
        (company_dir / "company_wordlist.json", "agentqa_test/公司包/company_wordlist.json", None, "公司机检词表（仅限公司内）"),
        (company_dir / "param_check.py", "agentqa_test/公司包/param_check.py", None, "参数化自检"),
        (company_dir / "域层起步指引_v1.md", "agentqa_test/公司包/域层起步指引_v1.md", None, "域层自建四步指引"),
        (company_dir / "验证素材", "agentqa_test/公司包/验证素材", None, "验证素材（示例需求：技能冒烟用）"),
    ]
    all_files, junctions, roots_desc, manifest_roots = [], [], [], []
    print("── 收集清单（company）──")
    for src, prefix, skip, note in plan:
        if not src.exists():
            print(f"  [WARN] 缺 {src}，跳过")
            continue
        if src.is_file():
            files, junc = [(src, prefix)], []
        else:
            files, junc = walk_collect(src, prefix, skip_company if src == company_dir else None)
        size = sum(os.path.getsize(f[0]) for f in files)
        print(f"  {prefix:<52} {len(files):>5} 文件  {human(size):>9}   （{note}）")
        all_files += files
        junctions += junc
        roots_desc.append(f"- `{prefix}` — {note}")
        manifest_roots.append({"包内": prefix, "源": str(src), "文件数": len(files), "字节": size, "说明": note})
    total = sum(os.path.getsize(f[0]) for f in all_files)
    print(f"  合计 {len(all_files)} 文件，{human(total)}")
    if junctions:
        print(f"  跳过联接 {len(junctions)} 处（同事侧 rewire --repair 重建）")
    if dry:
        print("[dry-run] 未出包")
        return

    DIST.mkdir(exist_ok=True)
    out = DIST / "测试agent_公司层包.zip"   # 固定名（去日期，覆盖式复制；版本在 MANIFEST）
    secrets_path = company_dir / "agent-secrets.json"
    print(f"── 写 zip：{out} ──")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for f, arc in all_files:
            if str(f).lower() == str(secrets_path).lower():
                continue
            with open_lp(f) as fh:
                z.writestr(arc, fh.read())
        z.writestr("agentqa_test/公司包/agent-secrets.json", secrets_skeleton(secrets_path))
        z.writestr("部署说明_同事版_v3.md", deploy_note_company())
        z.writestr("MANIFEST.json", json.dumps({
            "打包时间": time.strftime("%Y-%m-%d %H:%M:%S"), "模式": "company",
            "三层": "公开层+公司层（域层自建，见域层起步指引）",
            "生成器": str(Path(__file__)), "roots": manifest_roots,
            "跳过的联接": dict(junctions),
            "合计": {"文件数": len(all_files), "字节": total}}, ensure_ascii=False, indent=2))
    bad = None
    with zipfile.ZipFile(out) as z:
        bad, n = z.testzip(), len(z.namelist())
    print(f"完成：{out.name}  {human(out.stat().st_size)}  校验 {'OK（CRC全过）' if not bad else '[RED] 损坏:' + str(bad)}  条目 {n}")


def pack_external(cfg, company_dir, dry):
    craft = None
    for d in sorted(AGENT_ROOT.iterdir()):
        if not d.name.startswith(".") and d.is_dir() and (d / "03_检查脚本" / "generic_layer_check.py").exists():
            craft = d
            break
    if not craft:
        sys.exit("[RED] 未定位到手艺包（缺 03_检查脚本\\generic_layer_check.py），中止")
    wordlist = company_dir / "company_wordlist.json"
    print(f"── 发版门禁：generic_layer_check（手艺包={craft.name}） ──")
    r = subprocess.run([sys.executable, str(craft / "03_检查脚本" / "generic_layer_check.py"),
                        str(craft), "--config", str(wordlist)], capture_output=True)
    sys.stdout.write(r.stdout.decode("utf-8", "replace")[-1500:] + "\n")
    if r.returncode != 0:
        sys.stdout.write(r.stderr.decode("utf-8", "replace")[-500:] + "\n")
        sys.exit("[RED] 手艺包机检未过 —— 禁止出包（先修红项再重跑）")
    files, junctions = walk_collect(craft, craft.name)
    total = sum(os.path.getsize(f[0]) for f in files)
    print(f"  收集 {len(files)} 文件 {human(total)}；跳过联接 {len(junctions)} 处")
    if dry:
        print("[dry-run] 未出包")
        return
    DIST.mkdir(exist_ok=True)
    ver = ""
    try:
        ver = "_" + subprocess.run(["git", "-C", str(craft), "rev-parse", "--short", "HEAD"],
                                   capture_output=True).stdout.decode().strip()
    except Exception:
        pass
    out = DIST / "手艺包_发版件.zip"   # 固定名（去日期；git 哈希与时间在 MANIFEST）
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for f, arc in files:
            with open_lp(f) as fh:
                z.writestr(arc, fh.read())
    bad = None
    with zipfile.ZipFile(out) as z:
        bad, n = z.testzip(), len(z.namelist())
    print(f"完成：{out.name}  {human(out.stat().st_size)}  校验 {'OK（CRC全过）' if not bad else '[RED] 损坏:' + str(bad)}  条目 {n}")


def main():
    ap = argparse.ArgumentParser(description="一键打包（internal=内网完整复刻 / company=公司层包〔域层自建〕 / external=外发方法论）")
    ap.add_argument("--mode", choices=["internal", "company", "external"], required=True)
    ap.add_argument("--no-secrets", action="store_true", help="internal：凭证文件换空值骨架")
    ap.add_argument("--full", action="store_true", help="internal：jt_chrome 连运行产物一起带（默认瘦身）")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    cfg, company_dir = load_company_cfg()
    if a.mode == "internal":
        pack_internal(cfg, company_dir, a.no_secrets, a.full, a.dry_run)
    elif a.mode == "company":
        pack_company(cfg, company_dir, a.dry_run)
    else:
        pack_external(cfg, company_dir, a.dry_run)


if __name__ == "__main__":
    main()
