// LighterSignerBridge — spawn 一个常驻的 Python 子进程跑 tools/lighter-signer.py，
// 用行式 JSON RPC over stdin/stdout 代理 Lighter 官方 SDK 的签名调用。
//
// 为什么走 subprocess 桥而不是纯 JS：Lighter 的签名算法是 Poseidon-hash + BN254
// zk-friendly 方案，只在他家用 Go 编译的 lighter-signer-*.so 里实现，纯 JS 没法
// 等价复刻。ffi-napi 直接吃 .so 也可以，但 Python SDK 已经把 ctypes 包装 + nonce
// 管理 + tx 提交 pipeline 全做完了，比重写 FFI 参数打包稳。
//
// 生命周期：
//   · lazy start — 第一次 request() 时才 spawn，避免 paper 模式空拉起 Python。
//   · 进程挂掉后下一次 request() 自动重启；5 分钟窗内累计 3 次崩溃就熔断，返
//     _giveUp=true 让上层退回读端 stub。
//   · 所有请求串行：Python 端也是同步 stdin 循环，不需要 ID 匹配，pending
//     队列按 FIFO 出队。
//
// 用法：
//   const bridge = new LighterSignerBridge({
//     pythonPath: 'python3',
//     workerPath: '/abs/path/tools/lighter-signer.py',
//     initParams: { api_url, api_key_private_key, account_index, api_key_index },
//   });
//   await bridge.start();                             // ping + init
//   const r = await bridge.signCreateOrder({ ... });  // { ok, tx_hash, ... } | { err }
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const REQUEST_TIMEOUT_MS = 15000;    // 单请求超时（签名 + REST send_tx 通常 <2s）
const PING_TIMEOUT_MS = 5000;
const START_TIMEOUT_MS = 20000;      // init 里要建 SignerClient + check_client（网络往返）
const RESTART_WINDOW_MS = 5 * 60 * 1000;
const MAX_RESTARTS = 3;

export class LighterSignerBridge extends EventEmitter {
  constructor({ pythonPath = 'python3', workerPath, initParams }) {
    super();
    if (!workerPath) throw new Error('LighterSignerBridge: workerPath required');
    if (!initParams) throw new Error('LighterSignerBridge: initParams required');
    this.pythonPath = pythonPath;
    this.workerPath = workerPath;
    this.initParams = initParams;

    this.proc = null;
    this.pending = [];      // FIFO { resolve, reject, timer, cmd }
    this.buffer = '';
    this.starting = null;   // start() 在跑就 dedup

    this._restartHistory = [];
    this._giveUp = false;
    this._stderrTail = '';
  }

  isReady() { return !!this.proc && !this.proc.killed && !this.starting && !this._giveUp; }
  isGivenUp() { return this._giveUp; }
  stderrTail() { return this._stderrTail; }

  async start() {
    if (this._giveUp) {
      throw new Error('lighter-signer bridge given up after repeated failures');
    }
    if (this.proc && !this.proc.killed && !this.starting) return;
    if (this.starting) return this.starting;

    // 熔断：滚动 5 分钟窗内 3 次崩溃就放弃
    const now = Date.now();
    this._restartHistory = this._restartHistory.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this._restartHistory.length >= MAX_RESTARTS) {
      this._giveUp = true;
      throw new Error(`lighter-signer worker crashed ${MAX_RESTARTS}× within 5 min · giving up`);
    }
    this._restartHistory.push(now);

    this.starting = (async () => {
      const proc = spawn(this.pythonPath, [this.workerPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });
      this.proc = proc;
      this.buffer = '';

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => this._onData(chunk));
      proc.stderr.on('data', (chunk) => {
        const s = chunk.toString();
        this._stderrTail = (this._stderrTail + s).slice(-2000);
        for (const line of s.split(/\r?\n/)) {
          if (line.trim()) console.warn('[lighter-signer]', line);
        }
      });
      proc.on('exit', (code, signal) => {
        const msg = `worker exited code=${code} signal=${signal} tail=${this._stderrTail.slice(-300)}`;
        if (this.proc === proc) this.proc = null;
        this.emit('crash', new Error(msg));
        this._flushPending(new Error(msg));
      });
      proc.on('error', (e) => {
        this.emit('crash', e);
        this._flushPending(e);
      });

      // 探活
      const pong = await this._raceRequest({ cmd: 'ping' }, PING_TIMEOUT_MS);
      if (!pong || !pong.ok) throw new Error(`ping failed: ${JSON.stringify(pong)}`);

      // 建 SignerClient + check_client
      const init = await this._raceRequest({ cmd: 'init', params: this.initParams }, START_TIMEOUT_MS);
      if (!init || !init.ok) throw new Error(`init failed: ${(init && init.err) || JSON.stringify(init)}`);
      if (init.check_error) {
        // 非致命：check_client 报错通常意味着 api_key / account_index / api_key_index 不匹配 —
        // 让上层看到但不 hard-fail，允许 user 先看到日志再调整 env。
        console.warn('[lighter-signer] check_client 警告：', init.check_error);
        this.emit('check_warning', init.check_error);
      }
    })();

    try {
      await this.starting;
    } catch (e) {
      this._destroyProc();
      throw e;
    } finally {
      this.starting = null;
    }
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      const req = this.pending.shift();
      if (!req) {
        console.warn('[lighter-signer] stray line (no pending):', line.slice(0, 200));
        continue;
      }
      try {
        req.resolve(JSON.parse(line));
      } catch (e) {
        req.reject(new Error(`bad worker output: ${line.slice(0, 200)}`));
      }
    }
  }

  _raceRequest(msg, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.killed) return reject(new Error('worker not running'));
      const timer = setTimeout(() => {
        const i = this.pending.findIndex((p) => p.timer === timer);
        if (i >= 0) this.pending.splice(i, 1);
        reject(new Error(`worker timeout ${timeoutMs}ms cmd=${msg.cmd}`));
      }, timeoutMs);
      const entry = {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        timer,
        cmd: msg.cmd,
      };
      this.pending.push(entry);
      try {
        this.proc.stdin.write(JSON.stringify(msg) + '\n');
      } catch (e) {
        clearTimeout(timer);
        const j = this.pending.indexOf(entry);
        if (j >= 0) this.pending.splice(j, 1);
        reject(e);
      }
    });
  }

  async request(msg, timeoutMs) {
    if (!this.isReady()) await this.start();
    return this._raceRequest(msg, timeoutMs);
  }

  async signCreateOrder(params) { return this.request({ cmd: 'create_order', params }); }
  async signCancelOrder(params) { return this.request({ cmd: 'cancel_order', params }); }
  async signCancelAll(params = {}) { return this.request({ cmd: 'cancel_all_orders', params }); }
  async ping() { return this.request({ cmd: 'ping' }, PING_TIMEOUT_MS); }

  _flushPending(err) {
    const list = this.pending;
    this.pending = [];
    for (const p of list) {
      try { clearTimeout(p.timer); } catch {}
      try { p.reject(err); } catch {}
    }
  }

  _destroyProc() {
    if (this.proc) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
    }
  }

  stop() {
    this._destroyProc();
    this._flushPending(new Error('bridge stopped'));
  }
}
