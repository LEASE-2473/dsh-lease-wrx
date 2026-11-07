export function createRequestCapture({ maxBytes = 8 * 1024 * 1024 } = {}) {
  let enabled = false, latest = null, error = null;
  return {
    status: () => ({ enabled, stage: 'adapter-input', latest, error, maxBytes }),
    configure(value) { enabled = value; },
    clear() { latest = null; error = null; },
    record(options) {
      if (!enabled) return;
      try {
        const data = {
          at: new Date().toISOString(), stage: 'adapter-input',
          session: options.sessionId ?? null, provider: options.provider, model: options.model,
          messages: (options.messages || []).map(message => ({ ...message, blocks: message.content })),
          tools: options.tools || [],
        };
        const serialized = JSON.stringify(data);
        if (Buffer.byteLength(serialized) > maxBytes) throw new Error('本次请求超过抓包大小上限，未保存；不会影响聊天');
        latest = JSON.parse(serialized); error = null;
      } catch (caught) { latest = null; error = String(caught.message); }
    },
  };
}
