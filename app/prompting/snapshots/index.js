/** 每个会话仅保留当前真人/定时输入的编排快照，原生思考与工具续轮保持结构化轨迹。 */
import { compilePrompt } from '../compiler/index.js';
import { splitConversation } from '../history/index.js';

export function createSnapshotCompiler({ loadState, loadSources = () => ({}), maxSessions = 100 } = {}) {
  const sessions = new Map();
  return {
    clear: () => sessions.clear(),
    compile(input) {
      const conversation = splitConversation(input.messages, input.historyTurns);
      if (!conversation.current.length) return { messages: input.messages, trace: [], warnings: ['无真人或定时输入，保留原请求'] };
      let cached = sessions.get(input.sessionId);
      const sameTurn = cached?.key === conversation.key && cached?.roleKey === input.roleKey;
      if (!sameTurn || cached.compactionKey !== input.compactionKey) {
        const at = input.messages.indexOf(conversation.current[0]);
        const { _historyWindow, _sharedHistory, ...provided } = sameTurn ? cached.provided : loadSources(input);
        const sources = structuredClone({ ...provided, 'dsh.runtime': conversation.runtime });
        const state = sameTurn ? cached.state : structuredClone(loadState());
        const result = compilePrompt({
          state, messages: input.messages.slice(0, at + 1),
          sources, historyTurns: input.historyTurns, historyWindow: _historyWindow, sharedHistory: _sharedHistory, messageTimes: input.messageTimes,
        });
        cached = { roleKey: input.roleKey, key: conversation.key, compactionKey: input.compactionKey, state, provided: structuredClone({ ...provided, _historyWindow, _sharedHistory }), result: structuredClone(result) };
        sessions.delete(input.sessionId);
        sessions.set(input.sessionId, cached);
        if (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
      }
      const preset = cached.state.presets.find(p => p.id === cached.state.active_preset_id) ?? cached.state.presets[0];
      return { ...cached.result, generationParameters: structuredClone(preset.generation_parameters ?? {}), messages: [...cached.result.messages, ...conversation.continuation] };
    },
  };
}
