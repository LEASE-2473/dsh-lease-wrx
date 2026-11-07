import { readPrompt } from './prompt_files.js';
export function extractJson(text) {
  if (typeof text !== 'string') throw new Error('模型没有返回文本');
  let s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = s.indexOf('{');
  if (start < 0) throw new Error('模型输出里没有 JSON：' + s.slice(0, 200));
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(s.slice(start, i + 1));
    }
  }
  throw new Error('JSON 不完整：' + s.slice(0, 300));
}

export function appCall(text, name) {
  const patterns = [
    new RegExp('<app_call\\s+name=["\']' + name + '["\'][^>]*>([\\s\\S]*?)<\\/app_call>', 'i'),
    new RegExp('<' + name + '\\s*>([\\s\\S]*?)<\\/' + name + '>', 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(text || '');
    if (!m) continue;
    try { return JSON.parse(m[1].trim()); } catch { /* try next */ }
  }
  return null;
}

export function stripAppCalls(text) {
  return String(text || '')
    .replace(/<app_call\b[\s\S]*?<\/app_call>/gi, '')
    .replace(/<(?:recall_system_memory|optimize_system_memory|unchanged)\b[^>]*>[\s\S]*?<\/(?:recall_system_memory|optimize_system_memory|unchanged)>/gi, '')
    .replace(/<unchanged\s*\/>/gi, '')
    .trim();
}

export function trimMessages(messages, maxEach = 3000, maxTotal = 120000) {
  const out = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const content = String(m.content || '').slice(0, maxEach);
    if (total + content.length > maxTotal && out.length > 0) break;
    out.push({ ...m, content });
    total += content.length;
  }
  return out.reverse();
}

export function isContextOverflow(error) {
  const text = String(error?.message || '') + ' ' + String(error?.code || '')
  return /context_length_exceeded|context window|maximum context|too many tokens|token.{0,30}(exceed|limit)|上下文.{0,15}(超限|超过)/i.test(text)
}

/** 超过这个字符数就先按会话切开，分别总结再合并（LEASE 定的 12 万字门限）。 */
export const DEFAULT_MAX_INPUT_CHARS = 120000;

export const MERGE_INSTRUCTION = () => readPrompt('MERGE_INSTRUCTION');

/* 日记也可能写不下：一天聊得太多时，先按时间切段各写一段，再合成一篇（2026-10-26 补，
   照 WRX 的 diary_merge）。不这么做就只能从最早的丢，早上那半段静默消失。 */
export const DIARY_SEGMENT_INSTRUCTION = () => readPrompt('DIARY_SEGMENT_INSTRUCTION');

export const DIARY_MERGE_INSTRUCTION = () => readPrompt('DIARY_MERGE_INSTRUCTION');

export function splitBySession(messages) {
  const groups = new Map();
  for (const message of messages) {
    const key = message.sessionId || 'single';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(message);
  }
  return groups;
}

export function plainMessages(messages) {
  return messages.map((m) => ({ time: m.time, role: m.role, content: m.content }));
}

/** 一条消息本身比门限还长时按字符切两半，保证不丢。 */
export function splitMessage(message, maxChars) {
  const text = String(message.content || '');
  const mid = Math.max(1, Math.floor(text.length / 2));
  return [
    { ...message, content: text.slice(0, mid) },
    { ...message, content: text.slice(mid) },
  ];
}

/**
 * 递归总结：装得下就直接总结；装不下或者真的报上下文超限，就一拆二，各自递归，最后合并。
 * LEASE 定的：不设上限、不许丢；单会话超长也照拆，不许记 error 了事（2026-10-26）。
 */
