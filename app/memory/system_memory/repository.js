/** 按功能拆分的兼容仓储；字段协议对照 WRX Companion，DSH 新增行为保留。 */
import { openDb } from '../common/database.js';
import { nowIso } from '../common/utilities.js';
import { conversations } from '../common/conversations.js';
import { loadConfig } from '../../common/config.js';
import { TABLES, FIELDS } from './schema.js';
import { snapshotState, validateInitial, validateOptimized, validateRecall } from './protocol.js';
const KIND_BY_TABLE = Object.fromEntries(Object.entries(TABLES).map(([k,v]) => [v,k]));

function decode(kind, row) {
  const { vector, ...rest } = row;
  return {
    ...rest,
    kind,
    id: kind + ':' + row.sequence,
    mode: row.mode || 'hot',
    vectorized: Boolean(row.vectorized),
    hasVector: Boolean(vector),
  };
}

export function listRows(characterId, kind) {
  const d = openDb();
  const kinds = kind ? [kind] : Object.keys(TABLES);
  const out = [];
  for (const k of kinds) {
    if (!TABLES[k]) throw new Error('未知记忆表：' + k);
    const rows = characterId
      ? d.prepare('SELECT * FROM ' + TABLES[k] + ' WHERE character_id=? ORDER BY range_start,sequence').all(characterId)
      : d.prepare('SELECT * FROM ' + TABLES[k] + ' ORDER BY range_start,sequence').all();
    for (const r of rows) out.push(decode(k, r));
  }
  out.sort((a, b) => String(a.range_start).localeCompare(String(b.range_start)) || String(a.kind).localeCompare(String(b.kind)) || a.sequence - b.sequence);
  return out;
}

export function counts(characterId) {
  const d = openDb();
  const result = { summary: 0, person: 0, item: 0, agreement: 0, cold: 0 };
  for (const [kind, table] of Object.entries(TABLES)) {
    const where = characterId ? ' WHERE character_id=?' : '';
    const args = characterId ? [characterId] : [];
    const row = d.prepare('SELECT COUNT(*) c, SUM(CASE WHEN mode=\'cold\' THEN 1 ELSE 0 END) cold FROM ' + table + where).get(...args);
    result[kind] = row.c;
    result.cold += row.cold || 0;
  }
  return result;
}

export function rowById(characterId, id) {
  const [kind, seqText] = String(id).split(':');
  const seq = Number(seqText);
  if (!TABLES[kind] || !Number.isInteger(seq) || seq < 1) throw new Error('无效记忆 id：' + id);
  const row = openDb().prepare('SELECT * FROM ' + TABLES[kind] + ' WHERE sequence=? AND character_id=?').get(seq, characterId);
  return row ? decode(kind, row) : null;
}

function cleanFields(kind, input, { requireName = true } = {}) {
  const out = {};
  for (const f of FIELDS[kind]) {
    const v = input?.[f];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') throw new Error(f + ' 必须是字符串');
    const t = v.trim();
    if (f === 'name' && requireName && !t) throw new Error('名称不能为空');
    if (f === 'content' && kind === 'summary' && !t) throw new Error('概要正文不能为空');
    if (t) out[f] = t;
  }
  return out;
}

export function updateRow(characterId, id, input, { replaceHistory = false } = {}) {
  const [kind, seqText] = String(id).split(':');
  const seq = Number(seqText);
  if (!TABLES[kind]) throw new Error('无效记忆 id：' + id);
  const d = openDb();
  const old = d.prepare('SELECT * FROM ' + TABLES[kind] + ' WHERE sequence=? AND character_id=?').get(seq, characterId);
  if (!old) throw new Error('记录不存在');
  if (old.mode === 'freeze') throw new Error('冻结记录需先显式解除冻结再编辑');
  const fields = cleanFields(kind, input, { requireName: false });
  if (Object.keys(fields).length === 0) throw new Error('没有可更新的字段');
  delete fields.name;
  if (fields.history && !replaceHistory) {
    fields.history = old.history && !old.history.includes(fields.history) ? old.history + '\n' + fields.history : (old.history || fields.history);
  }
  const keys = Object.keys(fields);
  // 内容变了向量就作废；按原版规则顺手放回热区，否则会留下「冷但没有向量」的死条目。
  const sql = 'UPDATE ' + TABLES[kind] + ' SET ' + keys.map((k) => k + '=?').join(',') + ",mode='hot',vector=NULL,vector_signature='' WHERE sequence=? AND character_id=?";
  d.prepare(sql).run(...keys.map((k) => fields[k]), seq, characterId);
  return rowById(characterId, id);
}

export function insertRow(characterId, kind, fields, { conversationId, start, end, mode = 'hot' } = {}) {
  if (!TABLES[kind]) throw new Error('未知记忆表');
  const clean = cleanFields(kind, fields);
  if (!clean.name && (kind === 'person' || kind === 'item')) throw new Error('名称不能为空');
  if (!clean.content && (kind === 'summary' || kind === 'agreement')) throw new Error('正文不能为空');
  const d = openDb();
  const cfg = loadConfig();
  const isDsh = Array.isArray(cfg.dshCharacters) && cfg.dshCharacters.includes(characterId);
  // 同一个坑：DSH 角色没有 conversations 行，管理页手动加记忆时也会在这里被拦。
  const cid = conversationId || conversations(characterId)[0]?.id || (isDsh ? 'dsh-session' : null);
  if (!cid) throw new Error('该角色没有可用会话');  const cols = ['character_id', 'conversation_id', 'range_start', 'range_end', ...Object.keys(clean), 'mode'];
  const vals = [characterId, cid, start || nowIso(), end || nowIso(), ...Object.values(clean), mode];
  const info = d.prepare('INSERT INTO ' + TABLES[kind] + ' (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')').run(...vals);
  return rowById(characterId, kind + ':' + Number(info.lastInsertRowid));
}

export function deleteRow(characterId, id) {
  const [kind, seqText] = String(id).split(':');
  const seq = Number(seqText);
  if (!TABLES[kind]) throw new Error('无效记忆 id');
  const info = openDb().prepare('DELETE FROM ' + TABLES[kind] + ' WHERE sequence=? AND character_id=?').run(seq, characterId);
  return { deleted: info.changes };
}

export function setMode(characterId, id, mode, { vectorEnabled } = {}) {
  if (!['hot', 'cold', 'freeze'].includes(mode)) throw new Error('无效记忆状态');
  if (mode === 'cold' && !vectorEnabled) throw new Error('向量记忆未启用，暂不能转冷（先用热记忆）');
  const [kind, seqText] = String(id).split(':');
  const seq = Number(seqText);
  if (!TABLES[kind]) throw new Error('无效记忆 id');
  // 冷热只决定「怎么注入」，不决定「有没有向量」：
  // 转冷清掉向量等于把这条记忆从召回里抹掉，所以这里只改 mode。
  openDb().prepare('UPDATE ' + TABLES[kind] + ' SET mode=? WHERE sequence=? AND character_id=?').run(mode, seq, characterId);
  return rowById(characterId, id);
}

/* ---------- 向量化（冷记忆召回用） ---------- */

export function existingPayload(characterId, snapshot = listRows(characterId)) {
  return snapshot.filter((r) => r.mode === 'hot').map((r) => {
    const item = { id: r.id };
    for (const f of FIELDS[r.kind]) if (r[f]) item[f] = r[f];
    return item;
  });
}

export function memoryIndex(characterId, snapshot = listRows(characterId)) {
  const out = { people: [], items: [] };
  for (const kind of ['person', 'item']) {
    for (const r of snapshot.filter(row => row.kind === kind)) {
      if (r.mode === 'cold') out[kind === 'person' ? 'people' : 'items'].push({ id: r.id, name: r.name, ...(kind === 'person' ? { relationship: r.relationship } : {}) });
    }
  }
  return out;
}

export function queriedRecords(characterId, wanted, snapshot = listRows(characterId)) {
  const out = { people: [], items: [] };
  for (const [key, kind] of [['people', 'person'], ['items', 'item']]) {
    for (const item of wanted?.[key] || []) {
      const row = snapshot.find(row => row.id === item?.id);
      if (!row || row.mode !== 'cold') continue;
      const rec = { id: row.id, name: row.name };
      for (const f of ['relationship', 'history', 'impression', 'description', 'location']) if (row[f]) rec[f] = row[f];
      out[key].push(rec);
    }
  }
  return out;
}

export function batchUpsert(row) {
  const d = openDb();
  d.prepare('INSERT OR REPLACE INTO system_memory_batches(id,character_id,conversation_id,range_start,range_end,status,error,scope) VALUES (?,?,?,?,?,?,?,?)')
    .run(row.id, row.character_id, row.conversation_id, row.range_start, row.range_end, row.status, row.error || '', 'character');
}

export function batchFind(id) {
  return openDb().prepare('SELECT * FROM system_memory_batches WHERE id=?').get(id) || null;
}

export function batches(characterId, limit = 50) {
  const d = openDb();
  return characterId
    ? d.prepare('SELECT * FROM system_memory_batches WHERE character_id=? ORDER BY range_end DESC LIMIT ?').all(characterId, limit)
    : d.prepare('SELECT * FROM system_memory_batches ORDER BY range_end DESC LIMIT ?').all(limit);
}

export function latestProcessedEnd(characterId) {
  const row = openDb().prepare("SELECT MAX(range_end) m FROM system_memory_batches WHERE character_id=? AND status IN ('done','empty')").get(characterId);
  return row?.m || null;
}

export function applyFourTables(characterId, conversationId, start, end, output, { transaction = true } = {}) {
  const d = openDb();
  const applied = { summary: 0, people: 0, items: 0, agreements: 0 };
  // 冲突的冷条目不让整批回滚：记下来，下一轮带着目录做第二次 rewrite。
  const skipped = [];
  if (transaction) d.exec('BEGIN IMMEDIATE');
  try {
    let summary = output?.summary;
    if (typeof summary === 'string') summary = { content: summary };
    const summaries = (Array.isArray(summary) ? summary : summary ? [summary] : [])
      .map((s) => (typeof s === 'string' ? { content: s } : s))
      .filter((s) => s && String(s.content || '').trim());
    for (const item of summaries) {
      const clean = {
        content: String(item.content || ''),
        tag: String(item.tag || ''),
      };
      insertRowInner(d, characterId, 'summary', clean, conversationId, start, end);
      applied.summary++;
    }
    for (const [key, kind] of [['people', 'person'], ['items', 'item']]) {
      for (const item of (Array.isArray(output?.[key]) ? output[key] : [])) {
        const fields = cleanFields(kind, item, { requireName: !item?.id });
        if (!fields.name && !item?.id) continue;
        if (item?.id) {
          const [k] = String(item.id).split(':');
          if (k !== kind) throw new Error('不能跨表更新：' + item.id);
          const seq = Number(String(item.id).split(':')[1]);
          const old = d.prepare('SELECT * FROM ' + TABLES[kind] + ' WHERE sequence=? AND character_id=?').get(seq, characterId);
          if (!old) throw new Error('要更新的记录不存在：' + item.id);
          if (old.mode !== 'hot') {
            skipped.push({ kind, id: item.id, name: old.name, reason: old.mode + '-locked' });
            continue;
          }
          delete fields.name;
          if (fields.history) {
            fields.history = old.history && !old.history.includes(fields.history) ? old.history + '\n' + fields.history : (old.history || fields.history);
          }
          const keys = Object.keys(fields);
          if (keys.length === 0) continue;
          d.prepare('UPDATE ' + TABLES[kind] + ' SET ' + keys.map((k) => k + '=?').join(',') + ',vector=NULL,vector_signature=\'\' WHERE sequence=? AND character_id=?')
            .run(...keys.map((k) => fields[k]), seq, characterId);
        } else {
          const old = d.prepare('SELECT * FROM ' + TABLES[kind] + ' WHERE character_id=? AND name=? ORDER BY sequence LIMIT 1').get(characterId, fields.name);
          if (old && old.mode === 'hot') {
            delete fields.name;
            if (fields.history) {
              fields.history = old.history && !old.history.includes(fields.history) ? old.history + '\n' + fields.history : (old.history || fields.history);
            }
            const keys = Object.keys(fields);
            if (keys.length === 0) continue;
            d.prepare('UPDATE ' + TABLES[kind] + ' SET ' + keys.map((k) => k + '=?').join(',') + ',vector=NULL,vector_signature=\'\' WHERE sequence=? AND character_id=?')
              .run(...keys.map((k) => fields[k]), old.sequence, characterId);
          } else if (!old) {
            insertRowInner(d, characterId, kind, fields, conversationId, start, end);
          } else {
            // 同名冷条目写不进去：留到第二层目录 rewrite，不要让整批失败。
            skipped.push({ kind, id: kind + ':' + old.sequence, name: old.name, reason: old.mode + '-same-name' });
          }
        }
        applied[key]++;
      }
    }
    for (const item of (Array.isArray(output?.agreements) ? output.agreements : [])) {
      const content = String(item?.content || '').trim();
      if (!content) continue;
      const exists = d.prepare('SELECT 1 FROM system_agreements WHERE character_id=? AND content=?').get(characterId, content);
      if (exists) continue;
      insertRowInner(d, characterId, 'agreement', { content }, conversationId, start, end);
      applied.agreements++;
    }
    if (transaction) d.exec('COMMIT');
  } catch (error) {
    if (transaction) { try { d.exec('ROLLBACK'); } catch { } }
    throw error;
  }
  return { ...applied, skipped };
}

function insertRowInner(d, characterId, kind, fields, conversationId, start, end) {
  const cols = ['character_id', 'conversation_id', 'range_start', 'range_end', ...Object.keys(fields), 'mode'];
  const vals = [characterId, conversationId, start, end, ...Object.values(fields), 'hot'];
  d.prepare('INSERT INTO ' + TABLES[kind] + ' (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')').run(...vals);
}

export function applyOptimizedRecords(characterId, records, { transaction = true } = {}) {
  const d = openDb();
  const applied = { people: 0, items: 0 };
  if (transaction) d.exec('BEGIN IMMEDIATE');
  try {
    for (const [key, kind] of [['people', 'person'], ['items', 'item']]) {
      for (const item of (Array.isArray(records?.[key]) ? records[key] : [])) {
        if (!item?.id) continue;
        const [k] = String(item.id).split(':');
        if (k !== kind) throw new Error('不能跨表更新：' + item.id);
        const seq = Number(String(item.id).split(':')[1]);
        const old = d.prepare('SELECT * FROM ' + TABLES[kind] + ' WHERE sequence=? AND character_id=?').get(seq, characterId);
        if (!old || old.mode === 'freeze') continue;
        const fields = {};
        for (const f of ['relationship', 'history', 'impression', 'description', 'location']) {
          if (typeof item[f] === 'string' && item[f].trim()) fields[f] = item[f].trim();
        }
        const keys = Object.keys(fields);
        if (keys.length === 0) continue;
        if (keys.every(field => old[field] === fields[field])) continue;
        d.prepare('UPDATE ' + TABLES[kind] + ' SET ' + keys.map((x) => x + '=?').join(',') + ',vector=NULL,vector_signature=\'\' WHERE sequence=? AND character_id=?')
          .run(...keys.map((x) => fields[x]), seq, characterId);
        applied[key]++;
      }
    }
    if (transaction) d.exec('COMMIT');
  } catch (error) {
    if (transaction) { try { d.exec('ROLLBACK'); } catch { } }
    throw error;
  }
  return applied;
}

export function applyMemoryBatch(characterId, conversationId, start, end, initial, updates, { snapshot, recall = {}, commit = () => {} }) {
  const d = openDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    if (JSON.stringify(snapshotState(listRows(characterId))) !== JSON.stringify(snapshotState(snapshot))) throw new Error('整理期间记忆或目录已被编辑，请重试该批次');
    validateInitial(initial, snapshot);
    validateRecall(recall, snapshot);
    const targets = new Set(Object.values(recall).flat().map(value => value.id));
    if (updates.people?.length || updates.items?.length) validateOptimized(updates, snapshot.filter(row => targets.has(row.id)));
    const applied = applyFourTables(characterId, conversationId, start, end, initial, { transaction: false });
    const appliedUpdate = applyOptimizedRecords(characterId, updates, { transaction: false });
    commit();
    d.exec('COMMIT');
    return { applied, appliedUpdate };
  } catch (error) {
    d.exec('ROLLBACK');
    throw error;
  }
}

/* ---------- 日记 ---------- */

