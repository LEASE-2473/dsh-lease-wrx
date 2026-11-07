import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function resolveAssistantTarget(config) {
  const selected = config.dshCharacters?.find(id => typeof id === 'string' && id.trim()) || 'dsh';
  config = { ...config, dshCharacters: [selected], characters: [selected] };
  if (!existsSync(config.dbPath)) return config;
  const database = new DatabaseSync(config.dbPath, { readOnly: true });
  try {
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='characters'").get()) return config;
    const existing = database.prepare('SELECT id FROM characters LIMIT 2').all();
    if (!database.prepare('SELECT 1 FROM characters WHERE id=?').get(selected) && existing.length) {
      if (existing.length !== 1) throw new Error('旧数据包含多个助手且绑定不明确，请先确认数据归属，不能自动创建新角色');
      return { ...config, dshCharacters: [existing[0].id], characters: [existing[0].id] };
    }
    if (selected !== 'default') return config;
    const candidates = database.prepare("SELECT id FROM characters WHERE id != 'default' LIMIT 2").all();
    if (candidates.length !== 1) return config;
    const placeholder = database.prepare("SELECT document FROM characters WHERE id='default'").get();
    if (placeholder) {
      const document = JSON.parse(placeholder.document);
      if (document.name !== 'default' || Object.keys(document).some(key => !['name', 'user_name'].includes(key))) return config;
    }
    for (const table of ['system_summary', 'system_people', 'system_items', 'system_agreements', 'diaries', 'ai_notes', 'conversations']) {
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      if (database.prepare('SELECT 1 FROM ' + table + ' WHERE character_id=? LIMIT 1').get('default')) return config;
    }
    return { ...config, dshCharacters: [candidates[0].id], characters: [candidates[0].id] };
  } finally {
    database.close();
  }
}
