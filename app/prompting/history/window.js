export function normalizeHistoryWindow(value = {}, fallbackTurns = 30) {
  const mode = value.mode ?? 'turns';
  if (!['turns', 'since', 'duration'].includes(mode)) throw new Error('历史模式必须是 turns / since / duration');
  const turns = value.turns ?? fallbackTurns;
  const durationMinutes = value.durationMinutes ?? 60;
  if (mode === 'turns' && (!Number.isInteger(turns) || turns < 0 || turns > 10000)) throw new Error('历史轮数必须为 0–10000 的整数');
  if (mode === 'duration' && (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 525600)) throw new Error('固定时长必须为 1–525600 分钟的整数');
  if (mode === 'since' && !Number.isFinite(Date.parse(value.since))) throw new Error('固定起点必须是有效时间');
  return { mode, turns: Number.isInteger(turns) ? turns : fallbackTurns, durationMinutes: Number.isInteger(durationMinutes) ? durationMinutes : 60, since: value.since || '' };
}
