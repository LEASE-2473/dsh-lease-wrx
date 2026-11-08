import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PLUGIN_DIR, dshRoot } from '../../common/paths.js';
export { PLUGIN_DIR } from '../../common/paths.js';

const ROOT = dshRoot();

const MARK_MIDCONVO = 'supportsMidConvoSystemMessages';
const MIDCONVO_MODELS = ['chat:deepseek-v4.1-flash', 'chat:deepseek-v4-pro'];

export function findPiAiCatalogs({ entry = process.argv[1], root = ROOT } = {}) {
  // 主程序与DSH_HOME可以分离；优先识别当前CLI所属的DSH包，不猜个人安装路径。
  if (entry && existsSync(entry)) {
    let directory = dirname(realpathSync(entry));
    while (true) {
      const manifest = join(directory, 'package.json');
      try {
        if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === '@deepseek-ai/dsh') {
          const catalog = join(directory, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data', 'opencode-go.json');
          if (existsSync(catalog)) return [catalog];
        }
      } catch { /* 不把无关或损坏的package.json当作宿主安装。 */ }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const ROOT = root;
  if (!ROOT) return [];
  const found = new Set();
  // 直接路径：dsh/node_modules/@earendil-works/pi-ai/...
  const direct2 = join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data', 'opencode-go.json');
  if (existsSync(direct2)) found.add(direct2);
  // profile 的 pnpm 副本
  const pnpmRoot = join(ROOT, 'profiles', 'web', 'node_modules', '.pnpm');
  try {
    const { readdirSync } = process.getBuiltinModule('node:fs');
    for (const name of readdirSync(pnpmRoot)) {
      if (!name.startsWith('@earendil-works+pi-ai@')) continue;
      const p = join(pnpmRoot, name, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data', 'opencode-go.json');
      if (existsSync(p)) found.add(p);
    }
  } catch {
    /* 没有 pnpm 目录就算了 */
  }
  return [...found];
}

function applyMidconvo() {
  const files = findPiAiCatalogs();
  if (!files.length) throw new Error('找不到 pi-ai 的 opencode-go.json（可能没装 opencode-go 通道）');
  let changed = 0;
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      throw new Error('JSON 解析失败：' + file + ' —— ' + error.message);
    }
    const section = data['openai-completions'];
    if (!section) continue;
    let touched = 0;
    for (const key of MIDCONVO_MODELS) {
      const model = section[key];
      if (!model) continue;
      if (model.compat?.[MARK_MIDCONVO] === true) continue;
      model.compat = { ...(model.compat || {}), [MARK_MIDCONVO]: true };
      touched += 1;
    }
    if (!touched) continue;
    const backup = file + '.lease-wrx-midconvo-backup';
    if (!existsSync(backup)) writeFileSync(backup, raw, { flag: 'wx' });
    writeFileSync(file, JSON.stringify(data), 'utf8');
    changed += touched;
  }
  return { changed: changed > 0, note: changed > 0 ? '已打开 ' + changed + ' 个模型' : '已经打过' };
}

/* ---------------- 对外：状态与执行 ---------------- */

function midconvoStatus() {
  const files = findPiAiCatalogs();
  if (!files.length) return { state: 'missing', detail: '没找到 pi-ai 的 catalog' };
  let on = 0;
  let total = 0;
  for (const file of files) {
    try {
      const section = JSON.parse(readFileSync(file, 'utf8'))['openai-completions'];
      if (!section) continue;
      for (const key of MIDCONVO_MODELS) {
        if (!section[key]) continue;
        total += 1;
        if (section[key].compat?.[MARK_MIDCONVO] === true) on += 1;
      }
    } catch {
      /* 一个坏文件不影响总体判断 */
    }
  }
  if (total === 0) return { state: 'missing', detail: 'catalog 里没有这两个模型' };
  if (on === total) return { state: 'applied', detail: on + '/' + total + ' 个模型已打开' };
  if (on === 0) return { state: 'absent', detail: '未打开' };
  return { state: 'partial', detail: on + '/' + total + ' 个模型已打开' };
}

export function compatStatus() {
  return { midconvo: midconvoStatus(), needsRestart: true };
}
export function compatApply(name) {
  if (name !== 'midconvo' && name !== 'all') throw new Error('未知供应商适配：' + name);
  return { ok: true, name, done: ['midconvo：' + applyMidconvo().note], restart: true };
}
