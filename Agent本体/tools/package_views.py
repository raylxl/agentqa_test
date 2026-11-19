# -*- coding: utf-8 -*-
"""同事包生成视图：不改工作区正本，只在 ZIP 中重写配置/索引为包内自包含布局。"""
import json, re
from pathlib import Path


def company_config_view(src_bytes):
    cfg=json.loads(src_bytes.decode('utf-8'))
    root='D:/ZCodetest'  # 占位；部署器 migrate_paths 会换到真实根
    p=cfg['paths']
    p.update({
        '需求文档': f'{root}/需求用例库/需求文档',
        '用例文件': f'{root}/需求用例库/用例文件',
        '标准体系': f'{root}/agentqa_test/公司包/标准体系',
        'jt_chrome': f'{root}/agentqa_test/公司包/jt_exec',
        'pipeline_assets': f'{root}/agentqa_test/Agent本体/skills/usecase-pipeline',
        'ai_test': f'{root}/AiTest',
        '手艺包': f'{root}/agentqa_test/手艺包',
        '需求流水线台账': f'{root}/需求流水线台账_v1.md',
        '技能根': f'{root}/agentqa_test/Agent本体/skills',
        'Agent本体': f'{root}/agentqa_test/Agent本体',
        '公司包': f'{root}/agentqa_test/公司包',
        '产品线根': f'{root}/agentqa_test/公司包/产品线',
        '凭证文件': f'{root}/agentqa_test/公司包/agent-secrets.json',
        '执行工具': f'{root}/agentqa_test/公司包/jt_exec',
        '接口执行根': f'{root}/agentqa_test/公司包/jt_exec/pw_layered',
    })
    # 2026-11-19 批次3嵌套化适配：三段物理归 业务线.{当前线}（无当前线段的旧正本回退顶层）
    bl = cfg.get('白名单')
    if bl is None:
        _b = cfg.setdefault('业务线', {})
        bl = _b.setdefault(_b.get('当前线', '财务线'), {}).setdefault('白名单', {})
    bl['归档默认根'] = p['用例文件']
    cfg['分发']['机检词表']=f'{root}/agentqa_test/公司包/company_wordlist.json'
    aliases=cfg.setdefault('路径迁移别名',{})
    # 分发视图不携带发起人用户目录别名；别名键值统一正斜杠，避免 Mac 迁移后混合分隔符。
    cfg['路径迁移别名']={k.replace('\\','/'):v.replace('\\','/') for k,v in aliases.items() if not k.replace('\\','/').lower().startswith('c:/users/')}
    cfg['路径迁移别名']['D:/ZCodetest/jt_chrome']=p['执行工具']
    cfg['路径迁移别名']['D:/ZCodetest/用例设计标准_我的定稿']=p['标准体系']
    return (json.dumps(cfg,ensure_ascii=False,indent=2)+'\n').encode('utf-8')


def standards_index_view(src_bytes):
    s=src_bytes.decode('utf-8')
    names=['云仓账单','存储账单','客户特定结算规则配置','平台价格','配送价格']
    for name in names:
        # 2026-11-19 适配：正本路径已归一（D:/ 前缀+子路径反斜杠混合形态）；第一列已有活正本/仓内副本说明
        s=re.sub(r'`[A-Za-z]:[/\\][^`]*[/\\]'+re.escape(name)+r'_用例编写标准_v1\.md`',
                 f'`L4域标准/{name}_用例编写标准_v1.md`',s)
    return s.encode('utf-8')
