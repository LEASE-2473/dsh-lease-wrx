/** 按功能拆分的兼容仓储；字段协议对照 WRX Companion，DSH 新增行为保留。 */
import { openDb } from '../../memory/common/database.js';
import { uid, parseJson } from '../../memory/common/utilities.js';

export function saveCandidate(document, { requestId = '', actionIndex = 0 } = {}) {
  const info = openDb()
    .prepare('INSERT INTO user_profile_candidates(request_id,action_index,document,status) VALUES (?,?,?,?)')
    .run(requestId || uid(), Number(actionIndex) || 0, JSON.stringify(document), 'pending');
  return Number(info.lastInsertRowid);
}

export function listCandidates(limit = 20) {
  return openDb()
    .prepare("SELECT * FROM user_profile_candidates WHERE status='pending' ORDER BY id LIMIT ?")
    .all(Math.max(1, Math.min(100, Number(limit) || 20)))
    .map((r) => ({ id: r.id, ...parseJson(r.document, {}) }));
}

export function reviewCandidates(ids, status = 'reviewed') {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter((n) => Number.isFinite(n));
  if (!list.length) return 0;
  const marks = list.map(() => '?').join(',');
  const info = openDb()
    .prepare(`UPDATE user_profile_candidates SET status=? WHERE id IN (${marks}) AND status='pending'`)
    .run(status, ...list);
  return Number(info.changes || 0);
}

/* ---------- 关键词检索（给对话 LLM 的工具用；只回少量命中，不透传全库） ---------- */

