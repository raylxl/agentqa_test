# -*- coding: utf-8 -*-
"""最终 ZIP 写后门禁：同事包安全/完整性审计。红一项返回 1，打包器删除产物。"""
import hashlib, io, json, re, sys, zipfile
from pathlib import Path

TEXT_EXT = {'.py','.js','.cjs','.json','.md','.txt','.ps1','.sh','.bat','.command','.toml','.yaml','.yml'}
FORBIDDEN_SUFFIX = {'.png','.jpg','.jpeg','.xlsx','.xlsm','.jsonl','.out','.log'}
FORBIDDEN_PARTS = {'.git','_git归档','locks','run-results','shots','ego_shots','netlog','apicap','.headless_profile','.headless_r7'}
SECRET_PATTERNS = [
    ('api-key', re.compile(r'sk-[A-Za-z0-9]{16,}')),
    ('pem-private-key', re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')),
    ('hard-token', re.compile(r'(?i)(?:token|session(?:id)?)["\']?\s*[:=]\s*["\'][A-Za-z0-9._-]{24,}["\']')),
    ('hard-password', re.compile(r'(?i)(?:password|passwd|pwd|pass)["\']?\s*[:=]\s*["\'][^"\'${}\s]{6,}["\']')),
]
PHONE = re.compile(r'(?<!\d)1[3-9]\d{9}(?!\d)')
EMAIL = re.compile(r'(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b')


def flatten_secrets(path):
    """只提取真正敏感字段：账号、密码、主机。显示名/库名/note 不当作秘密真值。"""
    vals=[]
    if not path or not Path(path).exists(): return vals
    data=json.loads(Path(path).read_text(encoding='utf-8'))
    sensitive_keys={'user','pass','password','host','token','session','sessionid'}
    def walk(x,key=''):
        if isinstance(x,dict):
            for k,v in x.items():
                if not k.startswith('_'): walk(v,k.lower())
        elif isinstance(x,list):
            for v in x: walk(v,key)
        elif isinstance(x,str) and key in sensitive_keys and len(x)>=4: vals.append(x)
    walk(data)
    return sorted(set(vals), key=len, reverse=True)


def audit(zip_path, source_secrets=None):
    red=[]; entries=[]
    true_values=flatten_secrets(source_secrets)
    with zipfile.ZipFile(zip_path) as z:
        bad=z.testzip()
        if bad: red.append(f'CRC损坏:{bad}')
        names=z.namelist()
        if len(names)!=len(set(names)): red.append('重复路径')
        for info in z.infolist():
            n=info.filename; p=Path(n)
            if any(x in FORBIDDEN_PARTS or x.startswith(('evid_','_rg')) or re.fullmatch(r'_(?:r|t)\d+', x) for x in p.parts):
                red.append(f'运行/归档目录:{n}')
            if p.suffix.lower() in FORBIDDEN_SUFFIX:
                red.append(f'运行/数据文件:{n}')
            b=z.read(n)
            if n!='MANIFEST.json':
                entries.append({'path':n,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
            if p.suffix.lower() not in TEXT_EXT: continue
            try:s=b.decode('utf-8')
            except UnicodeDecodeError:
                try:s=b.decode('gbk')
                except UnicodeDecodeError: continue
            if n.endswith('agent-secrets.json'):
                try:
                    d=json.loads(s)
                    def nonempty(x):
                        if isinstance(x,dict): return any(nonempty(v) for k,v in x.items() if not k.startswith('_'))
                        if isinstance(x,list): return any(nonempty(v) for v in x)
                        return isinstance(x,str) and bool(x.strip())
                    if nonempty(d): red.append('凭证骨架非空:agent-secrets.json')
                except Exception: red.append('凭证骨架JSON无效')
                continue
            for v in true_values:
                if v in s: red.append(f'真实凭证值重复:{n}'); break
            for label,pat in SECRET_PATTERNS:
                if pat.search(s):
                    # 通用接入方法只允许 your-* 占位符，不允许真实值；命中占位不报红。
                    if n.endswith('07_公司层接入方法_凭证与数据库.md') and 'your-password' in s:
                        continue
                    red.append(f'{label}:{n}')
            # 电话/邮箱仅在公司包运行件和JSON数据里判红；标准/说明里的示例可通过专用白名单避免误判。
            if (n.startswith('agentqa_test/公司包/') and p.suffix.lower() in {'.json','.js','.py','.txt'}) and PHONE.search(s):
                red.append(f'手机号形态:{n}')
            if n.startswith('agentqa_test/_git归档/') and EMAIL.search(s): red.append(f'Git个人邮箱:{n}')
    entries=sorted(entries,key=lambda x:x['path'])
    return sorted(set(red)), entries

if __name__=='__main__':
    zp=sys.argv[1]; sec=sys.argv[2] if len(sys.argv)>2 else None
    red,entries=audit(zp,sec)
    print(json.dumps({'red':red,'files':len(entries)},ensure_ascii=False,indent=2))
    raise SystemExit(1 if red else 0)
