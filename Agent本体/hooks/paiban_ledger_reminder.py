# -*- coding: utf-8 -*-
"""PostToolUse：写测试报告时提醒拍板与回写对账。"""
import json
import re
import sys

from _company_profile import load_company_profile


def main():
    try:
        raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        return
    fp = ((data.get("tool_input") or {}).get("file_path") or "").replace("/", "\\")
    profile, _ = load_company_profile()
    policy = (profile.get("hook_policy") or {}).get("report_reminder") or {}
    if policy.get("enabled", True) is False:
        return
    pattern = policy.get("report_pattern", r"_测试报告_v\d+\.md$")
    try:
        matched = re.search(pattern, fp, re.IGNORECASE) is not None
    except re.error:
        matched = re.search(r"_测试报告_v\d+\.md$", fp, re.IGNORECASE) is not None
    if not fp or not matched:
        return
    lines = [
        "⚠[拍板对账] 正在写测试报告——收笔前必须完成拍板与回写对账：",
        "1. 本轮新增拍板必须与回写 pending 台账逐条对应；",
        "2. 回写落地必须经过分章→组装→锚点校验，不能只依据报告处置列自述；",
        "3. 跨需求/跨册事项按公司 profile 的流水线台账规则同步登记。",
    ]
    sys.stdout.buffer.write(json.dumps({"additionalContext": "\n".join(lines)}, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    main()
