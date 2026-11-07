import { isCheckpoint } from './compaction.js';
/** 选择真实用户回合，工具调用/结果作为原始消息保留。 */
export function isHumanMessage(message) {
  const kind = message?.source?.kind ?? message?.source;
  return message?.role === 'user' && (!kind || kind === 'user' || kind === 'human');
}
/** 原生定时提醒也是会驱动 Agent 的输入，但不冒充真人或进入真人流水。 */
export function isTurnInput(message) {
  return isHumanMessage(message) || (message?.role === 'user' && (message?.source?.kind ?? message?.source) === 'schedule');
}
/** 只有可替换的背景快照才进运行背景；任务通知/插件事件必须保留原生时序。 */
export function isRuntimeSnapshot(message) {
  const kind = message?.source?.kind ?? message?.source;
  return message?.role === 'user' && !isTurnInput(message) && !isCheckpoint(message) &&
    (kind === 'time-context' || kind === 'runtime-context' || message?.source?.form === 'snapshot');
}
export function messageTime(message, messageTimes = {}) {
  const value = messageTimes[message?.id] ?? message?.time ?? message?.timestamp;
  const numeric = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(numeric) ? numeric : null;
}
export function atomicUnits(messages, messageTimes = {}) {
  const units = [];
  for (let i = 0; i < messages.length; i++) {
    const group = [messages[i]];
    const calls = messages[i].role === 'assistant' ? (messages[i].content ?? []).filter(b => b.type === 'tool-call') : [];
    const pending = new Set(calls.map(b => b.id ?? b.toolCallId));
    while (pending.size && i + 1 < messages.length) {
      const next = messages[++i]; group.push(next);
      if (next.role === 'tool') pending.delete(next.toolCallId);
    }
    units.push({ messages: group, time: messageTime(group[0], messageTimes) });
  }
  return units;
}
export function splitConversation(messages, historyTurns = 30, { window, messageTimes = {} } = {}) {
  if (!Number.isInteger(historyTurns) || historyTurns < 0 || historyTurns > 10000) throw new Error('历史轮数必须为 0–10000 的整数');
  const inputs = messages.map((m, i) => isTurnInput(m) ? i : -1).filter(i => i >= 0);
  if (!inputs.length) return { history: [], current: [], continuation: [], runtime: messages.filter(isRuntimeSnapshot), key: null };
  const currentAt = inputs.at(-1);
  const previous = inputs.filter(i => i < currentAt && isHumanMessage(messages[i]));
  // N 仍计真人回合；纯定时会话也能保留自己的历史，N=0 只保留当前输入。
  const start = historyTurns ? (previous.length ? previous[Math.max(0, previous.length - historyTurns)] : inputs[0]) : currentAt;
  // 可替换的背景按来源取最新值；notice 等事件不去重、不移动到背景插槽。
  const runtimeByKind = new Map();
  for (const message of messages) if (isRuntimeSnapshot(message)) {
    runtimeByKind.set(message.source?.kind ?? message.source, message);
  }
  const runtime = [...runtimeByKind.values()];
  const mode = window?.mode ?? 'turns';
  let history = messages.slice(0, currentAt).filter((message, index) =>
    (mode !== 'turns' || index >= start || (historyTurns > 0 && isCheckpoint(message))) &&
    message.role !== 'system' && !isRuntimeSnapshot(message));
  let boundaryExtended = false;
  let missingTimes = 0;
  if (mode !== 'turns') {
    if (!['since', 'duration'].includes(mode)) throw new Error('未知历史窗口模式');
    const until = Number(window.endTime);
    const from = window.startTime == null ? (mode === 'since' ? Date.parse(window.since) : until - Number(window.durationMinutes) * 60000) : Number(window.startTime);
    if (!Number.isFinite(from) || !Number.isFinite(until) || from > until) throw new Error('时间窗口必须包含有效起止时间');
    const units = atomicUnits(history, messageTimes);
    missingTimes = history.filter(message => messageTime(message, messageTimes) == null).length;
    const within = message => { const t = messageTime(message, messageTimes); return t != null && t >= from && t <= until; };
    const selected = units.filter(unit => unit.messages.some(within));
    boundaryExtended = selected.some(unit => unit.messages.some(message => !within(message)));
    history = selected.flatMap(unit => unit.messages);
  }
  const continuation = messages.slice(currentAt + 1).filter(m => m.role !== 'system' && !isRuntimeSnapshot(m) && !isCheckpoint(m));
  assertToolPairs(history);
  assertToolPairs(continuation);
  return { history, current: [messages[currentAt]], continuation, runtime, key: messages[currentAt].id ?? messages[currentAt], boundaryExtended, missingTimes };
}
export function assertToolPairs(messages) {
  const pending = new Set();
  for (const message of messages) {
    if (message.role === 'assistant') {
      if (pending.size) throw new Error('工具调用尚未取得全部结果，不能插入下一条助手消息');
      for (const block of message.content ?? []) if (block.type === 'tool-call') {
        const id = block.id ?? block.toolCallId;
        if (!id || pending.has(id)) throw new Error('工具调用 ID 缺失或重复');
        pending.add(id);
      }
    } else if (message.role === 'tool') {
      if (!pending.delete(message.toolCallId)) throw new Error('工具结果缺少对应调用，不能裁断工具链');
    } else if (pending.size && isTurnInput(message)) throw new Error('工具链尚未结束，不能插入用户消息');
  }
  if (pending.size) throw new Error('工具结果不完整');
}
export function safeBoundary(messages, desired) {
  // 插入位置不能落在 assistant tool-call 与其结果之间。
  let pending = 0;
  let start = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const calls = m.role === 'assistant' ? (m.content ?? []).filter(b => b.type === 'tool-call').length : 0;
    if (calls) { start = i; pending += calls; }
    if (m.role === 'tool') pending--;
    if (i + 1 === desired && pending > 0) return start;
  }
  return desired;
}
