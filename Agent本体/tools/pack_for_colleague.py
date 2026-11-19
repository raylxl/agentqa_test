# -*- coding: utf-8 -*-
"""pack_for_colleague.py — 同事安全包/外发方法论包生成器。

模式：
  --mode internal   生成唯一可发的公司内同事安全包：三包方法/标准/技能/精简执行内核，凭证空骨架，
                    不含需求库、台账、执行结果、抓包、截图、个人数据或明文凭证；写后安全门禁红即删包。
                    产物：dist/测试agent_同事安全包.zip（兼容别名：测试agent_内部完整包_无凭证.zip）
  --mode external   只发通用方法论手艺包，先过 generic_layer_check。
  --mode company    已禁用（历史模式容易缺配置/误导部署）；需要公司内同事使用请用 internal 安全包。
  --dry-run         只列清单，不出包。

同事：解压到任意目录，Windows 双击 部署.bat，macOS 运行 部署.command。
"""
import argparse
import hashlib
import io
import json
import os
import re
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
# node_modules（2026-11-19 出包门禁实证混入：playwright 源码触发硬密码误报+png 运行数据红；
#   依赖=同事侧部署器"依赖自装"步 npm i，不随包）
COMMON_EXCLUDE_NAMES = {"__pycache__", ".git", "dist", ".playwright-cli", "node_modules"}
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


def secret_replacements(src):
    """分发视图替换：仅替换账号/口令/主机/显示名/token/session；不碰 database/port/note 等结构词。"""
    data=json.loads(io.open(src,encoding="utf-8").read())
    out={}; sensitive={"user","pass","password","host","display","token","session","sessionid"}
    for group,fields in data.items():
        if not isinstance(fields,dict) or group.startswith("_"): continue
        for key,val in fields.items():
            if key.lower() in sensitive and isinstance(val,str) and val:
                out[val]=f"<LOCAL_{group.upper()}_{key.upper()}>"
    return sorted(out.items(),key=lambda x:len(x[0]),reverse=True)


def sanitize_distribution_bytes(arc, data, replacements):
    """仅对文本件生成分发视图；工作区正本不改。"""
    if Path(arc).suffix.lower() not in {".py",".js",".cjs",".mjs",".json",".md",".txt",".ps1",".sh",".yaml",".yml",".toml"}:
        return data
    try:s=data.decode("utf-8")
    except UnicodeDecodeError:return data
    for old,new in replacements:
        s=s.replace(old,new)
    return s.encode("utf-8")


def make_skip(names=(), prefixes=(), suffixes=()):
    names = set(names)

    def skip(p, isd):
        return (p.name in names or p.name.startswith(prefixes)
                or (not isd and p.name.lower().endswith(suffixes)))
    return skip


DEPLOY_BAT = r"""@echo off
chcp 65001 >nul
title Test Agent Deploy
echo ===== Test Agent one-click deploy =====
echo Current folder = deploy folder. Do NOT move it after install.
echo (If moved: re-run this file again.)
where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found. Install Python 3.8+ with "Add to PATH" first.
  pause
  exit /b 1
)
set "AGENT_CORE="
for /d %%D in ("%~dp0agentqa_test\Agent*") do if exist "%%D\tools\deploy_colleague.py" set "AGENT_CORE=%%D"
if not defined AGENT_CORE (
  echo [ERROR] Agent core not found under agentqa_test.
  pause
  exit /b 1
)
python "%AGENT_CORE%\tools\deploy_colleague.py" %*
echo.
pause
"""

DEPLOY_COMMAND = """#!/bin/bash
# 测试 Agent 一键部署（macOS）——双击本文件即跑；若系统提示无法打开：右键→打开，或终端执行 chmod +x 部署.command
cd "$(dirname "$0")"
echo "===== 测试 Agent 一键部署（macOS）====="
echo "本目录 = 部署目录（装完别挪；挪了重跑本文件即可）"
if ! command -v python3 >/dev/null 2>&1; then
  echo "[错误] 未找到 python3——请先安装 Python 3（python.org 下载安装）后重跑"
  read -p "按回车退出..."
  exit 1
fi
python3 "agentqa_test/Agent本体/tools/deploy_colleague.py" "$@"
echo
read -p "按回车退出..."
"""

MAC_FIRST_READ = """【Mac 同事先看这个】部署.command 双击被拦的处理（三步）

如果双击 部署.command 弹出"Apple 无法验证…"——这不是文件坏了，是 macOS 对外来脚本的默认安全拦截（Gatekeeper）。
别点"移到废纸篓"！按下面任一法继续：

方法一（最简单，推荐）：
  1. 按 Command+空格，输入 terminal，回车（打开终端）
  2. 输入 bash 加一个空格
  3. 把 部署.command 这个文件拖进终端窗口（路径自动填上）
  4. 回车 —— 部署开始

方法二（想以后都能双击）：
  双击被拦后 → 系统设置 → 隐私与安全性 → 页面底部会出现"部署.command 已被阻止" → 点"仍要打开"

方法三（终端命令去掉隔离标记，一劳永逸）：
  xattr -d com.apple.quarantine 部署.command
  （在解压目录里执行：先 cd 到解压目录，或把文件拖到命令后面）

前置要求：已装 python3（终端输入 python3 --version 能出版本号）。
完整验证步骤见包内《真机首验清单_v1.md》macOS 专项节。
"""


def deploy_note(secrets_included, roots_desc, full):
    return f"""# 测试 Agent 同事部署说明（安全包）

> 本包只含 Agent 方法、标准、技能、精简执行内核与部署工具；不含发起人的需求库、台账、截图、抓包、执行结果、个人数据或明文凭证。
> `agent-secrets.json` 为全空骨架：部署后在**本机**填写自己的账号/口令/显示名，禁止把填过的文件再转发。

## 首次安装（两步）

1. 前置：Python 3.8+；需要执行鲸天自动化时还需 Node.js 18+ 与 Google Chrome。部署器会自动安装 playwright、pymysql、openpyxl；失败会明确提示。
2. 解压到任意自选目录：Windows 双击 `部署.bat`，macOS 运行 `部署.command`（Gatekeeper 处理见 `Mac首步启动.txt`）。
   部署器会自动：补空用户数据目录、迁移路径、列出本机已装宿主供你选择、只接入你选的宿主、安装依赖、运行 `param_check` 并登记安装位置。

## 宿主档位

- ZCode：技能+五道机器闸（已在发起人机验证）。
- WorkBuddy / Codex：技能接入+软闸检查；无工具级 hooks。
- Claude Code / CodeBuddy：仅为试验档；技能接线已实现，但 hooks/CLI 兼容性未完成真机验收，不得宣称 100%。

## 升级

新包解压到临时目录后运行部署入口。部署器会检测旧安装位置；回车升级时只覆盖程序件，需求库、台账、Chrome 登录态、公司配置、凭证和执行结果不覆盖。升级完成后重开宿主会话。

## git 日常更新（免打包通道，2026-11-17 增）

发起人的 GitHub 仓（`git@github.com:raylxl/agentqa_test.git`，私有）与本包内容同源；开通权限后**日常更新不用再拿新 zip**，一条 pull 加一次部署即可。

前提（只做一次）：同事注册 GitHub 账号并添加自己的 SSH 公钥，发起人在仓库 Settings→Collaborators 添加其用户名。

首次接入 git：
- 已装过 zip 的：把已装的 `agentqa_test` 转成 git 仓（reset 会还原占位路径，下一步部署器自动换算回本机路径）：
  ```bash
  cd <部署根>\\agentqa_test
  git init && git remote add origin git@github.com:raylxl/agentqa_test.git
  git fetch origin && git reset --hard origin/main
  ```
- 新同事直接克隆（无需 zip）：
  ```bash
  mkdir <部署根> && cd <部署根>
  git clone git@github.com:raylxl/agentqa_test.git
  python agentqa_test\\Agent本体\\tools\\deploy_colleague.py
  ```

日常更新（每次）：
```bash
git -C <部署根>\\agentqa_test status   # ① 确认无本地改动（正常应干净）
git -C <部署根>\\agentqa_test pull     # ② 拉最新代码
双击 <部署根>\\部署.bat                # ③ 重跑部署器：自动换算路径→选宿主→装依赖→param_check 全绿
```

为什么安全：已填的 `agent-secrets.json` 在 .gitignore，pull 永不覆盖；需求库/台账/Chrome 登录态在 `agentqa_test/` 之外，pull 碰不到；pull 进来的新文件带占位路径，部署器第③步自动换算并经 param_check 验证，红会明说不会假成功。升级一律走 git：克隆/拉取本仓+跑一次自举（已装安全包的机器=一次性迁移到 git 克隆，此后纯 pull）。zip 只作首次交付件，不再二次发版（2026-11-19 拍板：同事侧永远=获取 git 即可）。

## 验证

1. `agentqa_test/公司包/param_check.py --check` → PASS。
2. 所选宿主的 skills 目录出现技能联接；未选择的宿主不被修改。
3. 填好 `agentqa_test/公司包/agent-secrets.json` 后，说“登录鲸天”做环境冒烟。
4. 用包内 `agentqa_test/公司包/验证素材/示例需求_公告管理_v1.md` 说“熟悉下这个需求”，应进入五段式答疑。

## 红线

- 本包永远无凭证；凭证只在同事本机填写。
- 不转发填过的凭证文件、运行结果、截图或抓包。
- 任何部署/升级步骤出现红项，按《真机首验清单》回传，不要继续宣称完成。

## 包内清单

{roots_desc}
- `部署.bat` / `部署.command` — 双平台入口
- `真机首验清单_v1.md`、`MANIFEST.json` — 验收清单与逐文件 SHA-256 清单
"""


def pack_internal(cfg, company_dir, no_secrets, full, dry):
    """同事完整运行包：只从 agentqa_test 三包取材。默认/强制无凭证；历史需求与执行原料场不入包。"""
    p_entry = AGENT_ROOT.parent / "00_Agent入口.md"
    for p in (AGENT_ROOT, p_entry):
        if not p.exists():
            sys.exit(f"[RED] 打包源不存在：{p}")
    if not no_secrets:
        sys.exit("[RED] 同事包禁止携带明文凭证：请加 --no-secrets（默认命令会自动启用）")
    if full:
        sys.exit("[RED] --full 已禁用：运行产物/抓包/截图/历史数据不得随同事包分发")

    def skip_agent(p, isd):
        try:
            rel = p.relative_to(AGENT_ROOT).as_posix()
        except ValueError:
            rel = p.name
        if rel in {"Agent与工作区文件存放位置标准_v1.md", "ZCode测试Agent_用例生成与测试执行可行性核查问题单_v1.md"}:
            return True
        if rel.startswith(("_git归档/", "dist/", "公司包/tools/legacy/")):
            return True
        if "/__pycache__/" in "/" + rel or rel.endswith("/__pycache__"):
            return True
        if rel.startswith("公司包/skills/") and not isd and p.suffix.lower() in {".png", ".jpg", ".jpeg"}:
            return True
        if rel.startswith("公司包/jt_exec/"):
            tail = rel[len("公司包/jt_exec/"):]
            parts = tail.split("/")
            if any(x in {"locks", "run-results", "shots", "ego_shots", ".headless_profile", ".headless_r7", "netlog", "apicap"}
                   or x.startswith(("evid_", "_r", "_rg", "_t")) for x in parts[:-1] if x):
                return True
            if not isd and p.suffix.lower() in {".png", ".jpg", ".jpeg", ".xlsx", ".xlsm", ".jsonl", ".out", ".log"}:
                return True
        # 蓝湖采集（lanhu_exec）：本机地址/批量进度/运行产物（out·logs·pyc）永不入包，同事自填地址
        if rel.startswith("公司包/lanhu_exec/"):
            tail = rel[len("公司包/lanhu_exec/"):]
            if tail in {"lanhu_config.json", ".batch_progress.json"} or tail.split("/")[0] in {"out", "logs", "__pycache__"}:
                return True
        return False

    plan = [
        (AGENT_ROOT, "agentqa_test", skip_agent,
         "三包运行本体（Agent本体+通用手艺包+公司包；含标准体系、精简执行内核、L4域标准；不含需求库/运行结果/抓包/截图/个人数据）"),
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
        manifest_roots.append({"包内": prefix, "文件数": len(files), "字节": size, "说明": note})
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
    # 安全策略：同事包只产无凭证版。旧带凭证 ZIP 若存在立即删除，避免误发。
    unsafe = DIST / "测试agent_内部完整包.zip"
    if unsafe.exists():
        unsafe.unlink()
        print("  [安全] 已删除历史带凭证包：测试agent_内部完整包.zip")
    # 唯一可发件：不再并存“完整包/无凭证包”等易混名称。
    for old_name in ("测试agent_内部完整包.zip", "测试agent_内部完整包_无凭证.zip"):
        (DIST / old_name).unlink(missing_ok=True)
    out = DIST / "测试agent_同事安全包.zip"
    secrets_path = company_dir / "agent-secrets.json"
    print(f"── 写安全 zip：{out} ──")
    generated = {
        "部署说明_同事版_v2.md": deploy_note(False, "\n".join(roots_desc), False).encode("utf-8"),
        "部署.bat": DEPLOY_BAT.replace("\n", "\r\n").encode("gbk"),
        "部署.command": DEPLOY_COMMAND.encode("utf-8"),
        "Mac首步启动.txt": MAC_FIRST_READ.encode("utf-8"),
    }
    checklist = AGENT_ROOT / "真机首验清单_v1.md"
    if checklist.exists():
        generated["真机首验清单_v1.md"] = io.open(checklist, encoding="utf-8").read().encode("utf-8")
    skeleton = secrets_skeleton(secrets_path).encode("utf-8")
    replacements = secret_replacements(secrets_path)

    import importlib.util
    view_file=Path(__file__).with_name("package_views.py")
    spec=importlib.util.spec_from_file_location("package_views", view_file)
    views=importlib.util.module_from_spec(spec); spec.loader.exec_module(views)
    company_config_view, standards_index_view = views.company_config_view, views.standards_index_view
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for f, arc in all_files:
            if str(f).lower() == str(secrets_path).lower():
                continue
            with open_lp(f) as fh:
                data=fh.read()
            if arc == "agentqa_test/公司包/agent-company.json":
                data=company_config_view(data)
            elif arc == "agentqa_test/公司包/标准体系/00_标准体系索引.md":
                data=standards_index_view(data)
            data=sanitize_distribution_bytes(arc,data,replacements)
            z.writestr(arc, data)
        z.writestr("agentqa_test/公司包/agent-secrets.json", skeleton)
        for name, data in generated.items():
            if name == "部署.command":
                zi = zipfile.ZipInfo(name, date_time=time.localtime()[:6])
                zi.create_system = 3                         # Unix 条目，macOS 解压器才会恢复执行位
                zi.external_attr = 0o100755 << 16           # regular file + 0755
                z.writestr(zi, data)
            else:
                z.writestr(name, data)

    # 写后门禁：先审不含 MANIFEST 的成品；红即删包。
    audit_script = AGENT_ROOT / "Agent本体" / "tools" / "package_audit.py"
    r = subprocess.run([sys.executable, str(audit_script), str(out), str(secrets_path)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        print(r.stdout[-4000:]); out.unlink(missing_ok=True)
        sys.exit("[RED] 最终 ZIP 安全门禁未过，产物已删除")

    # 从最终 ZIP 反向生成逐文件 SHA-256 清单，然后写入 MANIFEST。
    with zipfile.ZipFile(out) as z:
        final_files=[]
        for info in z.infolist():
            b=z.read(info.filename)
            final_files.append({"path":info.filename,"bytes":len(b),"sha256":hashlib.sha256(b).hexdigest()})
    manifest={
        "打包时间":time.strftime("%Y-%m-%d %H:%M:%S"), "模式":"internal-safe", "含凭证":False,
        "生成器":str(Path(__file__)), "roots":manifest_roots, "跳过的联接":dict(junctions),
        "合计":{"文件数":len(final_files),"字节":sum(x["bytes"] for x in final_files)}, "files":sorted(final_files,key=lambda x:x["path"])}
    with zipfile.ZipFile(out, "a", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        z.writestr("MANIFEST.json", json.dumps(manifest,ensure_ascii=False,indent=2))
    with zipfile.ZipFile(out) as z:
        bad,n=z.testzip(),len(z.namelist())
    if bad:
        out.unlink(missing_ok=True); sys.exit(f"[RED] ZIP CRC 损坏：{bad}")
    print(f"完成：{out.name}  {human(out.stat().st_size)}  CRC全过  条目 {n}  写后安全门禁全绿")


def deploy_note_company():
    return f"""# 测试 Agent 同事部署说明（公司层包 v3 · 三层拆分版，2026-11-16）

> 本包=公开层方法论（手艺包）+公司层（鲸天环境+执行框架 jt_exec）+域层起步模板——**域层数据（用例库/台账/需求文档/域标准）不随包分发，由你按《域层起步指引》自建自生成**。
> 凭证为空值骨架（agent-secrets.json），部署后填你的账号。

## 部署六步（约 15 分钟）

1. 装 ZCode 客户端并登录（与发起人同款客户端）；电脑需 Python 3.8+ 且在 PATH。
   Python 第三方库 4 个：`pip install pymysql openpyxl pillow playwright`（pillow/playwright 供蓝湖采集）；执行回归另需 **Node.js 18+** 与
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
    ap.add_argument("--no-secrets", action="store_true", help="兼容参数；internal 始终无凭证（默认即安全）")
    ap.add_argument("--full", action="store_true", help="已禁用：运行产物/历史数据不允许随同事包")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    cfg, company_dir = load_company_cfg()
    if a.mode == "internal":
        pack_internal(cfg, company_dir, True, a.full, a.dry_run)  # internal 永远安全无凭证
    elif a.mode == "company":
        sys.exit("[RED] company 历史模式已禁用；公司内同事请用 --mode internal 安全包")
    else:
        pack_external(cfg, company_dir, a.dry_run)


if __name__ == "__main__":
    main()
