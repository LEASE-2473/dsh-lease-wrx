/** 离线发行检查：不执行插件apply、不连接DSH、不读取个人运行数据。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Script } from 'node:vm';
import { initializeData } from './initialize-data.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = p => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const activePrompts = readJson(join(root, 'doc/active-prompts.json')).prompts;
const { PROMPT_FILES, readPromptSet, readDefaultPromptSet } = await import('../app/memory/common/prompt_files.js');
assert.equal(activePrompts.length, Object.keys(PROMPT_FILES).length);
assert.equal(new Set(activePrompts.map(prompt => prompt.name)).size, activePrompts.length);
for (const prompt of activePrompts) {
  assert.equal(prompt.path, PROMPT_FILES[prompt.name]);
  assert.equal(sha(readFileSync(join(root, 'defaults/prompts', prompt.path))), prompt.defaultSha256, prompt.path);
  assert.ok(readFileSync(join(root, 'app', prompt.path), 'utf8').trim(), prompt.path);
}
assert.equal(sha(readFileSync(join(root, 'app/preset/defaults/presets.json'))), sha(readFileSync(join(root, 'defaults/presets.json'))));
assert.equal(Object.keys(readDefaultPromptSet()).length, Object.keys(PROMPT_FILES).length);
console.log('PASS 空预设库一致、默认提示词哈希与可编辑模块文件清单');

const presets = readJson(join(root, 'defaults/presets.json'));
assert.deepEqual(presets, { presets: [], active_preset_id: '' });


assert.ok(Object.values(readPromptSet()).every(prompt => typeof prompt === 'string' && prompt.trim()));

const temp = mkdtempSync(join(tmpdir(), 'lease-wrx-init-'));
try {
  assert.ok(initializeData(temp).every(r => r.status === 'created'));
  assert.deepEqual(readJson(join(temp, 'presets.json')), presets);
  assert.deepEqual(readJson(join(temp, 'config.json')), {});
  const customConfig = '{"prompts":{"system":"user-edited"},"custom":true}\n';
  const customPresets = '{"custom":"preserve-user-file"}\n';
  writeFileSync(join(temp, 'config.json'), customConfig);
  writeFileSync(join(temp, 'presets.json'), customPresets);
  assert.ok(initializeData(temp).every(r => r.status === 'kept'));
  assert.equal(readFileSync(join(temp, 'config.json'), 'utf8'), customConfig);
  assert.equal(readFileSync(join(temp, 'presets.json'), 'utf8'), customPresets);
  assert.deepEqual(readdirSync(temp).sort(), ['config.json', 'presets.json']);
} finally {
  for (const name of ['config.json', 'presets.json']) if (existsSync(join(temp, name))) unlinkSync(join(temp, name));
  rmdirSync(temp);
}
console.log('PASS 无内置预设；初始化不复制提示词正文且不覆盖用户文件');

function codeFiles(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const file = dir + '/' + entry.name;
    return entry.isDirectory() ? codeFiles(file) : /\.(?:js|mjs)$/.test(file) ? [file] : [];
  });
}
const files = [...codeFiles('app'), ...codeFiles('scripts')];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', join(root, file)], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  const source = readFileSync(join(root, file), 'utf8');
  for (const match of source.matchAll(/\b(?:from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
    assert.ok(existsSync(resolve(dirname(join(root, file)), match[1])), `${file}: missing ${match[1]}`);
  }
}
const html = readFileSync(join(root, 'app/static/settings/index.html'), 'utf8');
let scripts = 0;
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
  if (match[1].trim()) { new Script(match[1], { filename: 'app/static/settings/index.html inline script' }); scripts++; }
}
assert.ok(scripts > 0);
console.log(`PASS ${files.length} 个 JS/MJS 与 ${scripts} 个 UI 内联脚本语法检查`);

const pkg = readJson(join(root, 'package.json'));
assert.equal(pkg.main, pkg.exports['.']);
assert.ok(existsSync(join(root, pkg.exports['./client'])));
const entry = await import(pathToFileURL(join(root, pkg.exports['.'])).href);
assert.equal(entry.name, pkg.name);
assert.equal(typeof entry.apply, 'function');
const { PLUGIN_DIR } = await import('../app/common/paths.js');
assert.equal(resolve(PLUGIN_DIR), root);
const compat = await import('../app/integrations/dsh/compat.js');
assert.equal(resolve(compat.PLUGIN_DIR), root);
assert.ok(existsSync(join(root, 'app/integrations/dsh/patches/request-hook.js')));
const clientContext = { window: { __ModuleLoader__: { load: declaration => {
  assert.equal(declaration.id, pkg.name);
  assert.equal(typeof declaration.factory, 'function');
} } } };
new Script(readFileSync(join(root, pkg.exports['./client']), 'utf8')).runInNewContext(clientContext);
console.log('PASS 宿主入口导出、客户端注册与项目资源根路径（未执行插件 apply）');
