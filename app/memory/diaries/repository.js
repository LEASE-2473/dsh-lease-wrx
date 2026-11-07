/** 按功能拆分的兼容仓储；字段协议对照 WRX Companion，DSH 新增行为保留。 */
import { openDb } from '../common/database.js';
import { nowIso, uid, parseJson } from '../common/utilities.js';
import { conversations } from '../common/conversations.js';
import { loadConfig } from '../../common/config.js';

export function listDiary(characterId, limit = 60) {
  const d = openDb();
  const rows = characterId
    ? d.prepare('SELECT * FROM diaries WHERE character_id=? ORDER BY diary_date DESC LIMIT ?').all(characterId, limit)
    : d.prepare('SELECT * FROM diaries ORDER BY diary_date DESC LIMIT ?').all(limit);
  return rows.map((r) => ({
    ...r,
    tags: tagsOf(d, r.memory_id),
    unresolved_hooks: parseJson(r.unresolved_hooks, []),
  }));
}

function tagsOf(d, memoryId) {
  return d.prepare('SELECT t.name FROM event_tags t JOIN diary_event_tags x ON t.tag_id=x.tag_id WHERE x.diary_id=? ORDER BY t.name').all(memoryId).map((r) => r.name);
}

export function saveDiary(characterId, { date, title, content, tags = [], hooks = [], entryType = 'daily_summary', conversationId, scope = 'character', timezone }, { transaction = true } = {}) {
  const d = openDb();
  const cfg = loadConfig();
  const isDsh = Array.isArray(cfg.dshCharacters) && cfg.dshCharacters.includes(characterId);
  // DSH 角色在本插件里没有温柔乡那种 conversations 行（它用 DSH 自己的 session），
  // 所以存日记/活动时用虚拟会话 dsh-session 记账，别再因为“没有会话”把整篇日记丢掉。
  const conv = conversationId ? { id: conversationId } : conversations(characterId)[0] || (isDsh ? { id: 'dsh-session', timezone: cfg.timezone } : null);
  if (!conv) throw new Error('该角色没有会话');
  if (!['character', 'conversation'].includes(scope)) throw new Error('日记 scope 无效');
  const kind = entryType === 'chat_entry' ? 'chat_entry' : 'daily_summary';
  const id = uid();
  if (transaction) d.exec('BEGIN IMMEDIATE');
  try {
    // 后台每天那篇是「当天总结」，同一天同角色只留最新一份；
    // 聊天时自己写的 chat_entry 不覆盖、不删，一天可以写多篇。
    if (kind === 'daily_summary') {
      d.prepare("DELETE FROM diaries WHERE character_id=? AND diary_date=? AND entry_type='daily_summary' AND injection_mode <> 'freeze'").run(characterId, date);
    }
    d.prepare('INSERT INTO diaries(memory_id,character_id,conversation_id,scope,content,keywords,injection_mode,created_at,updated_at,diary_date,timezone,entry_type,title,unresolved_hooks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, characterId, conv.id, scope, content, '[]', 'hot', nowIso(), nowIso(), date, timezone || cfg.timezone || 'Asia/Shanghai', kind, title || '', JSON.stringify(hooks));
    for (const tag of tags) {
      const name = String(tag).trim();
      if (!name) continue;
      let row = d.prepare('SELECT tag_id FROM event_tags WHERE character_id=? AND name=?').get(characterId, name);
      if (!row) {
        const tid = uid();
        d.prepare('INSERT INTO event_tags(tag_id,character_id,name) VALUES (?,?,?)').run(tid, characterId, name);
        row = { tag_id: tid };
      }
      d.prepare('INSERT OR IGNORE INTO diary_event_tags(diary_id,tag_id) VALUES (?,?)').run(id, row.tag_id);
    }
    if (transaction) d.exec('COMMIT');
  } catch (error) {
    if (transaction) { try { d.exec('ROLLBACK'); } catch {} }
    throw error;
  }
  return id;
}

/* ---------- 活动（主动外出报告） ---------- */

export function hasDiary(characterId, date) {
  // 只看「自动日记」（entry_type='daily_summary'）：手动写的 chat_entry 一天可以有很多篇，
  // 不能因为它存在就挡住后台每天那篇自动日记（2026-10-26 LEASE 定的口径）。
  const row = openDb()
    .prepare("SELECT 1 FROM diaries WHERE character_id=? AND diary_date=? AND entry_type='daily_summary' LIMIT 1")
    .get(characterId, date);
  return Boolean(row);
}

/* ---------- 用户画像候选（聊天 LLM 只能提交候选，正式画像由每日任务统一审） ---------- */

export function recordDiaryAttempt(characterId, date, status, error = '') {
  const d = openDb();
  d.prepare(
    'INSERT INTO system_diary_jobs(character_id,diary_date,status,error,attempts,updated_at) VALUES (?,?,?,?,1,?) '
    + 'ON CONFLICT(character_id,diary_date) DO UPDATE SET status=excluded.status,error=excluded.error,'
    + 'attempts=system_diary_jobs.attempts+1,updated_at=excluded.updated_at',
  ).run(characterId, String(date), status, String(error || '').slice(0, 1000), nowIso());
  return getDiaryJob(characterId, date);
}

export function getDiaryJob(characterId, date) {
  return openDb().prepare('SELECT * FROM system_diary_jobs WHERE character_id=? AND diary_date=?').get(characterId, String(date)) || null;
}

export function listDiaryJobs(characterId, limit = 20) {
  return openDb().prepare('SELECT * FROM system_diary_jobs WHERE character_id=? ORDER BY updated_at DESC LIMIT ?').all(characterId, limit);
}

/* ---------- 跨会话对话流水（只存 session_id / role / 时间 / 原文） ---------- */

