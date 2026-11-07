/** 信息与画像分开保存；源于 Companion 的资料/画像职责划分，不把个人内容固化到程序。 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from '../common/config.js';

export function documentPath(role, kind, id) {
  if (!['user', 'assistant'].includes(role) || !['information', 'profile'].includes(kind)) throw new Error('未知资料文档');
  if (id !== undefined && (typeof id !== 'string' || !id.trim() || ['.', '..'].includes(id))) throw new Error('无效角色 ID');
  return join(DATA_DIR, 'profile', role, ...(id === undefined ? [] : [encodeURIComponent(id)]), kind + '.json');
}

export function hasDocument(role, kind, id) { return existsSync(documentPath(role, kind, id)); }

export function readDocument(role, kind, fallback = {}, id) {
  const file = documentPath(role, kind, id);
  if (!existsSync(file)) return structuredClone(fallback);
  const doc = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('资料文件格式错误：' + file);
  return doc;
}

export function writeDocument(role, kind, value, id) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('资料必须为对象');
  const file = documentPath(role, kind, id);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
  return value;
}
