/** 按功能拆分的兼容仓储；字段协议对照 WRX Companion，DSH 新增行为保留。 */
import { openDb } from '../common/database.js';
import { nowIso } from '../common/utilities.js';

export function saveTempSummary(characterId, sessionId, start, end, content) {
  const info = openDb()
    .prepare('INSERT INTO system_temp_summaries(character_id,session_id,range_start,range_end,content,status,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(characterId, String(sessionId || ''), String(start || ''), String(end || ''), String(content || ''), 'temp', nowIso());
  return Number(info.lastInsertRowid);
}

export function listTempSummaries(characterId, status = 'temp', limit = 50) {
  return openDb()
    .prepare('SELECT * FROM system_temp_summaries WHERE character_id=? AND status=? ORDER BY sequence LIMIT ?')
    .all(characterId, status, limit);
}

export function markTempSummaries(ids, status = 'merged') {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const d = openDb();
  let changed = 0;
  for (const id of ids) {
    changed += d.prepare('UPDATE system_temp_summaries SET status=?,merged_at=? WHERE sequence=?').run(status, nowIso(), Number(id)).changes;
  }
  return changed;
}

/** 已合并的临时总结保留几天就清掉，别让中间产物越攒越多。 */
export function cleanupTempSummaries(days = 7) {
  const cutoff = new Date(Date.now() - Math.max(1, Number(days) || 7) * 86400000).toISOString();
  return openDb().prepare("DELETE FROM system_temp_summaries WHERE status='merged' AND merged_at <> '' AND merged_at < ?").run(cutoff).changes;
}

/* ---------- 日记任务（失败原因落库，别再靠日志瞎猜） ---------- */

