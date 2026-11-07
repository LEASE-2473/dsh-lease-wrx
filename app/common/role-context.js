import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage();
export const currentRole = () => scope.getStore();
export const roleId = () => currentRole()?.id;
export const withRole = (role, callback) => scope.run(role, callback);

export function scopedConfig(config) {
  const role = currentRole();
  if (!role) return config;
  const result = { ...config, characters: [role.id], dshCharacters: [role.id] };
  for (const [key, value] of Object.entries(role.settings || {})) result[key] = value && typeof value === 'object' && !Array.isArray(value) ? { ...config[key], ...value } : value;
  result.prompting = { ...config.prompting, ...role.settings?.prompting, enabled: role.id !== 'default' && role.enabled === true };
  return result;
}
