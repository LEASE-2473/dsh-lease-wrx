import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { patchPiAiSystemCapability } from '../app/integrations/dsh/patches/pi-ai-system-capability.js';

const args = process.argv.slice(2);
const index = args.indexOf('--file');
if (index < 0 || !args[index + 1]) throw new Error('用法：node scripts/install-pi-ai-capability.mjs --file <隔离DSH的dsh-llm-pi-ai/lib/index.js> [--apply]');
const file = resolve(args[index + 1]);
const original = readFileSync(file, 'utf8');
const result = patchPiAiSystemCapability(original);
const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: result.source, encoding: 'utf8' });
if (syntax.status !== 0) throw new Error(syntax.stderr);
if (args.includes('--apply') && result.changed) {
  const backup = file + '.lease-wrx-capability-backup';
  if (!existsSync(backup)) writeFileSync(backup, original, { flag: 'wx' });
  writeFileSync(file, result.source);
  if (readFileSync(file, 'utf8') !== result.source) throw new Error('写后读回不一致');
  console.log('已开放显式模型能力配置，未默认开启该能力；备份：' + backup);
} else console.log(result.changed ? '可应用；仅检查，未修改宿主。后端需支持中间 system 才可启用能力' : '补丁已存在');
