

import { loadConfig } from '../../common/config.js';
import { readDshMessages } from '../../integrations/dsh/source.js';
import { complete } from '../../providers/llm.js';
import { characters } from '../../profile/assistant/information.js';
import { readChatLog } from '../common/chat_log.js';
import { readMessages } from '../common/conversations.js';
import { listActivity } from '../ai_notes/repository.js';
import { saveDiary } from './repository.js';

import { extractJson, DEFAULT_MAX_INPUT_CHARS, DIARY_SEGMENT_INSTRUCTION, DIARY_MERGE_INSTRUCTION } from '../common/generation.js';
import { dayRange } from './time.js';

export async function generateDiary(ctx, { character, date, debug = false }) {
  const cfg = loadConfig();
  const char = characters().find((c) => c.id === character);
  if (!char) throw new Error('角色不存在');
  const tz = cfg.timezone || 'Asia/Shanghai';
  const day = date || new Date().toISOString().slice(0, 10);
  const { start, end } = dayRange(day, tz);
  const isDshChar = Array.isArray(cfg.dshCharacters) && cfg.dshCharacters.includes(character);
  // chat_log 是插件在 LEASE 压缩上下文之前抄下来的原文；session 里被压过的已经不是原话。
  // 所以 chat_log 绝对优先，取不到才退 session（2026-10-26 LEASE 强调，别搞反）。
  let messages;
  if (isDshChar) {
    const fromLog = readChatLog(start, end, character);
    messages = fromLog.length ? fromLog : await readDshMessages(ctx, { character, start, end }).catch(() => []);
  } else {
    messages = readMessages(character, start, end);
  }
  if (!messages.length) throw new Error('这一天没有对话，写不出日记');
  // 当天的外出记录也塞进材料：不然白天出去逛了什么，写日记时看不见（2026-10-26 LEASE 定的）。
  const activities = listActivity(character, 40)
    .filter(n => n.injection_mode !== 'freeze')
    .filter((n) => {
      const at = String(n.occurred_at || n.created_at || '');
      return at >= start && at < end;
    })
    .map((n) => ({
      type: n.activity_type || '活动',
      content: String(n.activity_content || n.content || '').slice(0, 1200),
    }));
  const payloadBase = {
    character: char.name,
    user_name: cfg.user?.name || '用户',
    date: day,
    timezone: tz,
    ...(activities.length ? { activities } : {}),
  };
  // 不再静默裁掉最早的部分：先算总量，装得下就一次写，装不下就分段写再合。
  const full = messages.map((m) => ({ time: m.time, role: m.role, content: String(m.content || '').slice(0, 3000) }));
  const totalChars = full.reduce((n, m) => n + m.content.length, 0);
  const maxChars = Math.max(20000, Number(cfg.diary?.maxChars) || DEFAULT_MAX_INPUT_CHARS);
  let raw;
  if (totalChars <= maxChars) {
    raw = await complete(ctx, cfg, {
      system: cfg.prompts.diary,
      messages: [{ role: 'user', text: JSON.stringify({ ...payloadBase, messages: full }) }],
      maxTokens: 0,
    });
  } else {
    const batchLimit = Math.max(8000, Math.floor(maxChars / 2));
    const batches = [];
    let cur = [];
    let curLen = 0;
    for (const m of full) {
      if (curLen + m.content.length > batchLimit && cur.length) {
        batches.push(cur);
        cur = [];
        curLen = 0;
      }
      cur.push(m);
      curLen += m.content.length;
    }
    if (cur.length) batches.push(cur);
    const segments = [];
    for (const batch of batches) {
      const piece = await complete(ctx, cfg, {
        system: cfg.prompts.diary + DIARY_SEGMENT_INSTRUCTION(),
        messages: [{ role: 'user', text: JSON.stringify({ ...payloadBase, messages: batch }) }],
        maxTokens: 0,
      });
      const parsed = extractJson(piece);
      if (parsed.content) segments.push(parsed.content);
    }
    if (!segments.length) throw new Error('分段日记全都写空了');
    raw = await complete(ctx, cfg, {
      system: cfg.prompts.diary + DIARY_MERGE_INSTRUCTION(),
      messages: [{ role: 'user', text: JSON.stringify({ ...payloadBase, messages: [], segments }) }],
      maxTokens: 0,
    });
  }
  const out = extractJson(raw);
  if (!out.content) throw new Error('模型没有返回日记正文');
  const id = saveDiary(character, {
    date: day,
    title: out.title || '',
    content: out.content,
    tags: Array.isArray(out.tags) ? out.tags : [],
    hooks: Array.isArray(out.unresolved_hooks) ? out.unresolved_hooks : [],
  });
  return { id, date: day, title: out.title || '', ...(debug ? { raw } : {}) };
}

/* ---------- 主动外出报告 ---------- */

