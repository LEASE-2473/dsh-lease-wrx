import { listRoles } from '../common/roles.js';
import { currentRole } from '../common/role-context.js';
/** 预设存储：新文件优先，旧运行配置兼容回退；不改写种子或旧文件。 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../common/config.js';
import { validatePresetState } from './validation.js';

export function createPresetStore({ dataDir = DATA_DIR, beforeSave = () => {}, defaultsPath = fileURLToPath(new URL('./defaults/presets.json', import.meta.url)) } = {}) {
  const target = join(dataDir, 'presets', 'state.json');
  const legacy = join(dataDir, 'presets.json');
  return {
    get path() { return target; },
    load() {
      const file = [target, legacy, defaultsPath].find(existsSync);
      if (!file) throw new Error('找不到预设种子文件');
      return validatePresetState(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
    },
    loadForRole() {
      const state = this.load();
      const selected = currentRole()?.wrxPresetId;
      if (selected) {
        if (!state.presets.some(preset => preset.id === selected)) throw new Error('角色绑定的WRX预设不存在：' + selected);
        state.active_preset_id = selected;
      }
      return state;
    },
    save(value) {
      const state = validatePresetState(value);
      beforeSave(state);
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { flag: 'wx' });
      renameSync(tmp, target);
      return state;
    },
  };
}

export const presetStore = createPresetStore({ beforeSave(state) {
  const role = currentRole();
  const previous = presetStore.load();
  if (role) {
    for (const old of previous.presets) {
      const next = state.presets.find(p => p.id === old.id);
      if (JSON.stringify(old) === JSON.stringify(next)) continue;
      const owner = listRoles().find(r => r.wrxPresetId === old.id && r.id !== role.id);
      if (owner) throw new Error('当前预设已绑定角色「' + owner.name + '」，禁止在当前角色下更改。请复制并绑定或切换管理角色。');
    }
  }
  const ids = new Set(state.presets.map(preset => preset.id));
  const bound = listRoles().find(role => role.wrxPresetId && !ids.has(role.wrxPresetId));
  if (bound) throw new Error('预设仍被角色「' + bound.name + '」绑定，请先修改角色绑定');
} });
