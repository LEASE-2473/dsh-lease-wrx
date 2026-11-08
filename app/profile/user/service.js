// 每日用户画像：后台任务，每天跑一次。
// 只吃「用户本人」的发言；角色的话、AI 的推测都不进画像。候选（聊天模型提交的线索）在这里统一审。
import { loadConfig } from '../../common/config.js';
import { listCandidates, reviewCandidates } from './candidates.js';
import { openDb } from '../../memory/common/database.js';
import { readChatLog } from '../../memory/common/chat_log.js';
import { readUser, writeUser } from './repository.js';
import { complete } from '../../providers/llm.js';
import { PROFILE_PROMPT } from '../../memory/prompts.js';
import { dayRange } from '../../memory/diaries/time.js';
import { extractJson } from '../../memory/common/generation.js';

import { RETRY_MS, todayInZone } from '../common/time.js';

function profilePrompt(cfg) {
  const fromConfig = cfg?.prompts?.profile;
  return typeof fromConfig === 'string' && fromConfig.trim() ? fromConfig : PROFILE_PROMPT;
}

function jobKey(date) {
  return 'profile_job:' + date;
}

function readJob(date) {
  const row = openDb().prepare('SELECT document FROM settings WHERE key=?').get(jobKey(date));
  if (!row) return null;
  try {
    return JSON.parse(row.document);
  } catch {
    return null;
  }
}

function writeJob(date, doc) {
  openDb()
    .prepare('INSERT INTO settings(key,document) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET document=excluded.document')
    .run(jobKey(date), JSON.stringify(doc));
}

export function getProfileJob(date) {
  return readJob(date || todayInZone(loadConfig().timezone));
}

/** 跑某一天的画像整理。同一天成功过就不再跑；失败后 6 小时内不重试，避免每分钟烧钱。 */
export async function runProfileJob(ctx, { date, force = false } = {}) {
  const cfg = loadConfig();
  const tz = cfg.timezone || 'Asia/Shanghai';
  const day = date || todayInZone(tz);
  const prev = readJob(day);
  if (!force && prev) {
    if (prev.status === 'done' || prev.status === 'empty') return { ok: true, skipped: true, status: prev.status };
    if (prev.status === 'error' && Date.now() - (Date.parse(prev.at) || 0) < RETRY_MS) {
      return { ok: true, skipped: true, status: 'error' };
    }
  }

  const { start, end } = dayRange(day, tz);
  const said = readChatLog(start, end)
    .filter((row) => row.role === 'user')
    .map((row) => String(row.content || '').trim())
    .filter(Boolean);
  const candidates = listCandidates(50);

  if (!said.length && !candidates.length) {
    writeJob(day, { status: 'empty', at: new Date().toISOString() });
    return { ok: true, status: 'empty', reason: '这一天用户没有说话，也没有待审候选' };
  }

  try {
    const profile = readUser();
    const input = [
      '日期：' + day,
      '',
      '【当前画像】',
      JSON.stringify({ name: profile.name, core: profile.core, entries: profile.entries }, null, 1),
      '',
      '【待审候选（线索，不是已确认事实）】',
      candidates.length
        ? JSON.stringify(candidates.map(({ tag, keywords, content }) => ({ tag, keywords, content })), null, 1)
        : '（无）',
      '',
      '【当天用户本人的发言】',
      said.map((text) => '- ' + text).join('\n') || '（无）',
    ].join('\n');

    const text = await complete(ctx, cfg, {
      system: profilePrompt(cfg) + '\n\n【画像完整性优先】完整保留所有仍有效的身份事实及必要限定。不设字数、条数或关键词数量上限；不得为长度或 token 预算省略、截断旧资料或新事实。只在有明确依据时纠正或合并，返回完整画像。',
      messages: [{ role: 'user', text: input }],
      // 不设输出上限（0 = 交给服务端默认）。WRX 的画像总结就是不设。
      maxTokens: 0,
      requireComplete: true,
    });
    const parsed = extractJson(text);
    if (!Array.isArray(parsed?.entries)) throw new Error('画像输出缺少 entries：' + String(text || '').slice(0, 200));
    if (parsed.entries.some(entry => !entry || typeof entry.content !== 'string' || !entry.content.trim())) throw new Error('画像条目正文无效，保留原画像');

    const entries = parsed.entries
      .filter((entry) => entry && typeof entry.content === 'string' && entry.content.trim())
      .map((entry) => ({
        tag: String(entry.tag || '').trim() || '未分类',
        keywords: Array.isArray(entry.keywords)
          ? entry.keywords.map((word) => String(word).trim()).filter(Boolean)
          : [],
        content: entry.content,
      }));

    const saved = writeUser({ name: profile.name, core: profile.core, entries });
    if (candidates.length) reviewCandidates(candidates.map((candidate) => candidate.id), 'reviewed');
    writeJob(day, {
      status: 'done',
      at: new Date().toISOString(),
      entries: entries.length,
      candidates: candidates.length,
    });
    return { ok: true, status: 'done', entries: entries.length, candidates: candidates.length, revision: saved.revision };
  } catch (error) {
    writeJob(day, { status: 'error', at: new Date().toISOString(), error: String(error?.message || error).slice(0, 500) });
    throw error;
  }
}

/* ---------- 每日「角色画像」：我自己的那份（2026-10-26 加） ---------- */

