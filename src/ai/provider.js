// 多提供商 AI 接口层：一个 aiChat() 通吃三种主流 API 协议。
//   openai    — OpenAI 兼容协议（OpenAI / DeepSeek / Kimi(Moonshot) / 通义 Qwen /
//               智谱 / OpenRouter / Ollama 本地 等，只需改 AI_BASE_URL + AI_MODEL）
//   anthropic — Claude 原生协议
//   gemini    — Google Gemini 原生协议
// 配置全部从环境变量实时读取（仪表盘写 .env 后立即生效，无需重启）。
// 请求走全局 fetch（自动经过已配置的代理）。

const DEFAULTS = {
  openai:    { base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  anthropic: { base: 'https://api.anthropic.com', model: 'claude-3-5-haiku-latest' },
  gemini:    { base: 'https://generativelanguage.googleapis.com', model: 'gemini-2.0-flash' },
};

export function getAiConfig() {
  const provider = (process.env.AI_PROVIDER || 'openai').toLowerCase();
  const d = DEFAULTS[provider] || DEFAULTS.openai;
  return {
    provider: DEFAULTS[provider] ? provider : 'openai',
    apiKey: process.env.AI_API_KEY || '',
    baseUrl: (process.env.AI_BASE_URL || d.base).replace(/\/$/, ''),
    model: process.env.AI_MODEL || d.model,
    // 高频低成本任务（哨兵巡检）可指定更便宜的小模型；未配置则用主模型
    modelSmall: process.env.AI_MODEL_SMALL || process.env.AI_MODEL || d.model,
    sentinelMin: Number(process.env.AI_SENTINEL_MINUTES ?? 5),
    marketMin: Number(process.env.AI_MARKET_MINUTES ?? 30), // BTC 市况报告间隔（分钟，0=关闭）
    reportHour: Number(process.env.AI_REPORT_HOUR ?? 20),
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChat: process.env.TELEGRAM_CHAT_ID || '',
    webhook: process.env.NOTIFY_WEBHOOK || '',
  };
}

/**
 * 统一对话接口。
 * @param {object} o
 *   o.system   系统提示词
 *   o.messages [{role:'user'|'assistant', content:string}]
 *   o.small    true=用小模型（哨兵等高频任务）
 *   o.json     true=要求返回 JSON（openai 用 response_format，其余靠提示词约束）
 * @returns {Promise<string>} 模型回复文本
 */
export async function aiChat({ system = '', messages, small = false, json = false, maxTokens = 4000, temperature = 0.3, timeoutMs = 120000 }) {
  const cfg = getAiConfig();
  if (!cfg.apiKey) throw new Error('未配置 AI_API_KEY，请在「AI」页填写接入信息。');
  const model = small ? cfg.modelSmall : cfg.model;
  // 加 helpful timeout error（用户端截图看到过「The operation was aborted due to timeout」
  // 没有上下文，改成中文 + 定位服务商），换 Promise.race 而不是 AbortSignal.timeout
  // 因为后者的 error message 是浏览器/undici 默认的英文，不好排查。
  const controller = new AbortController();
  const signal = controller.signal;
  const abortTimer = setTimeout(() => controller.abort(new Error(
    `AI 请求超时（${Math.round(timeoutMs/1000)}s）：可能是 ${cfg.provider} 服务商 (${cfg.baseUrl}) 慢/挂了，或模型 ${model} 排队。可换服务商或稍后重试。`
  )), timeoutMs);
  const clearTimer = () => clearTimeout(abortTimer);

  try {
    if (cfg.provider === 'anthropic') {
      const res = await fetch(cfg.baseUrl + '/v1/messages', {
        method: 'POST', signal,
        headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, max_tokens: maxTokens, temperature,
          system: system + (json ? '\n必须只输出一个合法 JSON 对象，不要任何其他文字。' : ''),
          messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
        }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`Anthropic 接口错误 HTTP ${res.status}: ${j?.error?.message || ''}`);
      const text = (j?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      if (!text) throw new Error('Anthropic 返回为空');
      return text;
    }

    if (cfg.provider === 'gemini') {
      const contents = messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      const res = await fetch(`${cfg.baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(system ? { system_instruction: { parts: [{ text: system + (json ? '\n必须只输出一个合法 JSON 对象，不要任何其他文字。' : '') }] } } : {}),
          contents,
          generationConfig: { maxOutputTokens: maxTokens, temperature, ...(json ? { responseMimeType: 'application/json' } : {}) },
        }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`Gemini 接口错误 HTTP ${res.status}: ${j?.error?.message || ''}`);
      const text = (j?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      if (!text) throw new Error('Gemini 返回为空');
      return text;
    }

    // openai 兼容协议（默认）
    const res = await fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST', signal,
      headers: { Authorization: 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: maxTokens, temperature,
        messages: [
          ...(system ? [{ role: 'system', content: system + (json ? '\n必须只输出一个合法 JSON 对象，不要任何其他文字。' : '') }] : []),
          ...messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
        ],
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`AI 接口错误 HTTP ${res.status}: ${j?.error?.message || JSON.stringify(j || {}).slice(0, 200)}`);
    const text = j?.choices?.[0]?.message?.content;
    const finishReason = j?.choices?.[0]?.finish_reason;
    // finish_reason=length 说明 max_tokens 太小被截断，给用户人性化提示
    if (!text) {
      if (finishReason === 'length') {
        throw new Error(`AI 输出被截断（finish_reason=length，maxTokens=${maxTokens}）。模型没写出任何内容就触顶了——说明该模型 tokenizer 里中文 prompt 占的 token 远大于预期。建议：换支持更长输出的模型（如 gpt-4o-mini），或到 AI 页缩短 prompt。服务商 ${cfg.provider} · model ${model}`);
      }
      throw new Error(`AI 返回为空（finish_reason=${finishReason || '?'}，服务商 ${cfg.provider} · ${cfg.baseUrl} · model ${model}）：${JSON.stringify(j || {}).slice(0, 300)}`);
    }
    // 有内容但仍被截断：给下游一个信号（extractJson 会尝试补齐右括号自愈）
    if (finishReason === 'length') {
      console.warn(`[AI] finish_reason=length，输出可能被截断（maxTokens=${maxTokens}，实际 ${text.length} 字）。若下游 JSON 解析失败请调高 maxTokens。`);
    }
    return text;
  } catch (e) {
    // AbortError → 用我们上面 controller.abort(new Error(...)) 塞进去的中文原因
    if (e?.name === 'AbortError' && signal.reason instanceof Error) throw signal.reason;
    throw e;
  } finally {
    clearTimer();
  }
}

/** 从模型回复里稳健地抠出第一个 JSON 对象（容忍 ```json 包裹、前后废话）。
 *  截断自愈：finish_reason=length 时输出常缺右括号，尝试补齐再解析。 */
export function extractJson(text) {
  if (!text) return null;
  const s = String(text);
  const start = s.indexOf('{');
  if (start < 0) return null;
  // 从第一个 { 起做括号配对，忽略字符串内部的花括号
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
  }
  // 截断自愈：JSON 没闭合就补齐尝试解析。断在字符串里 → 关字符串；断在末尾逗号 → 去掉；
  // 剩余深度用 } 补齐。修好也就修好，修不好回退 null（下游有兜底路径）。
  if (depth > 0) {
    let repaired = s.slice(start);
    if (inStr) repaired += '"';
    // 尾部若有半截 key 或 value 逗号残尾，去到最后一个"完整"字符
    repaired = repaired.replace(/,\s*$/, '');
    // 尾部半截未闭合数字/true/false/null 不太好处理，简单粗暴：如果最后一个非空白
    // 字符是 `:`（半截 key），去掉这个 key 再补齐；若是 `,` 已在上面处理。
    repaired = repaired.replace(/,\s*"[^"]*"\s*:\s*$/, '');
    repaired = repaired.replace(/,\s*"[^"]*"\s*$/, '');
    repaired += '}'.repeat(depth);
    try { return JSON.parse(repaired); } catch { return null; }
  }
  return null;
}

/** 推送通知：Telegram + 通用 Webhook，配了哪个发哪个；失败只记日志绝不抛。 */
export async function notify(text) {
  const cfg = getAiConfig();
  const jobs = [];
  if (cfg.telegramToken && cfg.telegramChat) {
    jobs.push(fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.telegramChat, text: String(text).slice(0, 3800) }),
    }).then((r) => { if (!r.ok) console.error('[通知] Telegram 发送失败 HTTP ' + r.status); }));
  }
  if (cfg.webhook) {
    jobs.push(fetch(cfg.webhook, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text).slice(0, 3800) }),
    }).then((r) => { if (!r.ok) console.error('[通知] Webhook 发送失败 HTTP ' + r.status); }));
  }
  if (!jobs.length) return false;
  await Promise.allSettled(jobs);
  return true;
}
