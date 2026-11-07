import { currentRole } from '../common/role-context.js';
import { listRoles } from '../common/roles.js';
/** 可注入编译器的预设 API；宿主负责鉴权及路由挂载，不复制一套编排规则。 */
import { presetStore } from './store.js';
import { validatePresetState } from './validation.js';

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 2 * 1024 * 1024) throw new Error('预设请求不能超过 2 MiB');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export function createPresetHandler({ store = presetStore, getMacros = () => [], preview } = {}) {
  return async function handlePreset(req, res, path) {
    if (!['/state', '/preview'].includes(path)) return false;
    try {
      if (path === '/state' && req.method === 'GET') json(res, 200, { state: store.load(), owners: currentRole() ? listRoles().filter(r => r.wrxPresetId).map(r => ({ id: r.id, name: r.name, presetId: r.wrxPresetId })) : [], macros: await getMacros() });
      else if (path === '/state' && req.method === 'PUT') {
        const body = await readBody(req);
        const latest = store.load();
        let next;
        if (Array.isArray(body.changes)) {
          next = structuredClone(latest);
          const seen = new Set();
          for (const change of body.changes) {
            if (!change || typeof change.id !== 'string' || seen.has(change.id)) throw new Error('预设变更ID无效或重复');
            seen.add(change.id);
            const previous = latest.presets.find(p => p.id === change.id);
            if (JSON.stringify(previous ?? null) !== JSON.stringify(change.before ?? null)) throw new Error('预设已被其他窗口修改，请重新读取后再编辑');
            if (change.after && change.after.id !== change.id) throw new Error('预设ID不一致');
            const index = next.presets.findIndex(p => p.id === change.id);
            if (index >= 0) next.presets.splice(index, 1, ...(change.after ? [change.after] : []));
            else if (change.after) next.presets.push(change.after);
          }
          next = validatePresetState(next);
        } else next = validatePresetState(body.state ?? body);
        if (currentRole() && !body.baseState && !Array.isArray(body.changes)) throw new Error('缺少编辑基线，请重新读取预设');
        if (body.baseState) {
          const base = validatePresetState(body.baseState);
          const ids = new Set([...base.presets, ...next.presets].map(p => p.id));
          const merged = structuredClone(latest);
          for (const id of ids) {
            const before = base.presets.find(p => p.id === id);
            const after = next.presets.find(p => p.id === id);
            if (JSON.stringify(before) === JSON.stringify(after)) continue;
            if (JSON.stringify(before) !== JSON.stringify(latest.presets.find(p => p.id === id))) throw new Error('预设已被其他窗口修改，请重新读取后再编辑');
            const index = merged.presets.findIndex(p => p.id === id);
            if (index >= 0) merged.presets.splice(index, 1, ...(after ? [after] : []));
            else if (after) merged.presets.push(after);
          }
          // 编辑选择只返回给本窗口，不覆盖集中库的运行默认选择。
          next = validatePresetState(merged);
        }
        const saved = store.save(next);
        saved.active_preset_id = body.selectedPresetId ?? body.state?.active_preset_id ?? saved.active_preset_id;
        json(res, 200, { state: saved, macros: await getMacros() });
      } else if (path === '/preview' && req.method === 'POST') {
        if (typeof preview !== 'function') throw new Error('编排引擎尚未接入');
        const body = await readBody(req);
        const state = validatePresetState(body.state ?? store.load());
        json(res, 200, await preview({ ...body, state }));
      } else json(res, 405, { error: '不支持的请求方法' });
    } catch (error) {
      json(res, 400, { error: error?.message || String(error) });
    }
    return true;
  };
}
