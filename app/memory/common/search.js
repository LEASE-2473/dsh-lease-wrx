/** 按功能拆分的兼容仓储；字段协议对照 WRX Companion，DSH 新增行为保留。 */
import { openDb } from './database.js';

const SEARCH_SOURCES = [
  { table: 'system_summary', kind: 'summary', expr: "content || ' ' || tag" },
  { table: 'system_people', kind: 'person', expr: "name || '：' || relationship || ' ' || history || ' ' || impression" },
  { table: 'system_items', kind: 'item', expr: "name || '：' || description || ' ' || location" },
  { table: 'system_agreements', kind: 'agreement', expr: 'content' },
];

export function searchMemories(characterId, query, limit = 3) {
  const q = String(query || '').trim();
  if (!q) return [];
  const terms = q.split(/[\s,，、;；|/]+/).filter((t) => t.length >= 2).slice(0, 4);
  if (!terms.length) return [];
  const max = Math.max(1, Math.min(5, Number(limit) || 3));
  const d = openDb();
  const out = [];
  for (const src of SEARCH_SOURCES) {
    if (out.length >= max) break;
    const where = terms.map(() => `(${src.expr}) LIKE ?`).join(' AND ');
    const rows = d
      .prepare(`SELECT sequence AS id,(${src.expr}) AS text FROM ${src.table} WHERE character_id=? AND mode <> 'freeze' AND ${where} LIMIT ?`)
      .all(characterId, ...terms.map((t) => '%' + t + '%'), max);
    for (const row of rows) {
      if (out.length >= max) break;
      out.push({ kind: src.kind, id: row.id, text: String(row.text || '').replace(/\s+/g, ' ').trim() });
    }
  }
  return out;
}

/* ---------- 用户信息 ---------- */

