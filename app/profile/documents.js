/** 信息与画像分开保存；源于 Companion 的资料/画像职责划分，不把个人内容固化到程序。 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { DATA_DIR } from '../common/config.js';

export function documentPath(role, kind, id) {
  if (!['user', 'assistant'].includes(role) || !['information', 'profile'].includes(kind)) throw new Error('未知资料文档');
  if (id !== undefined && (typeof id !== 'string' || !id.trim() || ['.', '..'].includes(id))) throw new Error('无效角色 ID');
  return join(DATA_DIR, 'profile', role, ...(id === undefined ? [] : [encodeURIComponent(id)]), kind + '.json');
}

export function hasDocument(role, kind, id) { return existsSync(documentPath(role, kind, id)); }

function pruneHistory(file) {
  const history = join(dirname(file), 'history');
  if (!existsSync(history)) return;
  const cutoff = Date.now() - 14 * 86400000;
  for (const entry of readdirSync(history, { withFileTypes: true })) {
    const match = /^(\d{13})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/.exec(entry.name);
    if (entry.isFile() && match && Number(match[1]) < cutoff) unlinkSync(join(history, entry.name));
  }
}

/** 心跳清理：不要求画像启用或被读取，不遍历符号链接。 */
export function pruneProfileHistories() {
  pruneHistory(documentPath('user', 'profile'));
  const assistants = join(DATA_DIR, 'profile', 'assistant');
  if (!existsSync(assistants)) return;
  pruneHistory(join(assistants, 'profile.json'));
  for (const entry of readdirSync(assistants, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'history') pruneHistory(join(assistants, entry.name, 'profile.json'));
  }
}

export function readDocument(role, kind, fallback = {}, id) {
  const file = documentPath(role, kind, id);
  if (kind === 'profile') pruneHistory(file);
  if (!existsSync(file)) return structuredClone(fallback);
  const doc = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('资料文件格式错误：' + file);
  return doc;
}

export function writeDocument(role, kind, value, id) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('资料必须为对象');
  const file = documentPath(role, kind, id);
  mkdirSync(dirname(file), { recursive: true });
  // 覆盖画像前保留原件；备份失败则停止写入，避免无恢复来源的覆盖。
  if (kind === 'profile' && existsSync(file)) {
    const history = join(dirname(file), 'history');
    mkdirSync(history, { recursive: true });
    copyFileSync(file, join(history, `${Date.now()}-${randomUUID()}.json`));
    pruneHistory(file);
  }
  const tmp = file + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
  return value;
}
