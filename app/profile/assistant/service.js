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

  // 默认只读一天：读三天塞不下（2026-10-26 LEASE 点出来的）。超预算就从最早的整条丢，
  // 最新的必须保住——不然写出来的是三天前的人。
  const days = Math.max(1, Math.min(7, Number(cfg.selfProfile?.days) || 1));
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const raw = readChatLog(start.toISOString(), end.toISOString(), roleId() || cfg.dshCharacters[0])
    .filter((r) => String(r.content || '').trim());
  // 这个通道的 contextWindow 是 1M token（cordis.patch.yml 里写着），中文字 ≈ 1 token。
  // 预算给到六十万字符（六成），剩下的留给输出、系统提示和长文变慢的余地。
  const budget = Math.max(4000, Number(cfg.selfProfile?.maxChars) || 600000);
  let used = 0;
  const rows = [];
  for (let i = raw.length - 1; i >= 0; i -= 1) {
    const r = raw[i];
    const line = (r.role === 'user' ? (cfg.user?.name || '用户') + '：' : '助手：') + String(r.content).slice(0, 300);
    if (used + line.length > budget) break;
    rows.unshift({ line });
    used += line.length;
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
      system: selfPrompt(cfg),
      messages: [{ role: 'user', text: input }],
      // 不设输出上限（0 = 交给服务端默认）。3072 和 8192 都被 reasoning 吃光过，
      // 学 WRX 的画像总结：不硬设。
      maxTokens: Number(cfg.selfProfile?.maxTokens) || 0,
    });
    const parsed = extractJson(text);
    if (!Array.isArray(parsed?.entries)) throw new Error('角色画像输出缺少 entries：' + String(text || '').slice(0, 200));

    // 关键词跟用户画像必须同构——少这一行，每天跑完一次就把 keywords 抹掉了。
    // 模型偷懒没给 keywords 时，退回去用同 tag 的旧关键词，别自己把自己掏空。
    const oldByTag = new Map();
    for (const e of current.entries || []) {
      if (e && e.tag && Array.isArray(e.keywords) && e.keywords.length) oldByTag.set(String(e.tag), e.keywords);
    }
    const entries = parsed.entries
      .filter((e) => e && typeof e.content === 'string' && e.content.trim())
      .slice(0, 12)
      .map((e) => {
        const tag = String(e.tag || '').trim() || '状态';
        const keywords = Array.isArray(e.keywords)
          ? e.keywords.map((w) => String(w).trim()).filter(Boolean).slice(0, 6)
          : [];
        return {
          tag,
          keywords: keywords.length ? keywords : (oldByTag.get(tag) || []),
          content: String(e.content).trim().slice(0, 200),
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
