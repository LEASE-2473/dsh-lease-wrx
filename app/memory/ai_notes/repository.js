/** 按功能拆分的兼容仓储；字段协议对照 WRX Companion，DSH 新增行为保留。 */
import { openDb } from '../common/database.js';
import { nowIso, uid } from '../common/utilities.js';
import { conversations } from '../common/conversations.js';
import { loadConfig } from '../../common/config.js';

export function listActivity(characterId, limit = 50) {
  const d = openDb();
  const rows = characterId
    ? d.prepare('SELECT * FROM ai_notes WHERE character_id=? ORDER BY COALESCE(occurred_at,created_at) DESC LIMIT ?').all(characterId, limit)
    : d.prepare('SELECT * FROM ai_notes ORDER BY COALESCE(occurred_at,created_at) DESC LIMIT ?').all(limit);
  return rows.map((r) => ({ ...r, tags: [] }));
}

export function saveActivity(characterId, { activityType, content, activityContent, mood = '' }) {
  const d = openDb();
  const cfg = loadConfig();
  const isDsh = Array.isArray(cfg.dshCharacters) && cfg.dshCharacters.includes(characterId);
  const conv = conversations(characterId)[0] || (isDsh ? { id: 'dsh-session', timezone: cfg.timezone } : null);
  if (!conv) throw new Error('该角色没有会话');
  const id = uid();
  const at = nowIso();
  const execution = JSON.stringify({ mood });
  d.prepare('INSERT INTO ai_notes(memory_id,character_id,conversation_id,scope,content,keywords,injection_mode,occurred_at,created_at,updated_at,activity_id,activity_type,activity_content,execution_result,note_status,note_error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, characterId, conv.id, 'character', content || activityContent || '', '[]', 'hot', at, at, at, id, activityType || '', activityContent || '', execution, 'done', '');
  return id;
}

/* ---------- 转冷状态机：auto(热) → pending(转冷中) → cold(冷, 已向量化) ---------- */

// 语义（2026-10-30 LEASE 定）：冷 = 已向量化；热 = 未向量化、走上下文注入。
// 「转冷」是一个过程：先标 pending（转冷中），补上向量才落成 cold；补不上就退回 auto，别卡在半路。

