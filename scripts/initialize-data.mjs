/** 只从已版本化的提示词种子建立本地配置；不创建数据库、不调用模型、不覆盖已有配置。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir } from '../app/common/paths.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function initializeData(dataDir = resolveDataDir()) {
  const presetSeed = join(ROOT, 'app', 'preset', 'defaults', 'presets.json');
  const presets = JSON.parse(readFileSync(presetSeed, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(presets.presets)) throw new Error('预设种子缺少 presets');
  mkdirSync(dataDir, { recursive: true });
  const result = [];
  for (const [name, content] of [
    ['presets.json', readFileSync(presetSeed)],
    ['config.json', '{}\n'],
  ]) {
    const target = join(dataDir, name);
    if (existsSync(target)) { result.push({ name, status: 'kept' }); continue; }
    writeFileSync(target, content, { flag: 'wx' });
    result.push({ name, status: 'created' });
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const item of initializeData()) console.log(`${item.name}: ${item.status}`);
}
