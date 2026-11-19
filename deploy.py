# -*- coding: utf-8 -*-
"""仓根 ASCII 跳板：bat/cmd 任何代码页下传中文路径都会错位（2026-11-19 实证
"Agent本体\\tools" 变乱码 Invalid argument）——bat 只调本件（全 ASCII），中文路径
解析留在 python 内部（字符层面无编码问题）。等价：deploy_colleague.py。
"""
import pathlib
import runpy
import sys

HERE = pathlib.Path(__file__).resolve().parent
TARGET = HERE / "Agent本体" / "tools" / "deploy_colleague.py"
if not TARGET.is_file():
    sys.exit("[RED] deploy.py jump target missing: Agent本体/tools/deploy_colleague.py")
runpy.run_path(str(TARGET), run_name="__main__")
