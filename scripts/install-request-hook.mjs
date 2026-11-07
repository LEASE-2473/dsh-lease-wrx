/** 显式指定隔离宿主文件；默认仅检查，不自动应用、不重启。 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { patchRequestHook } from '../app/integrations/dsh/patches/request-hook.js';

const args = process.argv.slice(2);
const fileIndex = args.indexOf('--file');
if (fileIndex < 0 || !args[fileIndex + 1]) throw new Error('用法：node scripts/install-request-hook.mjs --file <隔离DSH的agent-loop/lib/index.js> [--apply]');
const file = resolve(args[fileIndex + 1]);
const original = readFileSync(file, 'utf8');
const result = patchRequestHook(original);
const check = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: result.source, encoding: 'utf8' });
if (check.status !== 0) throw new Error(check.stderr);
if (args.includes('--apply') && result.changed) {
  const backup = file + '.lease-wrx-backup';
  if (!existsSync(backup)) writeFileSync(backup, original, { flag: 'wx' });
  writeFileSync(file, result.source);
  if (readFileSync(file, 'utf8') !== result.source) throw new Error('写后读回不一致');
  console.log('已应用，备份：' + backup);
} else console.log(result.changed ? '可应用；当前仅检查，未写入宿主' : '补丁已存在');
