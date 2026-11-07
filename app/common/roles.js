import { openDb } from '../memory/common/database.js';
import { withRole } from './role-context.js';

export function listRoles() {
  return openDb().prepare('SELECT * FROM characters ORDER BY rowid').all().map(row => ({
    id: row.id, name: JSON.parse(row.document).name || row.id, enabled: row.id !== 'default' && Boolean(row.wrx_enabled), wrxPresetId: row.wrx_preset_id, settings: JSON.parse(row.wrx_settings),
    presetIds: openDb().prepare('SELECT preset_id FROM wrx_preset_bindings WHERE character_id=? ORDER BY preset_id').all(row.id).map(r => r.preset_id),
  }));
}
export function getRole(id) {
  const role = listRoles().find(r => r.id === id);
  if (!role) throw new Error('角色不存在：' + id);
  return role;
}
export function saveRole({ id, name, enabled = false, presetIds = [], settings, wrxPresetId, create = false } = {}) {
  if (typeof id !== 'string' || !/^[a-z0-9_-]{1,80}$/.test(id)) throw new Error('无效角色 ID');
  if (typeof name !== 'string' || !name.trim()) throw new Error('角色名不能为空');
  if (typeof enabled !== 'boolean' || !Array.isArray(presetIds) || presetIds.some(p => typeof p !== 'string' || !p.trim())) throw new Error('角色绑定格式错误');
  if (id === 'default' && enabled) throw new Error('Default 强制不启用 WRX');
  const db = openDb();
  const previous = listRoles().find(r => r.id === id);
  if (create && previous) throw new Error('角色 ID 已存在');
  const selected = wrxPresetId ?? previous?.wrxPresetId;
  if (enabled && !selected) throw new Error('请先绑定独占WRX预设，再启用角色');
  if (id !== 'default' && selected && listRoles().some(r => r.id !== id && r.wrxPresetId === selected)) throw new Error('WRX预设不能重复绑定');
  if (wrxPresetId !== undefined && typeof wrxPresetId !== 'string') throw new Error('WRX预设ID必须为字符串');
  const row = db.prepare('SELECT document FROM characters WHERE id=?').get(id);
  const document = { ...(row ? JSON.parse(row.document) : {}), name: id === 'default' ? 'Default' : name.trim() };
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO characters(id,document,wrx_enabled,wrx_preset_id,wrx_settings) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document,wrx_enabled=excluded.wrx_enabled,wrx_preset_id=excluded.wrx_preset_id,wrx_settings=excluded.wrx_settings')
      .run(id, JSON.stringify(document), Number(enabled), id === 'default' ? '' : (wrxPresetId ?? previous?.wrxPresetId ?? ''), JSON.stringify(settings ?? previous?.settings ?? {}));
    db.prepare('DELETE FROM wrx_preset_bindings WHERE character_id=?').run(id);
    for (const preset of new Set(presetIds)) db.prepare('INSERT INTO wrx_preset_bindings(preset_id,character_id) VALUES (?,?)').run(preset, id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw new Error('保存失败，Agent Preset 不能重复绑定：' + error.message); }
  return getRole(id);
}

// Session projection 是当前真实选择；header 仅用于尚无 projection 的会话。
export function sessionPreset(session, ctx) {
  const projections = ctx?.get?.('sessionProjections') ?? ctx?.sessionProjections;
  if (projections?.stateOf) return projections.stateOf(session, 'agentPreset');
  if (Object.hasOwn(session ?? {}, 'agentPreset')) return session.agentPreset;
  let preset = session?.header?.agentPreset ?? null;
  for (const event of session?.log ?? []) if (event?.type === 'agent-preset/selected') preset = event.data.agentPreset;
  return preset;
}
export function resolveRole(preset) {
  const binding = typeof preset === 'string' ? openDb().prepare('SELECT character_id FROM wrx_preset_bindings WHERE preset_id=?').get(preset) : null;
  return getRole(binding?.character_id ?? 'default');
}
export function bindSession(session, ctx) {
  const preset = sessionPreset(session, ctx);
  const role = resolveRole(preset);
  const id = session?.id ?? session?.header?.id;
  if (id && role.enabled && !session?.header?.parentSession) {
    const now = new Date().toISOString();
    openDb().prepare("INSERT INTO conversations(id,character_id,agent_preset,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET character_id=excluded.character_id,agent_preset=excluded.agent_preset,updated_at=excluded.updated_at").run(id, role.id, preset ?? null, now, now);
  }
  return role;
}
export const inRole = (id, callback) => withRole(getRole(id), callback);
