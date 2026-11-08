/** 项目资源根路径与显式宿主目录配置，不依赖个人部署元数据。 */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const PLUGIN_DIR = fileURLToPath(new URL('../../', import.meta.url));

export function dshRoot() {
  return process.env.LEASE_WRX_DSH_ROOT || process.env.DSH_HOME || null;
}

export function resolveDataDir(env = process.env) {
  const hostRoot = env.DSH_HOME || env.LEASE_WRX_DSH_ROOT;
  return env.LEASE_WRX_DATA_DIR || (hostRoot ? join(hostRoot, 'dsh-wrx-memory') : join(PLUGIN_DIR, 'data'));
}
