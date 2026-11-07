import { createHash } from 'node:crypto';
import { loadConfig } from '../../common/config.js';
import { complete } from '../../providers/llm.js';
import { characters } from '../../profile/assistant/information.js';
import { readChatLog } from '../common/chat_log.js';
import { readMessages, conversations } from '../common/conversations.js';
import { openDb } from '../common/database.js';
import { plainDialogue } from '../common/utilities.js';
import { saveDiary } from './repository.js';
import { diaryTimeWindow } from './time.js';

function validateOutput(raw) {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.content !== 'string' || !value.content.trim() || value.content.length > 100000) throw new Error('日记模型必须返回含非空 content 的 JSON 对象，正文最多100000字');
  if (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 120)) throw new Error('日记标题必须是最多120字的字符串');
  const tags = value.tags ?? [], hooks = value.unresolved_hooks ?? [];
  if (!Array.isArray(tags) || tags.length > 20 || tags.some(tag => typeof tag !== 'string' || !tag.trim())) throw new Error('日记标签必须是最多20条非空字符串');
  if (!Array.isArray(hooks) || hooks.length > 10 || hooks.some(hook => typeof hook !== 'string' || !hook.trim() || hook.length > 300)) throw new Error('未结话题必须是最多10条、每条最多300字的非空字符串数组');
  return { content: value.content, title: value.title ?? '', tags, unresolved_hooks: hooks };
}

const overflow = error => /context_length_exceeded|context window.{0,40}(exceed|limit|too)|maximum context length|too many tokens|input.{0,30}tokens.{0,30}(exceed|limit)|上下文.{0,15}(超限|超过)/i.test(String(error?.message ?? error));

export async function generateInstantDiary(ctx, { character, sessionId, date, startTime = '00:00', endTime = '24:00', scope = 'conversation' }) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('即时日记需要 sessionId');
  if (!['character', 'conversation'].includes(scope)) throw new Error('即时日记 scope 必须是 character 或 conversation');
  const cfg = loadConfig();
  const char = characters().find(item => item.id === character);
  if (!char) throw new Error('角色不存在');
  const isDsh = cfg.dshCharacters?.includes(character);
  const conv = isDsh ? null : conversations(character).find(item => item.id === sessionId);
  if (!isDsh && !conv) throw new Error('角色与会话不匹配');
  const timezone = conv?.timezone || cfg.timezone || 'Asia/Shanghai';
  const { start, end } = diaryTimeWindow(date, timezone, startTime, endTime);
  const selected = (isDsh ? readChatLog(start, end, character) : readMessages(character, start, end)).filter(item => scope === 'character' || (item.sessionId ?? item.conversationId) === sessionId).map(item => ({ ...item, content: plainDialogue(item.content) })).filter(item => item.content);
  const messages = selected.filter(item => ['user', 'assistant'].includes(item.role) && String(item.content ?? '').trim()).map(item => ({ time: item.time, role: item.role, content: String(item.content) }));
  if (!messages.length) return { status: 'empty', record_ids: [], start, end };
  const selection = createHash('sha256').update(JSON.stringify([character, sessionId, scope, start, end, selected.map(item => [item.chatLogId ?? item.id, item.role, item.time, item.content])])).digest('hex');
  const db = openDb();
  db.exec('CREATE TABLE IF NOT EXISTS diary_instant_jobs(id TEXT PRIMARY KEY,status TEXT NOT NULL,record_id TEXT,error TEXT NOT NULL DEFAULT \'\',updated_at TEXT NOT NULL)');
  const old = db.prepare('SELECT * FROM diary_instant_jobs WHERE id=?').get(selection);
  const claimed = db.prepare("INSERT INTO diary_instant_jobs(id,status,updated_at) VALUES (?,'running',?) ON CONFLICT(id) DO UPDATE SET status='running',error='',updated_at=excluded.updated_at WHERE diary_instant_jobs.status='error' OR (diary_instant_jobs.status='running' AND diary_instant_jobs.updated_at < ?)").run(selection, new Date().toISOString(), new Date(Date.now() - 3600000).toISOString());
  if (!claimed.changes) return { status: 'already_processed', record_ids: old?.record_id ? [old.record_id] : [], start, end };
  let calls = 0;
  const run = async (items, merge = false) => {
    if (++calls > 64) throw new Error('日记分段调用超过64次，未保存半成品');
    db.prepare('UPDATE diary_instant_jobs SET updated_at=? WHERE id=?').run(new Date().toISOString(), selection);
    const prompt = loadConfig().prompts[merge ? 'diaryMerge' : 'diaryInstant'].replaceAll('{{user}}', cfg.user?.name || '用户');
    try {
      return validateOutput(await complete(ctx, cfg, { system: prompt, messages: [{ role: 'user', text: JSON.stringify({ range: `${start} 至 ${end}（含开始，不含结束）`, date, timezone, character: { name: char.name }, messages: items }) }], maxTokens: 0 }));
    } catch (error) {
      if (!overflow(error)) throw error;
    }
    let halves;
    if (items.length > 1) { const middle = Math.floor(items.length / 2); halves = [items.slice(0, middle), items.slice(middle)]; }
    else if (items[0]?.content.length > 1) { const middle = Math.floor(items[0].content.length / 2); halves = [[{ ...items[0], content: items[0].content.slice(0, middle) }], [{ ...items[0], content: items[0].content.slice(middle) }]]; }
    else throw new Error('模型无法容纳最小对话与固定提示词，未保存半成品');
    const combined = [];
    for (const half of halves) combined.push({ time: `${half[0].time} — ${half.at(-1).time}`, role: 'summary', content: JSON.stringify(await run(half, merge)) });
    if (merge && combined.reduce((size, item) => size + item.content.length, 0) >= items.reduce((size, item) => size + item.content.length, 0)) throw new Error('分段总结未缩短超限材料，未保存半成品');
    return run(combined, true);
  };
  try {
    const output = await run(messages);
    db.exec('BEGIN IMMEDIATE');
    let id;
    try {
      id = saveDiary(character, { date, title: output.title, content: output.content, tags: output.tags, hooks: output.unresolved_hooks, entryType: 'chat_entry', conversationId: sessionId, scope, timezone }, { transaction: false });
      db.prepare("UPDATE diary_instant_jobs SET status='done',record_id=?,updated_at=? WHERE id=?").run(id, new Date().toISOString(), selection);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { status: 'done', record_ids: [id], start, end, calls };
  } catch (error) {
    db.prepare("UPDATE diary_instant_jobs SET status='error',error=?,updated_at=? WHERE id=?").run(String(error.message).slice(0, 1000), new Date().toISOString(), selection);
    throw error;
  }
}
