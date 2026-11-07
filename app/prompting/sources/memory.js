/** 记忆素材在新真人/定时输入时采样；工具续轮不重做召回、画像匹配或跨窗口读取。 */
export function createMemorySources({ loadConfig, recallBlock, tavernDataText, maxSessions = 100 }) {
  const snapshots = new Map();
  return {
    clear: () => snapshots.clear(),
    async read(sessionId, input) {
      const cfg = loadConfig();
      const key = (cfg.dshCharacters?.[0] || 'dsh') + ':' + String(input?.id ?? input);
      const previous = snapshots.get(sessionId);
      if (cfg.prompting?.enabled && previous?.key === key) return previous.promise;
      const promise = (async () => {
        const character = cfg.dshCharacters?.[0] || 'dsh';
        const query = String(input?.current ?? '').trim();
        if (!query) return [];
        let recall = '';
        if (cfg.vector?.enabled) {
          const inject = cfg.tavern?.inject ?? {};
          const kinds = [...(inject.coldMemory !== false ? ['summary', 'person', 'item', 'agreement'] : []), ...(inject.coldDiary !== false ? ['diary'] : []), ...(inject.coldActivity !== false ? ['activity'] : [])];
          recall = (await recallBlock(character, query, { allowKinds: kinds })).text ?? '';
        }
        // 热记忆不依赖向量开关，也不依赖是否召回命中。
        const data = tavernDataText(character, query, input?.previous ?? '', { force: true });
        return [{ name: 'wrx:data', text: data }, { name: 'wrx:recall', text: recall }]
          .filter(section => section.text).map(section => ({ ...section, interpolate: false, placement: 'late' }));
      })();
      snapshots.delete(sessionId);
      snapshots.set(sessionId, { key, promise });
      if (snapshots.size > maxSessions) snapshots.delete(snapshots.keys().next().value);
      try { return await promise; } catch (error) { snapshots.delete(sessionId); throw error; }
    },
  };
}
