/** 本功能的管理 API，宿主只负责分发。 */
import { json } from '../../common/http.js';
import { loadConfig } from '../../common/config.js';
import { listRows, updateRow, insertRow, deleteRow, setMode } from './repository.js';
import { backfillVectors } from '../recall.js';
export async function handleSystemMemory({ req, res, api, body, query, character, ctx, running }) {
      if (req.method === 'GET' && api === '/memory') {
        if (!character) return json(res, 400, { ok: false, error: '缺少 character' });
        const kind = query.get('kind') || '';
        return json(res, 200, { ok: true, rows: listRows(character, kind || undefined) });
      }
      if (req.method === 'POST' && api === '/memory/update') {
        return json(res, 200, { ok: true, row: updateRow(character, body.id, body.fields || {}) });
      }
      if (req.method === 'POST' && api === '/memory/add') {
        const kind = String(body.kind || '');
        return json(res, 200, { ok: true, row: insertRow(character, kind, body.fields || {}, { conversationId: body.conversationId, start: body.start, end: body.end }) });
      }
      if (req.method === 'POST' && api === '/memory/delete') {
        return json(res, 200, { ok: true, ...deleteRow(character, body.id) });
      }
      if (req.method === 'POST' && api === '/memory/mode') {
        const cfg = loadConfig();
        return json(res, 200, { ok: true, row: setMode(character, body.id, body.mode, { vectorEnabled: cfg.vector.enabled }) });
      }
      if (req.method === 'POST' && api === '/memory/cool-all') {
        if (!loadConfig().vector.enabled) return json(res, 400, { ok: false, error: '向量记忆未启用，暂不能转冷（先用热记忆）' });
        // 转冷前先把向量补齐：没向量的记录一旦转冷就再也召不回来。
        const vectorized = await backfillVectors(character);
        const hot = listRows(character).filter((r) => r.mode === 'hot');
        for (const r of hot) setMode(character, r.id, 'cold', { vectorEnabled: true });
        return json(res, 200, { ok: true, cooled: hot.length, vectorized });
      }

  return json(res, 404, { error: '接口不存在' });
}
