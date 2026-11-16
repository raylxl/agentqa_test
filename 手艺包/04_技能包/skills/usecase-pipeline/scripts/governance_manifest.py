# -*- coding: utf-8 -*-
"""治理清单校验器（测试策略与风险治理标准 v1.1）

治理 JSON 是需求级计划/基线正本；策略卡、BRIEF、Excel、证书和报告都是派生视图。
执行账本不写入此文件，执行事实仍由账本和 Execution ID 承载。

最小用法：
  python governance_manifest.py --manifest <治理.json> --md <成册.md>
  python governance_manifest.py --manifest <治理.json> --md <成册.md> --historical-exempt

返回码：0=通过；1=清单/TC/风险映射违规；2=输入文件或 JSON 结构错误。
"""
import argparse
import io
import json
import os
import re
import sys
from collections import Counter

PRIORITIES = frozenset({"P0", "P1", "P2", "P3"})
PRIORITY_RANK = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}
def _find_company_cfg():
    """公司配置定位（2026-11-14 目录化重构·改名免疫）：环境变量 AGENT_COMPANY_JSON →
    技能根上级的 agent-company.json（旧部署位）→ 同级各目录内同名文件（同级配置目录，改名不影响）。"""
    env = os.environ.get("AGENT_COMPANY_JSON")
    if env and os.path.isfile(env):
        return env
    base = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "..")
    cand = os.path.join(base, "agent-company.json")
    if os.path.isfile(cand):
        return cand
    parent = os.path.join(base, "..")
    try:
        for name in sorted(os.listdir(parent)):
            c = os.path.join(parent, name, "agent-company.json")
            if os.path.isfile(c):
                return c
    except OSError:
        pass
    return cand


def _load_company_whitelists():
    """公司白名单外置（2026-11-13 参数化）：agent-company.json（workspace .zcode/ 或环境变量定位）的「白名单.历史豁免需求ID」。
    缺文件=空集（新部署无历史豁免）。等价性由部署侧快照校验守护。"""
    cfgp = _find_company_cfg()
    ids = []
    try:
        with io.open(cfgp, "r", encoding="utf-8") as f:
            ids = json.load(f).get("白名单", {}).get("历史豁免需求ID", [])
    except (OSError, ValueError):
        pass
    return frozenset(ids)

HISTORICAL_ALLOWLIST = _load_company_whitelists()
TC_TITLE_RE = re.compile(r"^####\s+(TC[-_][A-Za-z0-9][A-Za-z0-9_-]*?)(?:\s+|｜|\|)")
TC_PRIO_RE = re.compile(r"（(P[0-3])）")
ROW7_RE = re.compile(r"^\|\s*(TC[-_][A-Za-z0-9][A-Za-z0-9_-]*?)\s*\|.*?\|\s*(P[0-3])\s*\|")


def fail(msg):
    print("[治理清单][FAIL] " + msg)


def load_json(path):
    def no_duplicate_keys(pairs):
        obj = {}
        for key, value in pairs:
            if key in obj:
                raise ValueError('重复 JSON key: %s' % key)
            obj[key] = value
        return obj
    try:
        with io.open(path, encoding="utf-8-sig") as f:
            return json.load(f, object_pairs_hook=no_duplicate_keys)
    except FileNotFoundError:
        print("[治理清单][ERROR] 文件不存在: %s" % path, file=sys.stderr)
        sys.exit(2)
    except (json.JSONDecodeError, ValueError) as e:
        print("[治理清单][ERROR] JSON 无法解析: %s (%s)" % (path, e), file=sys.stderr)
        sys.exit(2)


def load_tc_index(md_path):
    if not md_path:
        return {}, []
    try:
        text = io.open(md_path, encoding="utf-8-sig").read()
    except FileNotFoundError:
        print("[治理清单][ERROR] MD 不存在: %s" % md_path, file=sys.stderr)
        sys.exit(2)
    index = {}
    duplicates = []
    for line_no, line in enumerate(text.splitlines(), 1):
        m = TC_TITLE_RE.match(line)
        if m:
            tc = m.group(1)
            pm = TC_PRIO_RE.search(line)
            prio = pm.group(1) if pm else None
            if tc in index:
                duplicates.append((tc, index[tc]["line"], line_no))
            index[tc] = {"priority": prio, "line": line_no, "source": line}
            continue
        m = ROW7_RE.match(line)
        if m:
            tc, prio = m.group(1), m.group(2)
            if tc in index:
                duplicates.append((tc, index[tc]["line"], line_no))
            index[tc] = {"priority": prio, "line": line_no, "source": line}
    return index, duplicates


def as_list(value):
    return value if isinstance(value, list) else []


def validate(manifest, md_path=None, historical_exempt=False):
    errors = []
    warnings = []
    if not isinstance(manifest, dict):
        return ["根节点必须是 JSON 对象"], []
    if manifest.get("schema_version") != "1.0":
        errors.append("schema_version 必须为 \"1.0\"")
    req = manifest.get("requirement")
    if not isinstance(req, dict):
        errors.append("缺少 requirement 对象")
        req = {}
    for key in ("id", "name", "version", "intake_tier"):
        if not req.get(key):
            errors.append("requirement.%s 缺失" % key)
    if req.get("intake_tier") not in ("light", "standard", "full"):
        errors.append("requirement.intake_tier 必须是 light/standard/full")

    phase = manifest.get("phase", "planning")
    phases = ("planning", "qa", "design", "verification", "execution", "closed")
    if phase not in phases:
        errors.append("phase 必须是 planning/qa/design/verification/execution/closed")
    policy = manifest.get("policy") or {}
    if not isinstance(policy, dict):
        errors.append("policy 必须是对象")
        policy = {}

    # 豁免只能由受信调用者显式授权；manifest 自声明不得授权。
    if policy.get("historical_exempt"):
        errors.append("manifest 不得自授 historical_exempt；豁免只能由受信 allowlist/调用参数提供")
    if historical_exempt and req.get("id") not in HISTORICAL_ALLOWLIST:
        errors.append("需求 %s 不在存量历史册豁免 allowlist" % (req.get("id") or "<missing>"))
        historical_exempt = False

    spectrum = manifest.get("full_spectrum") or {}
    if phase in ("planning", "qa") and not historical_exempt:
        if not isinstance(spectrum, dict) or not spectrum:
            errors.append("planning/qa 阶段必须记录 full_spectrum 各维度测/不测理由")
        else:
            for dim in ("functional", "ui", "performance", "security", "compatibility", "reliability", "accessibility", "observability"):
                item = spectrum.get(dim)
                if not isinstance(item, dict) or item.get("decision") not in ("test", "not_test", "pending_qa") or not item.get("reason"):
                    errors.append("full_spectrum.%s 必须含合法 decision 与 reason" % dim)

    risks = manifest.get("risks")
    if not isinstance(risks, list) or not risks:
        if historical_exempt or phase in ("planning", "qa"):
            warnings.append("当前阶段尚未形成风险落位清单；design 阶段必须补齐")
            risks = []
        else:
            errors.append("risks 必须是非空数组")
            risks = []

    tc_index, duplicate_tcs = load_tc_index(md_path) if md_path else ({}, [])
    if duplicate_tcs and not historical_exempt:
        errors.append("MD 存在全局 TC 重号: %s" % ", ".join("%s(%s/%s)" % x for x in duplicate_tcs[:8]))
    elif duplicate_tcs:
        warnings.append("历史豁免 MD 存在全局 TC 重号: %s" % ", ".join(x[0] for x in duplicate_tcs[:8]))

    mapped_tcs = set()
    forward_pairs = set()
    risk_ids = set()
    for i, risk in enumerate(risks, 1):
        if not isinstance(risk, dict):
            errors.append("risks[%d] 必须是对象" % i)
            continue
        rid = risk.get("risk_id")
        if not rid:
            errors.append("risks[%d].risk_id 缺失" % i)
            continue
        if rid in risk_ids:
            errors.append("risk_id 重复: %s" % rid)
        risk_ids.add(rid)
        level = str(risk.get("level", "")).lower()
        minimum = risk.get("minimum_priority") or risk.get("case_priority")
        if level not in ("critical", "high", "medium", "low"):
            errors.append("%s.level 必须是 critical/high/medium/low" % rid)
        if minimum not in PRIORITIES:
            errors.append("%s.minimum_priority 必须是 P0/P1/P2/P3" % rid)
        if level in ("critical", "high") and minimum in ("P2", "P3"):
            errors.append("高风险不得映射到 %s: %s" % (minimum, rid))

        # Design 及之后强制风险治理字段完整；unknown/TBD 值允许显式标注待确认，但不得省字段。
        if phase in ("design", "verification", "execution", "closed") and not historical_exempt:
            required = ("description", "level", "risk_owner", "impact", "likelihood", "exposure",
                        "minimum_priority", "test_depth", "nfr_dimensions", "execution_set")
            for key in required:
                if key not in risk or risk.get(key) is None or risk.get(key) == "":
                    errors.append("%s.%s 缺失" % (rid, key))
            for key in ("impact", "likelihood", "exposure"):
                value = risk.get(key)
                if value is not None and str(value).upper() not in ("TBD", "UNKNOWN"):
                    try:
                        if float(value) <= 0:
                            errors.append("%s.%s 必须为正数、TBD 或 UNKNOWN" % (rid, key))
                    except (TypeError, ValueError):
                        errors.append("%s.%s 必须为数值、TBD 或 UNKNOWN" % (rid, key))
            if "residual_risk" not in risk:
                errors.append("%s.residual_risk 缺失（无残余风险请明确写 None）" % rid)
            if "risk_acceptor" not in risk:
                errors.append("%s.risk_acceptor 缺失（无须接受请明确写 None）" % rid)

        tc_ids = as_list(risk.get("tc_ids"))
        disposition = risk.get("disposition") or {}
        observation = risk.get("observation") or {}
        has_observation = isinstance(observation, dict) and bool(observation.get("metric")) and bool(observation.get("owner"))
        has_approved_exclusion = isinstance(disposition, dict) and bool(disposition.get("approved_not_tested")) and bool(disposition.get("approved_by"))
        if not tc_ids and not has_approved_exclusion and not has_observation:
            if phase in ("planning", "qa"):
                warnings.append("%s 尚未形成 tc_ids（当前阶段=%s，进入 design 阶段必须补齐）" % (rid, phase))
            else:
                errors.append("%s 必须有 tc_ids、带metric+owner的观察项，或approved_not_tested+approved_by" % rid)
        for tc in tc_ids:
            if not isinstance(tc, str) or not tc:
                errors.append("%s 含空/非法 tc_id" % rid)
                continue
            mapped_tcs.add(tc)
            forward_pairs.add((tc, rid))
            if md_path and tc not in tc_index:
                errors.append("%s 引用了不存在的 TC: %s" % (rid, tc))
            elif md_path:
                actual = tc_index[tc].get("priority")
                if actual not in PRIORITIES:
                    errors.append("%s 的 TC %s 缺失/非法优先级" % (rid, tc))
                elif PRIORITY_RANK[actual] > PRIORITY_RANK.get(minimum, 99):
                    errors.append("风险 %s 要求最低 %s，但 TC %s 实际为 %s" % (rid, minimum, tc, actual))

    tc_map = manifest.get("tc_risk_map") or {}
    if not isinstance(tc_map, dict):
        errors.append("tc_risk_map 必须是对象")
        tc_map = {}
    reverse_pairs = set()
    for tc, ids in tc_map.items():
        if md_path and tc not in tc_index:
            errors.append("tc_risk_map 引用了不存在的 TC: %s" % tc)
        for rid in as_list(ids):
            if rid not in risk_ids:
                errors.append("tc_risk_map 的 %s 引用了不存在的 risk_id: %s" % (tc, rid))
            reverse_pairs.add((tc, rid))
    if phase in ("design", "verification", "execution", "closed") and not historical_exempt:
        if forward_pairs != reverse_pairs:
            missing_reverse = sorted(forward_pairs - reverse_pairs)
            missing_forward = sorted(reverse_pairs - forward_pairs)
            if missing_reverse:
                errors.append("tc_risk_map 缺少反向映射: %s" % missing_reverse[:12])
            if missing_forward:
                errors.append("tc_risk_map 存在无对应 risks[].tc_ids 的映射: %s" % missing_forward[:12])

    if phase in ("design", "verification", "execution", "closed") and not historical_exempt and md_path:
        if not tc_index:
            errors.append("未解析到任何 TC，无法做风险映射硬门")
        orphan = [tc for tc in tc_index if tc not in mapped_tcs and policy.get("require_all_tc_risk", True)]
        if orphan:
            errors.append("存在未关联风险的 TC: %s" % ", ".join(orphan[:12]))

    if phase in ("design", "verification", "execution", "closed") and not historical_exempt:
        readiness = manifest.get("readiness")
        allowed_readiness = ("awaiting_environment", "ready", "blocked")
        if phase in ("design", "verification"):
            if not isinstance(readiness, dict) or readiness.get("status") not in allowed_readiness:
                errors.append("%s 阶段必须有 readiness.status=awaiting_environment/ready/blocked" % phase)
        elif not isinstance(readiness, dict) or readiness.get("status") != "ready":
            errors.append("%s 阶段 readiness.status 必须为 ready" % phase)

        execution_sets = manifest.get("execution_sets")
        if not isinstance(execution_sets, dict) or not execution_sets:
            errors.append("%s 阶段必须定义 execution_sets 对象" % phase)
            execution_sets = {}
        normalized_sets = {}
        for set_name, set_value in execution_sets.items():
            if not isinstance(set_name, str) or not set_name.strip():
                errors.append("execution_sets 含空执行集名称")
                continue
            if isinstance(set_value, list):
                set_value = {"tc_ids": set_value}
            if not isinstance(set_value, dict):
                errors.append("execution_sets.%s 必须是对象，包含 tc_ids 或 priorities" % set_name)
                continue
            ids = set_value.get("tc_ids")
            priorities = set_value.get("priorities")
            if ids is None and priorities is None:
                errors.append("execution_sets.%s 缺 tc_ids/priorities" % set_name)
            if ids is not None:
                if not isinstance(ids, list) or any(not isinstance(tc, str) or not tc for tc in ids):
                    errors.append("execution_sets.%s.tc_ids 必须是非空 TC 字符串数组" % set_name)
                elif len(ids) != len(set(ids)):
                    errors.append("execution_sets.%s.tc_ids 存在重复 TC" % set_name)
                elif md_path:
                    for tc in ids:
                        if tc not in tc_index:
                            errors.append("execution_sets.%s 引用了不存在的 TC: %s" % (set_name, tc))
            if priorities is not None and (not isinstance(priorities, list) or not priorities or any(p not in PRIORITIES for p in priorities)):
                errors.append("execution_sets.%s.priorities 必须是非空 P0/P1/P2/P3 数组" % set_name)
            normalized_sets[set_name] = set_value

        for risk in risks:
            if not isinstance(risk, dict):
                continue
            risk_sets = risk.get("execution_set")
            if isinstance(risk_sets, str):
                risk_sets = [risk_sets]
            if not isinstance(risk_sets, list) or not risk_sets:
                errors.append("%s.execution_set 必须是非空执行集名称数组" % (risk.get("risk_id") or "<risk>"))
                continue
            for set_name in risk_sets:
                if set_name not in normalized_sets:
                    errors.append("%s.execution_set 引用了未定义执行集: %s" % (risk.get("risk_id") or "<risk>", set_name))

        plan = manifest.get("execution_plan")
        if not isinstance(plan, dict):
            errors.append("%s 阶段必须提供 execution_plan 对象" % phase)
            plan = {}
        selected = plan.get("selected_set")
        if not selected or selected not in normalized_sets:
            errors.append("%s 阶段 execution_plan.selected_set 必须引用已定义执行集" % phase)
        else:
            selected_def = normalized_sets[selected]
            expected_ids = set(selected_def.get("tc_ids", []))
            if selected_def.get("priorities"):
                if not tc_index:
                    errors.append("按优先级定义执行集时必须提供候选 MD")
                else:
                    expected_ids.update(tc for tc, item in tc_index.items() if item.get("priority") in selected_def["priorities"])
            planned = plan.get("planned_tc_ids")
            if not isinstance(planned, list) or any(not isinstance(tc, str) or not tc for tc in planned):
                errors.append("execution_plan.planned_tc_ids 必须是 TC 字符串数组")
                planned_ids = set()
            else:
                planned_ids = set(planned)
                if len(planned_ids) != len(planned):
                    errors.append("execution_plan.planned_tc_ids 存在重复 TC")
            if expected_ids != planned_ids:
                errors.append("execution_plan.planned_tc_ids 与执行集定义不一致：缺=%s；多=%s" % (sorted(expected_ids-planned_ids)[:12], sorted(planned_ids-expected_ids)[:12]))
            if phase == "execution":
                dispatched = plan.get("dispatched_tc_ids")
                if not isinstance(dispatched, list) or any(not isinstance(tc, str) or not tc for tc in dispatched):
                    errors.append("execution 阶段 execution_plan.dispatched_tc_ids 必须是 TC 字符串数组")
                    actual_ids = set()
                else:
                    actual_ids = set(dispatched)
                    if len(actual_ids) != len(dispatched):
                        errors.append("execution_plan.dispatched_tc_ids 存在重复 TC")
                if expected_ids != actual_ids:
                    errors.append("实际 dispatch TC 与执行集不一致：计划缺=%s；多出=%s" % (sorted(expected_ids-actual_ids)[:12], sorted(actual_ids-expected_ids)[:12]))

        if phase == "execution":
            trace = manifest.get("traceability") or {}
            if not isinstance(trace, dict) or not trace.get("execution_id") or trace.get("execution_id") == "未执行":
                errors.append("execution 阶段 traceability.execution_id 必须引用实际执行批次")
            if not isinstance(trace, dict) or not trace.get("ledger_ref") or not trace.get("report_ref"):
                errors.append("execution 阶段必须提供 traceability.ledger_ref 与 report_ref")
        if phase == "closed":
            closure = manifest.get("closure")
            if not isinstance(closure, dict):
                errors.append("closed 阶段必须提供 closure 对象")
            else:
                for key in ("closed_by", "closed_at", "risk_disposition"):
                    if not closure.get(key):
                        errors.append("closure.%s 缺失" % key)
                if not isinstance(closure.get("risk_disposition"), dict):
                    errors.append("closure.risk_disposition 必须按 risk_id 提供最终处置")
                else:
                    for rid in risk_ids:
                        if rid not in closure["risk_disposition"]:
                            errors.append("closure.risk_disposition 缺少风险 %s" % rid)

    if historical_exempt:
        warnings.append("历史三层豁免：不要求 P0123/risk_id 全量映射")
    return errors, warnings


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--md")
    ap.add_argument("--historical-exempt", action="store_true")
    args = ap.parse_args()
    data = load_json(args.manifest)
    errors, warnings = validate(data, args.md, args.historical_exempt)
    print("=== 治理清单校验 ===")
    print("清单=%s" % args.manifest)
    if args.md:
        print("成册=%s" % args.md)
    for w in warnings:
        print("[WARN] " + w)
    for e in errors:
        fail(e)
    if errors:
        print("===> 失败：%d 项" % len(errors))
        return 1
    print("===> 通过（风险=%d）" % len(data.get("risks", [])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
