/** 按功能拆分的兼容仓储；字段协议对照 WRX Companion，DSH 新增行为保留。 */
import { openDb } from '../../memory/common/database.js';
import { readDocument, writeDocument } from '../documents.js';
import { listRoles } from '../../common/roles.js';

export function characters() {
  const d = openDb();
  return d.prepare('SELECT id,document FROM characters').all().map((r) => {
    let doc = {};
    try { doc = JSON.parse(r.document); } catch { /* noop */ }
    doc = readDocument('assistant', 'information', doc, r.id);
    const role = listRoles().find(role => role.id === r.id);
    return { ...role, id: r.id, name: doc.name || r.id, user_name: doc.user_name || '', persona: doc.persona || '' };
  });
}

const CHARACTER_FIELDS = ['name', 'user_name', 'personality', 'background', 'relationship', 'speaking_style', 'system_prompt', 'persona', 'preset_id', 'llm_profile_id'];

export function characterDoc(id) {
  const row = openDb().prepare('SELECT id,document FROM characters WHERE id=?').get(id);
  if (!row) throw new Error('角色不存在：' + id);
  let doc;
  try { doc = JSON.parse(row.document); } catch { doc = {}; }
  return { id: row.id, ...readDocument('assistant', 'information', doc, id) };
}

export function updateCharacterDoc(id, fields) {
  const row = openDb().prepare('SELECT id,document FROM characters WHERE id=?').get(id);
  if (!row) throw new Error('角色不存在：' + id);
  let doc;
  try { doc = JSON.parse(row.document); } catch { doc = {}; }
  doc = readDocument('assistant', 'information', doc, id);
  for (const key of CHARACTER_FIELDS) {
    if (fields?.[key] === undefined) continue;
    if (key === 'name' && !String(fields.name).trim()) throw new Error('角色名不能为空');
    doc[key] = String(fields[key]);
  }
  writeDocument('assistant', 'information', doc, id);
  if (fields?.name !== undefined) openDb().prepare('UPDATE characters SET document=? WHERE id=?').run(JSON.stringify(doc), id);
  return { id, ...doc };
}

