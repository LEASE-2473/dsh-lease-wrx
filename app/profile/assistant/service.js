import { roleId } from '../../common/role-context.js';
// 每日用户画像：后台任务，每天跑一次。
// 只吃「用户本人」的发言；角色的话、AI 的推测都不进画像。候选（聊天模型提交的线索）在这里统一审。
import { loadConfig } from '../../common/config.js';
import { openDb } from '../../memory/common/database.js';
import { readChatLog } from '../../memory/common/chat_log.js';
import { readSelf, writeSelf } from './repository.js';
import { complete } from '../../providers/llm.js';
import { SELF_PROFILE_PROMPT } from '../../memory/prompts.js';
import { extractJson } from '../../memory/common/generation.js';

import { RETRY_MS, todayInZone } from '../common/time.js';

function readJobByKey(key) {
  const row = openDb().prepare('SELECT document FROM settings WHERE key=?').get(key);
  if (!row) return null;
  try { return JSON.parse(row.document); } catch { return null; }
}

function writeJobByKey(key, doc) {
  openDb()
    .prepare('INSERT INTO settings(key,document) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET document=excluded.document')
    .run(key, JSON.stringify(doc));
}

function selfPrompt(cfg) {
  const fromConfig = cfg?.prompts?.selfProfile;
  return typeof fromConfig === 'string' && fromConfig.trim() ? fromConfig : SELF_PROFILE_PROMPT;
}

export function getSelfProfileJob(date) {
  const day = date || todayInZone(loadConfig().timezone);
  return readJobByKey('self_profile_job:' + (roleId() || loadConfig().dshCharacters[0]) + ':' + day);
}

/**
 * 每天从「最近几天的原始对话」重新总结一份我自己的画像。
 * 关键：每次从原始对话重来，不在上一份总结上改——压缩深度天然是 1，绕开漂移。
 */
export async function runSelfProfileJob(ctx, { date, force = false } = {}) {
  const cfg = loadConfig();
  const tz = cfg.timezone || 'Asia/Shanghai';
  const day = date || todayInZone(tz);
  const key = 'self_profile_job:' + (roleId() || loadConfig().dshCharacters[0]) + ':' + day;
  const prev = readJobByKey(key);
  if (!force && prev) {
    if (prev.status === 'done' || prev.status === 'empty') return { ok: true, skipped: true, status: prev.status };
    if (prev.status === 'error' && Date.now() - (Date.parse(prev.at) || 0) < RETRY_MS) {
      return { ok: true, skipped: true, status: 'error' };
    }
  }

  // 按配置时间窗口读取完整对话，不按字符预算丢弃记录；超出模型能力时失败并保留原画像。
  const days = Math.max(1, Math.min(7, Number(cfg.selfProfile?.days) || 1));
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const raw = readChatLog(start.toISOString(), end.toISOString(), roleId() || cfg.dshCharacters[0])
    .filter((r) => String(r.content || '').trim());
  const rows = [];
  for (let i = raw.length - 1; i >= 0; i -= 1) {
    const r = raw[i];
    const line = (r.role === 'user' ? (cfg.user?.name || '用户') + '：' : '助手：') + String(r.content);
    rows.unshift({ line });
  }
  if (!rows.length) {
    writeJobByKey(key, { status: 'empty', at: new Date().toISOString() });
    return { ok: true, status: 'empty', reason: '这几天没有对话' };
  }

  try {
    const current = readSelf();
    const input = [
      '日期：' + day,
      '',
      '【现在的我】',
      JSON.stringify({ entries: current.entries }, null, 1),
      '',
      '【最近 ' + days + ' 天的对话】',
      rows.map((r) => r.line).join('\n'),
    ].join('\n');

    const text = await complete(ctx, cfg, {
      system: selfPrompt(cfg) + '\n\n【画像完整性优先】完整保留所有仍有效的事实及必要限定。不设字数、条数或关键词数量上限；不得为长度或 token 预算省略、截断旧资料或新事实。只在有明确依据时纠正或合并，返回完整画像。',
      messages: [{ role: 'user', text: input }],
      // 不设输出上限（0 = 交给服务端默认）。3072 和 8192 都被 reasoning 吃光过，
      // 学 WRX 的画像总结：不硬设。
      maxTokens: 0,
      requireComplete: true,
    });
    const parsed = extractJson(text);
    if (!Array.isArray(parsed?.entries)) throw new Error('角色画像输出缺少 entries：' + String(text || '').slice(0, 200));
    if (parsed.entries.some(e => !e || typeof e.content !== 'string' || !e.content.trim())) throw new Error('角色画像条目正文无效，保留原画像');

    // 关键词跟用户画像必须同构——少这一行，每天跑完一次就把 keywords 抹掉了。
    // 模型偷懒没给 keywords 时，退回去用同 tag 的旧关键词，别自己把自己掏空。
    const oldByTag = new Map();
    for (const e of current.entries || []) {
      if (e && e.tag && Array.isArray(e.keywords) && e.keywords.length) oldByTag.set(String(e.tag), e.keywords);
    }
    const entries = parsed.entries
      .filter((e) => e && typeof e.content === 'string' && e.content.trim())
      .map((e) => {
        const tag = String(e.tag || '').trim() || '状态';
        const keywords = Array.isArray(e.keywords)
          ? e.keywords.map((w) => String(w).trim()).filter(Boolean)
          : [];
        return {
          tag,
          keywords: keywords.length ? keywords : (oldByTag.get(tag) || []),
          content: e.content,
        };
      });

    const saved = writeSelf({
      entries,
    });
    writeJobByKey(key, { status: 'done', at: new Date().toISOString(), entries: entries.length });
    return { ok: true, status: 'done', entries: entries.length, revision: saved.revision };
  } catch (error) {
    writeJobByKey(key, { status: 'error', at: new Date().toISOString(), error: String(error?.message || error).slice(0, 500) });
    throw error;
  }
}
