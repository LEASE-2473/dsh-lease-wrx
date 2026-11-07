import { createHash } from 'node:crypto';
import { atomicUnits } from './index.js';

/** 其他会话只提供带来源的正文；当前会话工具调用组作为不可拆的排序单元。 */
export function mergeSharedHistory(current, rows, messageTimes = {}) {
  const units = atomicUnits(current, messageTimes);
  for (const row of rows) {
    if (!['user', 'assistant'].includes(row.role) || typeof row.content !== 'string') continue;
    const id = 'lease-wrx-cross-' + createHash('sha256').update(JSON.stringify([row.id, row.sessionId, row.time, row.role, row.content])).digest('hex').slice(0, 32);
    const time = Date.parse(row.time);
    units.push({ time: Number.isFinite(time) ? time : null, messages: [{ id, role: row.role, content: [{ type: 'text', text: `【其他会话 ${row.sessionId}｜${row.time}】\n${row.content}` }], source: { kind: 'lease-wrx-cross-session', sessionId: row.sessionId } }] });
  }
  return units.sort((a, b) => (a.time ?? 0) - (b.time ?? 0)).flatMap(unit => unit.messages);
}
