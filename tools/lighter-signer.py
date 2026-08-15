#!/usr/bin/env python3
"""
Persistent Lighter signer worker · JSON RPC over stdin/stdout.

Node 侧 spawn 这个进程后按行发 JSON 请求，每收到一行就 print 一行 JSON 响应。
不用 HTTP 桥就是为了少一层 socket / auth，进程内单实例复用 SignerClient（.so
只 dlopen 一次，nonce_manager 也只跑一份）。

请求格式：
  { "cmd": "ping" }                                → { "ok": true }
  { "cmd": "init",  "params": {...} }              → { "ok": true, "check_error": null }
  { "cmd": "create_order", "params": {...} }       → { "ok": true, "tx_hash": "0x...", "code": 200, ... }
  { "cmd": "cancel_order", "params": {...} }       → 同上
  { "cmd": "cancel_all_orders", "params": {...} }  → 同上

所有异常 / 签名器 err 都以 { "err": "<msg>" } 返回（不 raise，防止 kill 掉 worker）。

init 的 params：
  api_key_private_key : Lighter API key 私钥 hex（40 字符，非 EVM/ed25519）
  account_index       : 你在 Lighter 上的账户 index（正整数）
  api_key_index       : 该账户下 API key 的 slot（0..N，默认 0）
  api_url             : REST 基址（默认 mainnet zklighter.elliot.ai）
  chain_id            : 可选，默认按 url 自动推

create_order 的 params 全是 Lighter SDK 已 scale 好的 int（Node 端负责按
market 的 price/size decimals 提前 scale）：
  market_index, client_order_index, base_amount, price, is_ask,
  order_type, time_in_force, reduce_only, trigger_price, order_expiry

cancel_order params：market_index, order_index
cancel_all_orders params：time_in_force, timestamp_ms, cancel_all_market_index
"""
import sys
import json
import asyncio
import traceback

try:
    import lighter
except ImportError as e:
    sys.stderr.write(f"[lighter-signer] lighter-sdk 未安装：{e}\n")
    sys.stderr.write("  Dockerfile 里请加 pip3 install --break-system-packages lighter-sdk\n")
    sys.stderr.flush()
    sys.exit(1)


_client = None       # lighter.SignerClient 单例
_loop = None         # asyncio event loop (跨请求复用)


async def _handle(msg):
    global _client
    cmd = msg.get('cmd')
    params = msg.get('params') or {}

    if cmd == 'ping':
        return {'ok': True, 'has_client': _client is not None}

    if cmd == 'init':
        api_url = (params.get('api_url') or 'https://mainnet.zklighter.elliot.ai').rstrip('/')
        account_index = int(params['account_index'])
        api_key_index = int(params.get('api_key_index', 0))
        private_key = str(params['api_key_private_key'])
        chain_id = params.get('chain_id')
        # 已存在时先关旧的（重复 init 兜底）
        if _client is not None:
            try:
                await _client.close()
            except Exception:
                pass
        _client = lighter.SignerClient(
            url=api_url,
            account_index=account_index,
            api_private_keys={api_key_index: private_key},
            chain_id=int(chain_id) if chain_id is not None else None,
        )
        # check_client 校验 api key 是否真的挂在这个 account 上
        check_err = None
        try:
            check_err = _client.check_client()
        except Exception as e:
            check_err = f"check_client_exception: {e}"
        return {
            'ok': True,
            'check_error': check_err,          # 非 None 一般意味着 key / account / api_key_index 不匹配
            'chain_id': _client.chain_id,
        }

    if _client is None:
        return {'err': 'not_initialized'}

    if cmd == 'create_order':
        tx, api_resp, err = await _client.create_order(
            market_index=int(params['market_index']),
            client_order_index=int(params['client_order_index']),
            base_amount=int(params['base_amount']),
            price=int(params['price']),
            is_ask=bool(params['is_ask']),
            order_type=int(params.get('order_type', lighter.SignerClient.ORDER_TYPE_LIMIT)),
            time_in_force=int(params.get('time_in_force', lighter.SignerClient.ORDER_TIME_IN_FORCE_GOOD_TILL_TIME)),
            reduce_only=bool(params.get('reduce_only', False)),
            trigger_price=int(params.get('trigger_price', 0)),
            order_expiry=int(params.get('order_expiry', lighter.SignerClient.DEFAULT_28_DAY_ORDER_EXPIRY)),
        )
        return _format_send_resp(api_resp, err)

    if cmd == 'cancel_order':
        tx, api_resp, err = await _client.cancel_order(
            market_index=int(params['market_index']),
            order_index=int(params['order_index']),
        )
        return _format_send_resp(api_resp, err)

    if cmd == 'cancel_all_orders':
        tx, api_resp, err = await _client.cancel_all_orders(
            time_in_force=int(params.get('time_in_force', lighter.SignerClient.CANCEL_ALL_TIF_IMMEDIATE)),
            timestamp_ms=int(params.get('timestamp_ms', 0)),
            cancel_all_market_index=int(params.get('cancel_all_market_index', lighter.SignerClient.NIL_MARKET_INDEX)),
        )
        return _format_send_resp(api_resp, err)

    return {'err': f'unknown_cmd: {cmd}'}


def _format_send_resp(api_resp, err):
    if err:
        return {'err': str(err)}
    if api_resp is None:
        return {'ok': True, 'tx_hash': None, 'code': None, 'message': None}
    return {
        'ok': True,
        'tx_hash': getattr(api_resp, 'tx_hash', None),
        'code': getattr(api_resp, 'code', None),
        'message': getattr(api_resp, 'message', None),
        'predicted_execution_time_ms': getattr(api_resp, 'predicted_execution_time_ms', None),
    }


def main():
    global _loop
    _loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_loop)

    # Line-oriented sync stdin loop (串行；node 侧也串行发)
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception as e:
            print(json.dumps({'err': f'json_parse: {e}'}), flush=True)
            continue
        try:
            result = _loop.run_until_complete(_handle(msg))
        except Exception as e:
            result = {
                'err': str(e),
                'trace': traceback.format_exc()[:800],
            }
        try:
            print(json.dumps(result, default=str), flush=True)
        except Exception as e:
            print(json.dumps({'err': f'json_dump: {e}'}), flush=True)

    # EOF · 优雅关闭
    if _client is not None:
        try:
            _loop.run_until_complete(_client.close())
        except Exception:
            pass


if __name__ == '__main__':
    main()
