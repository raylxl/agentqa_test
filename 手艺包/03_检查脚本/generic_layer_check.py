# -*- coding: utf-8 -*-
"""
generic_layer_check.py — 通用层机检（手艺包防污染门禁）
扫描目标目录内全部文本文件，零容忍四类污染：
  ①专属名词（词表来自 --config，包内不携带任何真实词表——词表属使用方私有数据）
  ②本机绝对路径（任意盘符） ③内网IP(10.x)与内网域名（域名模式来自 --config）
  ④明文凭证形态
任何命中=红，exit 1。手艺包每次重出发版前必过本机检。

用法:
  python generic_layer_check.py [目标目录] [--config 词表.json] [--out 报告.md] [--selftest]
词表 JSON 结构（见同目录 wordlist.example.json）:
  { "words": ["你的系统专名", ...],
    "domain_patterns": ["example-corp\\.com", ...],
    "short_hosts": ["gw-internal", ...] }
"""
import re
import sys
import json
import argparse
import datetime
import tempfile
import random
import string
import os
from pathlib import Path

PACK_ROOT = Path(__file__).resolve().parent.parent

# ---- 内置通用规则（与任何具体公司无关） ----
PATH_RULES = [
    ("本机绝对路径", re.compile(r'\b[A-Za-z]:[/\\][^\s"\'，。；）)]{4,}')),
]
NET_RULES = [
    ("内网IP 10.x", re.compile(r'\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b')),
]
# 邮箱（2026-11-16 增，公网发版防个人邮箱泄露；example.* 保留域除外）
EMAIL_RX = re.compile(r'\b[A-Za-z0-9._%+\-]+@(?!example\.)[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+\b')
CRED_RULES = [
    ("明文口令password=", re.compile(r'(?i)passw(?:or)?d\s*[=:：]\s*[A-Za-z0-9!@#$%^&*_\-+=.]{4,}')),
    ("密码:值", re.compile(r'密\s*码\s*[=:：]\s*[A-Za-z0-9!@#$%^&*_\-+=.]{4,}')),
    ("账号密码并列", re.compile(
        r'(?:账号|用户名)\s*[:：]?\s*[A-Za-z0-9_.\-]{2,30}\s*[,，;/|]?\s*'
        r'(?:密码|口令)\s*[:：]?\s*[A-Za-z0-9!@#$%^&*_\-+=.]{4,}')),
    ("API Key sk-", re.compile(r'\bsk-[A-Za-z0-9]{16,}')),
    ("邮箱地址", EMAIL_RX),
]

TEXT_EXT = {".md", ".py", ".js", ".json", ".yaml", ".yml", ".ps1", ".jsonl", ".txt", ".example"}


def load_rules(config_path):
    """内置通用规则 + 使用方词表（专属名词/内网域名/内网短主机名）"""
    words, net = [], list(NET_RULES)
    if config_path:
        cfg = json.loads(Path(config_path).read_text(encoding="utf-8"))
        words = [w for w in cfg.get("words", []) if w]
        if cfg.get("domain_patterns"):
            pats = "|".join(cfg["domain_patterns"])
            net.append(("内网域名(配置)", re.compile(r'\b[\w\-]+(?:\.[\w\-]+)*\.(?:' + pats + r')\b')))
        for h in cfg.get("short_hosts", []):
            net.append(("内网主机名(配置)", re.compile(r'\b' + re.escape(h) + r'[\w.\-]*\b')))
    return words, net


def scan_file(path: Path, words, net_rules):
    hits = []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return [("READ_ERROR", 0, "不可读")]
    for i, line in enumerate(text.splitlines(), 1):
        for w in words:
            if w in line:
                hits.append(("专属名词(配置)", i, w))
        for name, rx in PATH_RULES + net_rules + CRED_RULES:
            m = rx.search(line)
            if m:
                hits.append((name, i, m.group(0)[:60]))
    return hits


def _is_reparse(path):
    try:
        return bool(os.lstat(path).st_file_attributes & 0x400)
    except (OSError, AttributeError):
        return False


def run_scan(target: Path, words, net_rules):
    results = {}
    for root, dirs, files in os.walk(target, topdown=True, followlinks=False):
        dirs[:] = [d for d in dirs if not _is_reparse(Path(root) / d)]
        for name in sorted(files):
            p = Path(root) / name
            if p.resolve() == Path(__file__).resolve():
                continue
            if p.suffix.lower() in TEXT_EXT or p.name.endswith(".example"):
                hits = scan_file(p, words, net_rules)
                if hits:
                    results[str(p)] = hits
    return results


def scan_git_meta(target: Path, net_rules):
    """git 元数据扫描（--include-gitmeta，2026-11-16 增）：.git 无后缀文件不在常规扫描内，
    单独查 config/logs/COMMIT_EDITMSG 等中的邮箱（author/committer）与内网地址。返回 hit 列表或 None(无 .git)。"""
    gitdir = target / ".git"
    if not gitdir.is_dir():
        return None
    cand = [gitdir / n for n in ("config", "description", "COMMIT_EDITMSG", "packed-refs", "FETCH_HEAD", "ORIG_HEAD")]
    logs = gitdir / "logs"
    if logs.is_dir():
        for root, _dirs, files in os.walk(logs):
            cand += [Path(root) / f for f in files]
    hits = []
    for p in cand:
        if not p.is_file():
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            m = EMAIL_RX.search(line)
            if m:
                hits.append((f"git元数据邮箱({p.name})", i, m.group(0)[:60]))
            for name, rx in net_rules:
                m = rx.search(line)
                if m:
                    hits.append((f"git元数据{name}({p.name})", i, m.group(0)[:60]))
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target", nargs="?", default=str(PACK_ROOT))
    ap.add_argument("--config")
    ap.add_argument("--out")
    ap.add_argument("--include-gitmeta", action="store_true",
                    help="同时扫描 .git 元数据（config/logs/COMMIT_EDITMSG 等无后缀文件）中的邮箱与内网地址")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        # 自测通过运行时拼接测试样例，避免扫描器源码自身触发凭证/IP规则。
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump({"words": ["示例专名甲"], "domain_patterns": ["example-corp"],
                       "short_hosts": ["gw-demo"]}, f)
            cfgp = f.name
        ip = ".".join(("10", "1", "2", "3"))
        demo_secret = "Abc" + "12345"
        injected = "\n".join((
            "注入行1：示例专名甲 系统",
            "注入行2：路径 " + ":".join(("C", "/Users/x/demo.txt")),
            "注入行3：IP " + ip,
            "注入行4：域名 a.example-corp.com 与主机 gw-demo-1",
            "注入行5：口令 " + "password" + "=" + demo_secret,
            "注入行6：联系 dev@corp-demo" + ".cn（example 保留域应放行：safe@example.com 不命中）",
        ))
        try:
            with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as f:
                f.write(injected)
                tmp = Path(f.name)
            words, net = load_rules(cfgp)
            hits = scan_file(tmp, words, net)
            # git 元数据实测：临时 .git/logs/HEAD 含作者邮箱 → scan_git_meta 必须命中
            import shutil
            gitroot = Path(tempfile.mkdtemp())
            (gitroot / ".git" / "logs").mkdir(parents=True)
            (gitroot / ".git" / "logs" / "HEAD").write_text(
                "0000 aaa <dev@corp-demo" + ".cn> 1110 bbb <x@y" + ".test>\n", encoding="utf-8")
            git_hits = scan_git_meta(gitroot, net) or []
            shutil.rmtree(gitroot, ignore_errors=True)
        finally:
            Path(cfgp).unlink(missing_ok=True)
            if "tmp" in locals():
                tmp.unlink(missing_ok=True)
        kinds = {h[0] for h in hits}
        need = {"专属名词(配置)", "本机绝对路径", "内网IP 10.x", "内网域名(配置)", "内网主机名(配置)",
                "明文口令password=", "邮箱地址"}
        ok = need.issubset(kinds)
        git_ok = any(h[0].startswith("git元数据邮箱") for h in git_hits)
        print(f"[SELFTEST] {'PASS' if ok else 'FAIL'} —— 注入7类污染命中{len(kinds & need)}/7类；"
              f"git元数据邮箱 {'命中 ✓' if git_ok else '漏检 ✗'}（{len(git_hits)} 处）")
        sys.exit(0 if (ok and git_ok) else 1)

    if not args.config:
        print("[WARN] 未提供 --config 词表：专属名词/内网域名两类不检查（仅通用规则）")
    words, net = load_rules(args.config)
    target = Path(args.target)
    results = run_scan(target, words, net)
    if args.include_gitmeta:
        git_hits = scan_git_meta(target, net)
        if git_hits:
            results["<.git 元数据>"] = git_hits
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    total = sum(len(v) for v in results.values())
    lines = [f"# 通用层机检报告（{now}）", "",
             f"- 目标：{target}",
             f"- 词表：{'配置' + str(len(words)) + '词+' + str(len(net) - len(NET_RULES)) + '域名模式' if args.config else '无（仅通用规则）'}",
             f"- 结论：{'**红 ' + str(total) + ' 项，禁发**' if results else '**全绿（零专属名词/零绝对路径/零内网/零凭证）**'}", ""]
    for f, hits in results.items():
        lines.append(f"## {f}")
        lines.append("")
        lines.append("| 类型 | 行号 | 命中 |")
        lines.append("|---|---|---|")
        for name, ln, raw in hits:
            lines.append(f"| {name} | {ln} | {raw} |")
        lines.append("")
    report = "\n".join(lines)
    if args.out:
        Path(args.out).write_text(report, encoding="utf-8")
        print(f"[OK] report -> {args.out}")
    print(report if not args.out else "")
    print(f"[SUMMARY] hits={total} files_with_hits={len(results)}")
    sys.exit(1 if results else 0)


if __name__ == "__main__":
    main()
