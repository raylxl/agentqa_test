# -*- coding: utf-8 -*-
"""PreToolUse：拦截对组装正本的直接修改。

正本目录、文件命名和例外名单由公司 profile 提供；无 profile 时安全降级为不拦截。
"""
import json
import re
import sys
from pathlib import Path

from _company_profile import config_path, load_company_profile, normalize_path


def _policy():
    profile, _ = load_company_profile()
    base = config_path(profile, "用例文件")
    if base is None:
        return None, None, ()
    policy = (profile.get("hook_policy") or {}).get("master_edit") or {}
    if policy.get("enabled", True) is False:
        return None, None, ()
    pattern = policy.get("case_pattern", r"_测试用例_v\d+\.md$")
    try:
        case_re = re.compile(pattern, re.IGNORECASE)
    except re.error:
        case_re = re.compile(r"_测试用例_v\d+\.md$", re.IGNORECASE)
    whitelist = tuple(x for x in policy.get("whitelist_names", ["全流程场景用例"]) if x)
    return normalize_path(base).rstrip("\\") + "\\", case_re, whitelist


def main():
    try:
        raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        return
    fp = ((data.get("tool_input") or {}).get("file_path") or "").replace("/", "\\")
    if not fp:
        return
    base, case_re, whitelist = _policy()
    if not base or not case_re:
        return
    if not fp.lower().startswith(base.lower()):
        return
    rest = fp[len(base):]
    # 仅拦根目录下的正本；分章源、报告、证书等子目录文件不拦。
    if "\\" in rest or not case_re.search(rest):
        return
    if any(name in rest for name in whitelist):
        return
    reason = ("[组装正本保护] 禁止直接编辑用例正本：%s\n"
              "请改对应分章源文件，再运行已配置的组装脚本重出正本并执行回写校验。\n"
              "正本是组装产物，直接修改会被下一次组装覆盖。" % rest)
    try:
        sys.stdout.buffer.write(json.dumps({"decision": "deny", "reason": reason}, ensure_ascii=False).encode("utf-8"))
    except Exception:
        pass
    raise SystemExit(2)


if __name__ == "__main__":
    main()
