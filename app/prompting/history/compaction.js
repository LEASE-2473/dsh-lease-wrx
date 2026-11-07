export const isCheckpoint = message => (message?.source?.kind ?? message?.source) === 'compact-checkpoint';

export function applyCompactionBoundary({ messages, sessionLog = [], surfaceNodes, messageTimes = {} }) {
  const events = new Map(sessionLog.map(event => [event.seq, event]));
  const active = surfaceNodes ? new Set(surfaceNodes) : null;
  const suppressed = new Set();
  const checkpoints = new Map();
  const warnings = [];
  const times = { ...messageTimes };
  const coverage = (event, visited = new Set()) => {
    if (!event || visited.has(event.seq)) return [];
    visited.add(event.seq);
    if (!isCheckpoint(event.data)) return [event];
    const summary = (event.sourceEventSeqs || []).map(seq => events.get(seq)).find(candidate =>
      candidate?.type === 'compaction/summary' && candidate.data.compactionId === event.data.source?.compactionId);
    const seqs = summary?.data.shadowedSeqs;
    if (!Array.isArray(seqs) || !seqs.length) return [];
    const result = [];
    for (const seq of seqs) {
      const covered = events.get(seq);
      const message = covered?.type === 'user/message' ? covered.data : covered?.data?.message;
      if (message?.id) suppressed.add(message.id);
      if (isCheckpoint(message)) result.push(...coverage(covered, visited));
      else if (covered) result.push(covered);
    }
    return result;
  };
  const messageIds = new Set(messages.filter(isCheckpoint).map(message => message.id));
  for (const event of sessionLog) {
    if (event.type !== 'user/message' || !isCheckpoint(event.data) || !messageIds.has(event.data.id) || (active && !active.has(event.seq))) continue;
    const covered = coverage(event);
    const coveredTimes = covered.map(item => typeof item.time === 'number' ? item.time : Date.parse(item.time)).filter(Number.isFinite);
    if (!coveredTimes.length) {
      warnings.push(`压缩摘要 ${event.data.id} 缺少可核验覆盖时间，保留宿主位置与时间`);
      continue;
    }
    const metadata = { startTime: Math.min(...coveredTimes), endTime: Math.max(...coveredTimes), coveredCount: covered.length };
    checkpoints.set(event.data.id, metadata);
    times[event.data.id] = metadata.endTime;
  }
  const visibleIds = active ? new Set([...active].map(seq => events.get(seq)).filter(event => event?.type === 'user/message' && isCheckpoint(event.data)).map(event => event.data.id)) : null;
  const result = messages.filter(message => !suppressed.has(message.id) && (!isCheckpoint(message) || !visibleIds || visibleIds.has(message.id)))
    .map(message => checkpoints.has(message.id) ? { ...message, time: times[message.id], leaseWrxCompaction: checkpoints.get(message.id) } : message);
  for (const message of result.filter(isCheckpoint)) if (!checkpoints.has(message.id) && !warnings.some(warning => warning.includes(message.id))) warnings.push('压缩摘要缺少覆盖元数据；请确认宿主压缩边界补丁已安装');
  return { messages: result, messageTimes: times, warnings, key: JSON.stringify(result.filter(isCheckpoint).map(message => [message.id, message.leaseWrxCompaction ?? null])) };
}
