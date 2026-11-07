/** 按功能拆分的兼容仓储；字段协议对照 WRX Companion，DSH 新增行为保留。 */
import { randomBytes } from 'node:crypto';

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function toIso(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error('无效时间：' + value);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function uid() {
  return randomBytes(13).toString('base64url');
}

export function plainDialogue(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<(?:emotion_update|app_call)\b[^>]*>[\s\S]*?<\/(?:emotion_update|app_call)>/gi, '')
    .replace(/<(?:emotion_update|app_call)\b[\s\S]*$/gi, '')
    .replace(/!\[[^\]]*\]\([^)]*\)|<img\b[^>]*>/gi, '')
    .replace(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*/, '')
    .trim();
}

export function parseJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}
