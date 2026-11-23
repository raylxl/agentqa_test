# -*- coding: utf-8 -*-
"""PostToolUse：写入正本/配置后提醒重读或重启。

匹配口径（2026-11-14 自检修复）：
- 物理规则先对 file_path 做 realpath 归一——经运行位联接（如 .zcode\\skills）写入也能命中物理正本规则；
- 三包根（agentqa_test）由 paths.Agent本体 上溯推导，三包内任意文件改动均提醒（含手艺包）；
- 用户级 CLI/MCP 配置为重启级配置，按原路径精确匹配（不归一，避免联接解析到 D 盘后丢失"重启"语义）。
"""
import json
import os
import re
import sys
from pathlib import Path

from _company_profile import load_company_profile, normalize_path, prefix_regex


def _zcode_home():
    return Path(os.environ.get("ZCODE_HOME") or (Path.home() / ".zcode")).expanduser()


def _path_rules(profile):
    paths = profile.get("paths") or {}
    rules = []

    def add(prefix_value, kind, label, exact=False):
        if isinstance(prefix_value, str) and prefix_value:
            if exact:
                rx = r"^" + re.escape(normalize_path(prefix_value)) + r"$"
            else:
                rx = prefix_regex(prefix_value)
            rules.append((re.compile(rx, re.I), kind, label))

    for key, label in (("标准体系", "标准正本"), ("技能根", "技能"), ("Agent本体", "Agent本体"), ("公司包", "公司包")):
        add(paths.get(key), "std", label)
    # 台账=单文件：精确匹配本体；常见衍生（备份/临时）不提醒
    add(paths.get("需求流水线台账"), "std", "流水线台账", exact=True)
    # 三包根兜底：Agent本体 物理位的上级=agentqa_test（含手艺包）
    agent_root = paths.get("Agent本体")
    if isinstance(agent_root, str) and agent_root:
        add(str(Path(agent_root).parent), "std", "agent三包")

    # 用户级 CLI 配置是会话运行配置；改动后需重开会话（按原路径匹配，不 realpath）。
    user_zcode = _zcode_home()
    rules.extend([
        (re.compile(r"^" + re.escape(normalize_path(user_zcode / "cli" / "config.json")) + r"$", re.I), "cfg", "客户端主配置"),
        (re.compile(r"^" + re.escape(normalize_path(user_zcode / "mcp.json")) + r"$", re.I), "cfg", "MCP配置"),
    ])
    return rules


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8", errors="replace"))
    except Exception:
        return
    fp = ((data.get("tool_input") or {}).get("file_path") or "").replace("/", "\\")
    if not fp:
        return
    # 重启级配置按原路径判定；物理正本规则按 realpath（联接→物理位）判定
    zcode_home = _zcode_home()
    cfg_hit = fp.lower() == normalize_path(zcode_home / "cli" / "config.json").lower() \
        or fp.lower() == normalize_path(zcode_home / "mcp.json").lower()
    if cfg_hit:
        msg = f"⚠[硬规则8] 会话级配置已修改：{fp} —— 需重开会话生效，收尾输出须含此⚠行。"
        sys.stdout.buffer.write(json.dumps({"additionalContext": msg}, ensure_ascii=False).encode("utf-8"))
        return
    real = fp
    try:
        real = os.path.realpath(fp)
    except OSError:
        pass
    profile, _ = load_company_profile()
    for rx, kind, label in _path_rules(profile):
        if rx.search(real) or rx.search(fp):
            msg = f"⚠[硬规则7] {label}已修改：{fp} —— 后续引用一律现读磁盘，禁凭本会话早前读入当依据。"
            sys.stdout.buffer.write(json.dumps({"additionalContext": msg}, ensure_ascii=False).encode("utf-8"))
            return
    # 域标准尾缀（L4，分散在需求文档目录，路径不定，按文件名尾缀识别）
    if re.search(r"用例编写标准_v\d+\.md$", fp, re.I):
        msg = f"⚠[硬规则7] 域标准已修改：{fp} —— 后续引用一律现读磁盘，禁凭本会话早前读入当依据。"
        sys.stdout.buffer.write(json.dumps({"additionalContext": msg}, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    main()
