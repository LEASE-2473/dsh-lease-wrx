/** 按功能拆分的兼容仓储；字段协议对照 WRX Companion，DSH 新增行为保留。 */
import { openDb } from './database.js';
import { uid } from './utilities.js';
import { TABLES } from '../system_memory/schema.js';
const KIND_BY_TABLE = Object.fromEntries(Object.entries(TABLES).map(([k,v]) => [v,k]));

const VECTOR_TEXT = {
  summary: (r) => String(r.content || '').trim() + (r.tag ? '（' + r.tag + '）' : ''),
  person: (r) => ['[人物] ' + (r.name || ''), r.relationship, r.history, r.impression].filter(Boolean).join('；'),
  item: (r) => ['[物品] ' + (r.name || ''), r.description, r.location].filter(Boolean).join('；'),
  agreement: (r) => '[约定] ' + (r.content || ''),
  // 日记 / 外出记录转冷后要靠向量召回，不能关进小黑屋。
  diary: (r) => '[日记 ' + (r.diary_date || '') + '] ' + (r.title || '') + '：' + String(r.content || ''),
  activity: (r) => '[外出 ' + (r.activity_type || '') + '] ' + String(r.activity_content || r.content || ''),
};

/** 一行记忆拿去算向量的文本（跟 Tavily/温柔乡一致：拼成一句可读的话）。 */
export function vectorText(kind, row) {
  if (row?.injection_mode === 'freeze' || row?.mode === 'freeze') return '';
  const fn = VECTOR_TEXT[kind];
  return fn ? String(fn(row) || '').trim() : '';
}

function decodeVector(blob) {
  if (!blob) return null;
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (!bytes.byteLength || bytes.byteLength % 8) return null;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const result = Array.from(new Float64Array(copy.buffer));
  return result.every(Number.isFinite) ? result : null;
}

/** 还没有向量的行（含冷记录），补向量用。日记和外出记录也算在内。 */
export function rowsMissingVector(characterId) {
  const d = openDb();
  const out = [];
  for (const kind of Object.keys(TABLES)) {
    const rows = d.prepare('SELECT * FROM ' + TABLES[kind] + " WHERE character_id=? AND mode <> 'freeze' AND vector IS NULL ORDER BY sequence").all(characterId);
    for (const row of rows) {
      const text = vectorText(kind, row);
      if (text) out.push({ id: kind + ':' + row.sequence, kind, text });
    }
  }
  // 日记 / 外出记录：id 用 memory_id（uid，不含冒号），跟四表的 sequence 区分开。
  for (const [kind, table, order] of [['diary', 'diaries', 'diary_date'], ['activity', 'ai_notes', 'COALESCE(occurred_at,created_at)']]) {
    const rows = d.prepare('SELECT * FROM ' + table + " WHERE character_id=? AND vector IS NULL AND injection_mode <> 'freeze' ORDER BY " + order + ' DESC').all(characterId);
    for (const row of rows) {
      const text = vectorText(kind, row);
      if (text && row.memory_id) out.push({ id: kind + ':' + row.memory_id, kind, text });
    }
  }
  return out;
}

export function saveVector(characterId, id, vector, signature = '') {
  const [kind, key] = String(id).split(':');
  if (!Array.isArray(vector) || !vector.length) throw new Error('向量为空');
  if (vector.some(v => typeof v !== 'number' || !Number.isFinite(v)) || !vector.some(v => v !== 0)) throw new Error('向量必须是非零有限数值数组');
  const values = new Float64Array(vector);
  const blob = new Uint8Array(values.buffer);
  const sig = String(signature || '');
  // 日记 / 外出记录按 memory_id 定位，四表按 sequence 定位。
  if (kind === 'diary' || kind === 'activity') {
    if (!key) throw new Error('无效记忆 id：' + id);
    const table = kind === 'diary' ? 'diaries' : 'ai_notes';
    // 状态在 embedding 请求期间可能改成 freeze；用同一条 UPDATE 的谓词防止迟到结果写回。
    return openDb().prepare('UPDATE ' + table + " SET vector=?,vector_signature=? WHERE memory_id=? AND character_id=? AND injection_mode <> 'freeze'").run(blob, sig, key, characterId).changes;
  }
  const seq = Number(key);
  if (!TABLES[kind] || !Number.isInteger(seq) || seq < 1) throw new Error('无效记忆 id：' + id);
  const info = openDb()
    .prepare('UPDATE ' + TABLES[kind] + " SET vector=?,vector_signature=? WHERE sequence=? AND character_id=? AND mode <> 'freeze'")
    .run(blob, sig, seq, characterId);
  return info.changes;
}

/** 已经有向量、并且已经是「冷」的行，召回候选。热记忆走上下文注入，不在这里重复出现。 */
export function rowsWithVector(characterId) {
  const d = openDb();
  const out = [];
  for (const kind of Object.keys(TABLES)) {
    const rows = d.prepare('SELECT * FROM ' + TABLES[kind] + " WHERE character_id=? AND mode='cold' AND vector IS NOT NULL ORDER BY sequence").all(characterId);
    for (const row of rows) {
      const vector = decodeVector(row.vector);
      if (!vector) continue;
      out.push({ ...row, kind, id: kind + ':' + row.sequence, vector, text: vectorText(kind, row) });
    }
  }
  for (const [kind, table, order] of [['diary', 'diaries', 'diary_date'], ['activity', 'ai_notes', 'COALESCE(occurred_at,created_at)']]) {
    const rows = d.prepare('SELECT * FROM ' + table + " WHERE character_id=? AND injection_mode='cold' AND vector IS NOT NULL ORDER BY " + order + ' DESC').all(characterId);
    for (const row of rows) {
      const vector = decodeVector(row.vector);
      if (!vector || !row.memory_id) continue;
      out.push({ ...row, kind, id: kind + ':' + row.memory_id, vector, text: vectorText(kind, row) });
    }
  }
  return out;
}

