/** 项目资源根路径与显式宿主目录配置，不依赖个人部署元数据。 */
import { fileURLToPath } from 'node:url';

export const PLUGIN_DIR = fileURLToPath(new URL('../../', import.meta.url));

export function dshRoot() {
  return process.env.LEASE_WRX_DSH_ROOT || process.env.DSH_HOME || null;
}
