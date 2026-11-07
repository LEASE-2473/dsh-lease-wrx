import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { initializeBaseSchema } from './schema.js';
import { loadConfig } from '../../common/config.js';
import { TABLES } from '../system_memory/schema.js';

let db = null;
let dbPath = null;

// 日记 / 外出记录也要进向量召回：这两张表是老 schema，没有 vector 列，开库时补上。
// 冷 = 可召回，不能有「转冷了却永远发不出去」的死记忆。
const VECTOR_COLUMNS = [
  ['diaries', 'vector', 'BLOB'],
  ['diaries', 'vector_signature', "TEXT NOT NULL DEFAULT ''"],
  ['ai_notes', 'vector', 'BLOB'],
  ['ai_notes', 'vector_signature', "TEXT NOT NULL DEFAULT ''"],
];

function ensureVectorColumns(d) {
  for (const [table, column, type] of VECTOR_COLUMNS) {
    try {
      const cols = d.prepare('PRAGMA table_info(' + table + ')').all().map((c) => c.name);
      if (!cols.includes(column)) d.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + type);
    } catch { /* 表不存在就跳过 */ }
  }
}

// 注入状态写进 injection_mode：hot（热，每轮注入）/ pending（转冷中，正在向量化）/ cold（冷，向量召回）/
// freeze（冻结，不注入不召回，只能用工具自己查）。这两张老表原来的 CHECK 只认 auto/hot/cold，
// 开库时按原结构重建一次；老的 auto 一律并成 hot。
const COLD_STATE_TABLES = [
  {
    name: 'diaries',
    create: `CREATE TABLE diaries(memory_id TEXT PRIMARY KEY, character_id TEXT NOT NULL, conversation_id TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('character','conversation')), content TEXT NOT NULL, keywords TEXT NOT NULL DEFAULT '[]', injection_mode TEXT NOT NULL CHECK(injection_mode IN ('hot','pending','cold','freeze')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,diary_date TEXT, timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai', entry_type TEXT NOT NULL DEFAULT 'daily_summary', title TEXT NOT NULL DEFAULT '', unresolved_hooks TEXT NOT NULL DEFAULT '[]', vector BLOB, vector_signature TEXT NOT NULL DEFAULT '')`,
    columns: 'memory_id,character_id,conversation_id,scope,content,keywords,injection_mode,created_at,updated_at,diary_date,timezone,entry_type,title,unresolved_hooks,vector,vector_signature',
    select: "memory_id,character_id,conversation_id,scope,content,keywords,CASE WHEN injection_mode='auto' THEN 'hot' ELSE injection_mode END,created_at,updated_at,diary_date,timezone,entry_type,title,unresolved_hooks,vector,vector_signature",
    index: 'CREATE INDEX IF NOT EXISTS diaries_scope ON diaries(character_id,conversation_id)',
  },
  {
    name: 'ai_notes',
    create: `CREATE TABLE ai_notes(memory_id TEXT PRIMARY KEY, character_id TEXT NOT NULL, conversation_id TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('character','conversation')), content TEXT NOT NULL, keywords TEXT NOT NULL DEFAULT '[]', injection_mode TEXT NOT NULL CHECK(injection_mode IN ('hot','pending','cold','freeze')), occurred_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,activity_id TEXT, activity_type TEXT NOT NULL DEFAULT '', activity_content TEXT NOT NULL DEFAULT '', execution_result TEXT NOT NULL DEFAULT '{}', note_status TEXT NOT NULL DEFAULT 'pending', note_error TEXT NOT NULL DEFAULT '', vector BLOB, vector_signature TEXT NOT NULL DEFAULT '')`,
    columns: 'memory_id,character_id,conversation_id,scope,content,keywords,injection_mode,occurred_at,created_at,updated_at,activity_id,activity_type,activity_content,execution_result,note_status,note_error,vector,vector_signature',
    select: "memory_id,character_id,conversation_id,scope,content,keywords,CASE WHEN injection_mode='auto' THEN 'hot' ELSE injection_mode END,occurred_at,created_at,updated_at,activity_id,activity_type,activity_content,execution_result,note_status,note_error,vector,vector_signature",
    index: 'CREATE INDEX IF NOT EXISTS ai_notes_scope ON ai_notes(character_id,conversation_id)',
  },
];

function migrateColdState(d) {
  for (const t of COLD_STATE_TABLES) {
    const row = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t.name);
    if (!row?.sql) continue;
    if (row.sql.includes("injection_mode IN ('hot','pending','cold','freeze')")) continue;
    d.exec('BEGIN IMMEDIATE');
    try {
      d.exec('ALTER TABLE ' + t.name + ' RENAME TO ' + t.name + '_old_coldstate');
      d.exec(t.create);
      // 老的 auto 就是「热」，统一并成 hot；老表 CHECK 可能不认 hot，所以在 SELECT 里转。
      d.exec('INSERT INTO ' + t.name + '(' + t.columns + ') SELECT ' + t.select + ' FROM ' + t.name + '_old_coldstate');
      d.exec('DROP TABLE ' + t.name + '_old_coldstate');
      d.exec(t.index);
      d.exec('COMMIT');
    } catch (error) {
      try { d.exec('ROLLBACK'); } catch { /* noop */ }
      throw error;
    }
  }
}

function migrateSystemFreeze(d) {
  d.exec('BEGIN IMMEDIATE');
  try {
    for (const table of Object.values(TABLES)) {
      const schema = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
      if (!schema || /'freeze'/.test(schema)) continue;
      const create = schema.replace(/CHECK\s*\(\s*mode\s+IN\s*\(\s*'hot'\s*,\s*'cold'\s*\)\s*\)/i, "CHECK(mode IN ('hot','cold','freeze'))");
      if (create === schema) throw new Error('无法安全识别四表状态约束：' + table);
      const columns = d.prepare('PRAGMA table_xinfo(' + table + ')').all().filter(column => column.hidden === 0).map(column => '"' + column.name.replaceAll('"', '""') + '"').join(',');
      const objects = d.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL").all(table);
      const sequence = d.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(table)?.seq;
      d.exec('ALTER TABLE ' + table + ' RENAME TO ' + table + '_before_freeze');
      d.exec(create);
      d.exec('INSERT INTO ' + table + '(' + columns + ') SELECT ' + columns + ' FROM ' + table + '_before_freeze');
      d.exec('DROP TABLE ' + table + '_before_freeze');
      for (const object of objects) d.exec(object.sql);
      if (sequence != null) {
        const changed = d.prepare('UPDATE sqlite_sequence SET seq=? WHERE name=?').run(sequence, table).changes;
        if (!changed) d.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)').run(table, sequence);
      }
    }
    d.exec('COMMIT');
  } catch (error) {
    d.exec('ROLLBACK');
    throw error;
  }
}

export function openDb() {
  const cfg = loadConfig();
  if (db && dbPath === cfg.dbPath) return db;
  closeDb();
  mkdirSync(dirname(cfg.dbPath), { recursive: true });
  db = new DatabaseSync(cfg.dbPath);
  dbPath = cfg.dbPath;
  try {
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('PRAGMA journal_mode=WAL');
  } catch { /* 只读介质等场景忽略 */ }
  try {
    // 本次按全新安装开发；既有库迁移留给下一阶段，不隐式重建角色表。
    for (const [table, column] of [['characters','wrx_enabled'], ['conversations','agent_preset']]) {
      const columns = db.prepare('PRAGMA table_info(' + table + ')').all();
      if (columns.length && !columns.some(item => item.name === column)) throw new Error('当前数据库需要多角色结构迁移，请使用新数据目录；旧库迁移尚未实施：' + table);
    }
    initializeBaseSchema(db, cfg);
    ensureVectorColumns(db);
    migrateColdState(db);
    migrateSystemFreeze(db);
  } catch (error) {
    closeDb();
    throw error;
  }
  return db;
}

export function closeDb() {
  if (db) {
    try { db.close(); } catch { /* noop */ }
  }
  db = null;
  dbPath = null;
}

