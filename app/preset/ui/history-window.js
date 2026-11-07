/** 历史窗口表单转换；只校验用户当前选择的模式。 */
const validTurns = value => Number.isSafeInteger(value) && value >= 0 && value <= 10000;
const validMinutes = value => Number.isSafeInteger(value) && value > 0 && value <= 525600;
const validSince = value => typeof value === 'string' && value.trim() && Number.isFinite(new Date(value).getTime());

export function historyConfigFromFields(fields, previous = {}) {
  const mode = fields.mode || 'turns';
  if (!['turns', 'duration', 'since'].includes(mode)) throw new Error('请选择有效的历史窗口模式');
  const turns = String(fields.turns ?? '').trim() ? Number(fields.turns) : NaN;
  const minutes = String(fields.durationMinutes ?? '').trim() ? Number(fields.durationMinutes) : NaN;
  const sinceValid = validSince(fields.since);
  if (mode === 'turns' && !validTurns(turns)) throw new Error('用户输入次数必须是 0–10000 的整数');
  if (mode === 'duration' && !validMinutes(minutes)) throw new Error('最近时长必须是 1–525600 的整数分钟');
  if (mode === 'since' && !sinceValid) throw new Error('请选择有效的起始时间');
  const old = previous.historyWindow || {};
  const safeTurns = validTurns(turns) ? turns : validTurns(old.turns) ? old.turns : validTurns(previous.historyTurns) ? previous.historyTurns : 30;
  return {
    enabled: fields.enabled === true,
    historyTurns: safeTurns,
    historyWindow: {
      mode,
      turns: safeTurns,
      since: sinceValid ? new Date(fields.since).toISOString() : validSince(old.since) ? new Date(old.since).toISOString() : '',
      durationMinutes: validMinutes(minutes) ? minutes : validMinutes(old.durationMinutes) ? old.durationMinutes : 60,
    },
  };
}

export function toLocalDateTime(value) {
  if (!validSince(value)) return '';
  const d = new Date(value), pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function describeHistoryWindow(config) {
  const window = config.historyWindow;
  if (window.mode === 'duration') return `各会话最近 ${window.durationMinutes} 分钟的内容；其他会话仅对话文本`;
  if (window.mode === 'since') return `各会话从 ${new Date(window.since).toLocaleString('zh-CN', { hour12: false })}（本地时间）开始的内容；其他会话仅对话文本`;
  return `仅当前会话最近 ${window.turns} 次用户输入及其回复${window.turns === 0 ? '（不带先前回合）' : ''}`;
}
