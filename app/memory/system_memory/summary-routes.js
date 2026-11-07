/** 本功能的管理 API，宿主只负责分发。 */
import { json } from '../../common/http.js';
import { readMessages } from '../common/conversations.js';
import { batches } from './repository.js';
import { summarizeRange } from './service.js';
export async function handleSummary({ req, res, api, body, query, character, ctx, running }) {
      if (req.method === 'GET' && api === '/messages/count') {
        if (!character) return json(res, 400, { ok: false, error: '缺少 character' });
        const start = query.get('start') || new Date(Date.now() - 86400000).toISOString();
        const end = query.get('end') || new Date().toISOString();
        return json(res, 200, { ok: true, count: readMessages(character, start, end).length, start, end });
      }
      if (req.method === 'GET' && api === '/batches') {
        return json(res, 200, { ok: true, batches: batches(character, 80) });
      }
      if (req.method === 'POST' && api === '/summarize') {
        if (!character) return json(res, 400, { ok: false, error: '缺少 character' });
        if (running.has(character)) return json(res, 409, { ok: false, error: '该角色正在总结中' });
        running.add(character);
        try {
          const result = await summarizeRange(ctx, {
            character,
            start: body.start || undefined,
            end: body.end || undefined,
            debug: Boolean(body.debug),
          });
          return json(res, 200, { ok: true, result });
        } finally {
          running.delete(character);
        }
      }

  return json(res, 404, { error: '接口不存在' });
}
