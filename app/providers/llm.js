function textMessages(messages) {
  return messages.map((m) => ({ role: m.role, content: [{ type: 'text', text: m.text }] }));
}

function finishError(reason) {
  const kind = reason?.kind;
  if (kind === 'error' || kind === 'aborted') {
    const failure = reason.failure || {};
    const err = new Error(failure.message || ('模型调用' + (kind === 'aborted' ? '被取消' : '失败')));
    err.code = failure.code || kind;
    return err;
  }
  return null;
}

export async function complete(ctx, cfg, { system, messages, maxTokens = 2048, sessionId = 'lease-wrx-background' }) {
  const llmCfg = cfg.llm || {};
  if (llmCfg.mode === 'endpoint') return endpointComplete(llmCfg, { system, messages, maxTokens });

  const service = typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm;
  if (!service) throw new Error('DSH 的 llm 服务不可用；请改「独立端点」模式');
  let provider = llmCfg.provider;
  let model = llmCfg.model;
  if (!provider || !model) {
    const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.();
    if (!selection) throw new Error('没有可用的默认模型，请在记忆设置里指定 provider/model');
    provider = selection.provider;
    model = selection.model;
  }
  const options = {
    provider,
    model,
    sessionId,
    messages: textMessages(messages),
  };
  // 学 WRX：不硬设输出上限，交给服务端默认。设死了会被 reasoning 吃光，
  // 2026-10-26 实测 3072、8192 都被吃光过。maxTokens 传 0 或负数就表示不设。
  if (Number(maxTokens) > 0) options.maxTokens = Number(maxTokens);
  if (system) options.system = system;
  if (llmCfg.temperature !== undefined) options.temperature = Number(llmCfg.temperature);
  // 后台任务是抽取和总结，不是推理题。2026-10-26 实测：这个模型把 8000+ token
  // 全花在 reasoning 上，正文一个字没轮到就撞 max-tokens。
  // 用 low 而不是 off：画像要判断「哪条还成立」，得让它想一点，只是别想满。
  // DSH 主会话有 clampThinkingBudgetToAnswerRoom 给答案留空间，这里没有，只能自己压档。
  const effort = llmCfg.reasoningEffort === undefined ? 'low' : String(llmCfg.reasoningEffort);
  if (effort && effort !== 'default') options.reasoningEffort = effort;
  let out = '';
  const seen = {};
  let lastFinish = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('模型调用超时（180s）')), 180000);
  options.signal = controller.signal;
  try {
    for await (const chunk of service.stream(options)) {
      const type = chunk?.type || 'unknown';
      seen[type] = (seen[type] || 0) + 1;
      if (type === 'text-delta') out += chunk.text ?? '';
      else if (type === 'finish') {
        lastFinish = chunk.reason || null;
        const err = finishError(chunk.reason);
        if (err) throw err;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  // 空输出单独报——不然上层只会说「没有 JSON」，看不出是块类型不对、还是推理把额度吃光了。
  if (!out.trim()) {
    throw new Error('模型没有返回文本（收到的块：' + JSON.stringify(seen)
      + '；结束原因：' + JSON.stringify(lastFinish).slice(0, 300) + '）');
  }
  return out;
}

async function endpointComplete(llmCfg, { system, messages, maxTokens }) {
  const base = String(llmCfg.baseURL || '').replace(/\/$/, '');
  if (!base) throw new Error('独立端点模式需要填写 baseURL');
  const key = llmCfg.apiKey || (llmCfg.apiKeyEnv ? process.env[llmCfg.apiKeyEnv] : '') || '';
  if (!key) throw new Error('缺少 API Key：可在设置里填写，或设置环境变量 ' + (llmCfg.apiKeyEnv || 'DEEPSEEK_API_KEY'));
  const body = {
    model: llmCfg.model,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages.map((m) => ({ role: m.role, content: m.text })),
    ],
    temperature: Number(llmCfg.temperature ?? 0.2),
    max_tokens: maxTokens,
    stream: false,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('模型调用超时（180s）')), 180000);
  try {
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error('模型接口错误 HTTP ' + res.status + '：' + text.slice(0, 500));
    const json = JSON.parse(text);
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('模型返回格式异常：' + text.slice(0, 300));
    return content;
  } finally {
    clearTimeout(timer);
  }
}

export async function listProviders(ctx) {
  const service = typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm;
  if (!service) return [];
  let providers = [];
  try { providers = service.listProviders() || []; } catch { /* noop */ }
  const out = [];
  for (const p of providers) {
    const id = typeof p === 'string' ? p : (p.provider || p.id || p.route);
    if (!id) continue;
    let models = [];
    try {
      const listed = await service.listModels(id);
      models = (listed || []).map((m) => (typeof m === 'string' ? m : m.model || m.id)).filter(Boolean);
    } catch { /* noop */ }
    out.push({ provider: id, label: p.label || id, models });
  }
  return out;
}
