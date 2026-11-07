/** 从 WRX Companion 的显式 schema 提取基础字段；仅创建新表，不搬运旧私人数据库。 */
import { SYSTEM_DDL } from '../system_memory/schema.js';

export function initializeBaseSchema(db, config = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS characters(id TEXT PRIMARY KEY, document TEXT NOT NULL,
      wrx_enabled INTEGER NOT NULL DEFAULT 0, wrx_preset_id TEXT NOT NULL DEFAULT '', wrx_settings TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS conversations(
      id TEXT PRIMARY KEY, character_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
      agent_preset TEXT, timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai', heartbeat TEXT NOT NULL DEFAULT '', next_heartbeat_at TEXT);
    CREATE TABLE IF NOT EXISTS messages(
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      conversation_id TEXT NOT NULL, request_id TEXT, role TEXT NOT NULL, document TEXT NOT NULL, origin_id TEXT);
    CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,sequence);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS diaries(
      memory_id TEXT PRIMARY KEY, character_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('character','conversation')), content TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '[]',
      injection_mode TEXT NOT NULL CHECK(injection_mode IN ('hot','pending','cold','freeze')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, diary_date TEXT,
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai', entry_type TEXT NOT NULL DEFAULT 'daily_summary',
      title TEXT NOT NULL DEFAULT '', unresolved_hooks TEXT NOT NULL DEFAULT '[]', vector BLOB,
      vector_signature TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS diaries_scope ON diaries(character_id,conversation_id);
    CREATE TABLE IF NOT EXISTS ai_notes(
      memory_id TEXT PRIMARY KEY, character_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('character','conversation')), content TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '[]',
      injection_mode TEXT NOT NULL CHECK(injection_mode IN ('hot','pending','cold','freeze')),
      occurred_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, activity_id TEXT,
      activity_type TEXT NOT NULL DEFAULT '', activity_content TEXT NOT NULL DEFAULT '',
      execution_result TEXT NOT NULL DEFAULT '{}', note_status TEXT NOT NULL DEFAULT 'pending',
      note_error TEXT NOT NULL DEFAULT '', vector BLOB, vector_signature TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS ai_notes_scope ON ai_notes(character_id,conversation_id);
    CREATE TABLE IF NOT EXISTS event_tags(tag_id TEXT PRIMARY KEY, character_id TEXT NOT NULL,
      name TEXT NOT NULL, UNIQUE(character_id,name));
    CREATE TABLE IF NOT EXISTS diary_event_tags(diary_id TEXT NOT NULL,tag_id TEXT NOT NULL,
      PRIMARY KEY(diary_id,tag_id));
  `);
  db.exec(SYSTEM_DDL);
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_summary_chat_sources(
      batch_id TEXT NOT NULL, chat_log_id INTEGER NOT NULL,
      PRIMARY KEY(batch_id,chat_log_id));
    CREATE INDEX IF NOT EXISTS summary_chat_source_row ON system_summary_chat_sources(chat_log_id,batch_id);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS wrx_preset_bindings(preset_id TEXT PRIMARY KEY,character_id TEXT NOT NULL REFERENCES characters(id));
    CREATE UNIQUE INDEX IF NOT EXISTS characters_wrx_preset_unique ON characters(wrx_preset_id) WHERE wrx_preset_id <> '';
    CREATE INDEX IF NOT EXISTS conversations_character ON conversations(character_id,id);
  `);
  db.prepare('INSERT OR IGNORE INTO characters(id,document) VALUES (?,?)').run('default',JSON.stringify({name:'Default'}));
  // 全新安装只初始化明确配置的角色，不读取或猜测开发者原有角色资料。
  for (const id of (config.dshCharacters || ['dsh']).slice(0, 1)) {
    if (typeof id !== 'string' || !id.trim()) continue;
    db.prepare('INSERT OR IGNORE INTO characters(id,document) VALUES (?,?)')
      .run(id, JSON.stringify({ name: '助手', user_name: config.user?.name || '用户' }));
  }
}
