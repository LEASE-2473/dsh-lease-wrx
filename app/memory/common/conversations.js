/** 按功能拆分的兼容仓储；字段协议对照 WRX Companion，DSH 新增行为保留。 */
import { openDb } from './database.js';
import { plainDialogue } from './utilities.js';

export function conversations(characterId) {
  const d = openDb();
  const rows = characterId
    ? d.prepare('SELECT id,name,timezone,character_id FROM conversations WHERE character_id=? ORDER BY created_at').all(characterId)
    : d.prepare('SELECT id,name,timezone,character_id FROM conversations ORDER BY created_at').all();
  return rows;
}

export function readMessages(characterId, start, end) {
  const d = openDb();
  const rows = d.prepare(
    'SELECT m.id,m.sequence,m.role,m.document,m.origin_id,c.timezone,c.character_id,c.id AS cid FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.character_id=? ORDER BY m.sequence',
  ).all(characterId);
  const from = new Date(start).getTime();
  const to = new Date(end).getTime();
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (r.role !== 'user' && r.role !== 'assistant') continue;
    let doc;
    try { doc = JSON.parse(r.document); } catch { continue; }
    if (!doc.timestamp) continue;
    const t = new Date(doc.timestamp).getTime();
    if (!(t >= from && t < to)) continue;
    const content = plainDialogue(doc.content);
    if (!content) continue;
    const key = (r.origin_id || r.id) + '|' + r.role + '|' + content;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: r.id, role: r.role, time: doc.timestamp, content, timezone: r.timezone, conversationId: r.cid });
  }
  return out;
}

