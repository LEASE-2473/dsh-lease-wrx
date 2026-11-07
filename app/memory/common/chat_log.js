import { loadConfig } from '../../common/config.js';
import { roleId } from '../../common/role-context.js';
/** 按功能拆分的兼容仓储；字段协议对照 WRX Companion，DSH 新增行为保留。 */
import { openDb } from './database.js';

export function insertChatLog(sessionId, role, at, content, character = roleId() || loadConfig().dshCharacters[0], preset = null) {
  const text = String(content || '').trim();
  if (!text || !['user', 'assistant'].includes(role)) return 0;
  const time = new Date(at);
  if (!Number.isFinite(time.getTime())) throw new Error('对话时间无效');
  if (character) openDb().prepare("INSERT INTO conversations(id,character_id,agent_preset,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET character_id=excluded.character_id,agent_preset=COALESCE(excluded.agent_preset,conversations.agent_preset),updated_at=excluded.updated_at").run(String(sessionId), character, preset, time.toISOString(), time.toISOString());
  const info = openDb()
    .prepare('INSERT INTO chat_log(session_id,role,at,content) VALUES (?,?,?,?)')
    .run(String(sessionId), role, time.toISOString(), text);

  return Number(info.lastInsertRowid);
}

export function readChatLog(from, to, character = roleId()) {
  return openDb()
    .prepare('SELECT id, session_id, role, at, content FROM chat_log WHERE (? IS NULL OR session_id IN (SELECT id FROM conversations WHERE character_id=?)) AND julianday(at) >= julianday(?) AND julianday(at) < julianday(?) ORDER BY julianday(at), id')
    .all(character ?? null, character ?? null, String(from), String(to))
    .map((row) => ({ id: row.id, chatLogId: row.id, sessionId: row.session_id, role: row.role, time: row.at, content: row.content }));
}

/** 只读「不是当前会话」的最近对话，给跨窗口上下文用。 */
export function readChatLogExcluding(sessionId, since, limit = 12) {
  const rows = openDb()
    .prepare('SELECT session_id, role, at, content FROM chat_log WHERE (? IS NULL OR session_id IN (SELECT id FROM conversations WHERE character_id=?)) AND session_id <> ? AND at >= ? ORDER BY at DESC LIMIT ?')
    .all(roleId() ?? null, roleId() ?? null, String(sessionId), String(since), Math.max(1, Number(limit) || 12));
  return rows.reverse().map((row) => ({ sessionId: row.session_id, role: row.role, time: row.at, content: row.content }));
}

export function latestChatLogAt() {
  const row = openDb().prepare('SELECT MAX(at) AS at FROM chat_log').get();
  return row?.at || '';
}

/** 对话流水只留最近 N 天：老内容早就进了四表和日记，原文不用留一辈子。 */
export function pruneChatLog(days = 90) {
  const keep = Math.max(1, Number(days) || 90);
  const cutoff = new Date(Date.now() - keep * 86400000).toISOString();
  return openDb().prepare('DELETE FROM chat_log WHERE at < ?').run(cutoff).changes;
}

export function chatLogCount() {
  return openDb().prepare('SELECT COUNT(*) AS c FROM chat_log').get().c;
}

/** 只登记确实完整传给成功总结批次的 chat_log 行；旧批次不靠时间窗猜测覆盖关系。 */
export function recordSummaryCoverage(batchId, messages) {
  const db = openDb();
  const batch = db.prepare("SELECT * FROM system_memory_batches WHERE id=? AND status='done'").get(String(batchId));
  if (!batch) throw new Error('只有成功总结批次可以登记覆盖');
  const verify = db.prepare('SELECT id FROM chat_log WHERE id=? AND session_id=? AND at=? AND content=? AND julianday(at)>=julianday(?) AND julianday(at)<julianday(?)');
  const insert = db.prepare('INSERT OR IGNORE INTO system_summary_chat_sources(batch_id,chat_log_id) VALUES (?,?)');
  let count = 0;
  for (const message of messages || []) {
    if (!Number.isSafeInteger(message.chatLogId)) continue;
    if (!verify.get(message.chatLogId, message.sessionId, message.time, message.content, batch.range_start, batch.range_end)) continue;
    count += Number(insert.run(String(batchId), message.chatLogId).changes);
  }
  return count;
}

/** 次数模式只由当前会话编译器处理；跨会话共享仅允许明确的时间窗口。 */
export function readSharedChatWindow({ sessionId, mode = 'turns', turns = 30, since, durationMinutes = 60, now = Date.now(), excludeSummarized = false } = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('共享对话窗口需要当前 sessionId');
  if (!['turns', 'since', 'duration'].includes(mode)) throw new Error('未知共享对话窗口模式');
  const end = new Date(now);
  if (!Number.isFinite(end.getTime())) throw new Error('共享对话窗口结束时间无效');
  const endTime = end.toISOString();
  // 用户最终约定：turns 不共享其他会话，也不为共享窗口计全局次数。
  if (mode === 'turns') {
    return { rows: [], startTime: null, endTime };
  }
  const db = openDb();
  const minutes = Number(durationMinutes);
  if (mode === 'duration' && (!Number.isFinite(minutes) || minutes <= 0)) throw new Error('共享窗口时长必须大于0');
  const start = new Date(mode === 'since' ? since : end.getTime() - minutes * 60000);
  if (!Number.isFinite(start.getTime()) || start > end) throw new Error('共享对话窗口起点无效');
  const startTime = start.toISOString();
  const covered = excludeSummarized ? `AND NOT EXISTS (
    SELECT 1 FROM system_summary_chat_sources s JOIN system_memory_batches b ON b.id=s.batch_id
    WHERE s.chat_log_id=c.id AND b.status='done')` : '';
  const rows = db.prepare(`SELECT c.id,c.session_id,c.role,c.at,c.content FROM chat_log c
    WHERE julianday(c.at)>=julianday(?) AND julianday(c.at)<=julianday(?) AND c.session_id<>?
      AND (? IS NULL OR c.session_id IN (SELECT id FROM conversations WHERE character_id=?)) AND c.role IN ('user','assistant') ${covered}
    ORDER BY julianday(c.at),c.id`).all(startTime, endTime, sessionId, roleId() ?? null, roleId() ?? null)
    .map(row => ({ id: row.id, sessionId: row.session_id, role: row.role, time: row.at, content: row.content }));
  return { rows, startTime, endTime };
}

