

import { loadConfig } from '../../common/config.js';
import { readDshMessages } from '../../integrations/dsh/source.js';
import { complete } from '../../providers/llm.js';
import { characters } from '../../profile/assistant/information.js';
import { readChatLog } from '../common/chat_log.js';
import { readMessages } from '../common/conversations.js';
import { readUser } from '../../profile/user/repository.js';
import { saveActivity } from './repository.js';

import { extractJson, trimMessages } from '../common/generation.js';

export async function generateActivity(ctx, { character, hours = 24, debug = false }) {
  const cfg = loadConfig();
  const char = characters().find((c) => c.id === character);
  if (!char) throw new Error('角色不存在');
  const user = readUser();
  const end = new Date();
  const start = new Date(end.getTime() - Math.max(1, hours) * 3600000);
  const isDshChar = Array.isArray(cfg.dshCharacters) && cfg.dshCharacters.includes(character);
  const messages = isDshChar
    ? (readChatLog(start.toISOString(), end.toISOString(), character).length
      ? readChatLog(start.toISOString(), end.toISOString(), character)
      : await readDshMessages(ctx, { character, start: start.toISOString(), end: end.toISOString() }))
    : readMessages(character, start.toISOString(), end.toISOString());
  const payload = {
    character: char.name,
    user_name: user.name || cfg.user?.name || '用户',
    persona: char.persona || '',
    date: new Date().toISOString().slice(0, 10),
    timezone: cfg.timezone,
    messages: trimMessages(messages).map((m) => ({ time: m.time, role: m.role, content: m.content })),
  };
  const raw = await complete(ctx, cfg, {
    system: cfg.prompts.activity,
    messages: [{ role: 'user', text: JSON.stringify(payload) }],
    maxTokens: 0,
  });
  const out = extractJson(raw);
  const content = String(out.note || out.activity_content || out.content || '').trim();
  if (!content) throw new Error('模型没有返回活动内容');
  const id = saveActivity(character, {
    activityType: String(out.activity_type || '自主活动').slice(0, 60),
    activityContent: String(out.activity_content || '').slice(0, 4000),
    content,
    mood: String(out.mood || '').slice(0, 200),
  });
  return { id, activityType: out.activity_type || '', note: content, ...(debug ? { raw } : {}) };
}
