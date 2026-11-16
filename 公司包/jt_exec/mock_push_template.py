# -*- coding: utf-8 -*-
"""mock_push_template.py — Mock 统一造数推送骨架（公司层 jt_exec，2026-11-16 立）

职责：给各业务域同事一个"统一造数模块"的标准骨架——推送函数/信封/轮询是通用的，
**字段模板表属域层数据（Mock 接口文档的字段随域不同），由各域按自己的 Mock 文档填充**。
用法（域层示例）：
    from mock_push_template import MockPusher          # 或复制本件到你的域执行目录改造
    mp = MockPusher(gw='http://你的mock网关', token_env='MOCK_TOKEN')
    payload = mp.envelope(event_type='ORDER_PROCESS', order_code='TEST_X_0001')
    payload.update(你的域字段表['ORDER_PROCESS'])      # ← 域字段在此填
    mp.push(payload); mp.wait_completed('TEST_X_0001')
铁律（跨域通用教训）：
  ①信封字段名以 Mock 文档为准逐字核对（曾有"信封 orderNumber 实为 orderCode"事故）；
  ②推送后轮询状态到 COMPLETED 再断言计算结果（分钟级延迟正常，勿过早判失败）；
  ③造数数据自清理（删/失效），禁留残留影响下一轮判重；
  ④字段全量赋值再测（文档给的字段都填，缺字段=维度缺失引发误判）。
"""
import json
import os
import time
import urllib.request

DEFAULT_TIMEOUT = 15


class MockPusher:
    def __init__(self, gw, token_env='MOCK_TOKEN', timeout=DEFAULT_TIMEOUT):
        self.gw = gw.rstrip('/')
        self.token = os.environ.get(token_env, '')   # token 一律环境注入，禁写死（G16 同源纪律）
        self.timeout = timeout

    def envelope(self, event_type, order_code, biz_time=None):
        """通用信封骨架——字段名按你的 Mock 文档核对后调整。"""
        return {"eventType": event_type, "orderCode": order_code,
                "bizTime": biz_time or time.strftime('%Y-%m-%d %H:%M:%S')}

    def push(self, payload, path='/mock/api/push'):
        req = urllib.request.Request(
            self.gw + path, data=json.dumps(payload).encode('utf-8'),
            headers={'Content-Type': 'application/json', **({'Authorization': self.token} if self.token else {})})
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            out = json.loads(r.read().decode('utf-8'))
            if not str(out.get('code', out.get('status', '0'))).startswith(('0', '200', 'SUCCESS')):
                raise RuntimeError(f'推送失败: {out}')
            return out

    def wait_completed(self, code, path='/mock/api/status', polls=30, interval=6):
        """轮询至 COMPLETED（分钟级延迟正常）；超时抛错——勿把"慢"误判为"失败"。"""
        for _ in range(polls):
            with urllib.request.urlopen(f'{self.gw}{path}?code={code}', timeout=self.timeout) as r:
                st = json.loads(r.read().decode('utf-8')).get('status', '')
            if st == 'COMPLETED':
                return True
            time.sleep(interval)
        raise TimeoutError(f'{code} {polls * interval}s 未到 COMPLETED（status={st}）——查 Mock 侧消费日志再定性')


# ── 域字段模板表（占位示例；各域按自己的 Mock 接口文档全量填充）──
域字段表 = {
    # 'YOUR_EVENT_TYPE': {"fieldA": "...", "fieldB": 0, ...文档给多少填多少},
}
