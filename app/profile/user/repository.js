import { openDb } from '../../memory/common/database.js';
import { loadConfig } from '../../common/config.js';
import { hasDocument, readDocument, writeDocument } from '../documents.js';

/** 旧库仅作为兼容读取来源；读取不会自动迁移或改写它。 */
function legacyUser() {
  const row = openDb().prepare("SELECT document FROM settings WHERE key='global_user_profile'").get();
  if (!row) return { name: loadConfig().user?.name || '用户', core: '', entries: [], revision: 0 };
  return JSON.parse(row.document);
}

export function readUser() {
  const hasInfo = hasDocument('user', 'information');
  const hasProfile = hasDocument('user', 'profile');
  const old = !hasInfo || !hasProfile ? legacyUser() : {};
  const information = readDocument('user', 'information', { name: old.name || '用户', core: old.core || '' });
  const profile = readDocument('user', 'profile', { entries: old.entries || [], revision: old.revision || 0 });
  return { ...information, ...profile, name: information.name || '用户', core: information.core || '', entries: profile.entries || [], revision: profile.revision || 0 };
}

export function writeUser({ name, core, entries }) {
  const current = readUser();
  const information = { name: String(name ?? current.name).trim() || '用户', core: String(core ?? current.core) };
  const profile = { entries: Array.isArray(entries) ? entries : current.entries, revision: current.revision + 1 };
  writeDocument('user', 'information', information);
  writeDocument('user', 'profile', profile);
  return { ...information, ...profile };
}
