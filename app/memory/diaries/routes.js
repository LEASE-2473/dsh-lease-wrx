/** 本功能的管理 API，宿主只负责分发。 */
import { json } from '../../common/http.js';
import { listDiary, saveDiary } from './repository.js';
import { generateDiary } from './service.js';
import { generateInstantDiary } from './instant.js';
export async function handleDiaries({ req, res, api, body, query, character, ctx, running }) {
      if (req.method === 'GET' && api === '/diary') {
        return json(res, 200, { ok: true, diaries: listDiary(character || null) });
      }
      if (req.method === 'POST' && api === '/diary/generate') {
        if (!character) return json(res, 400, { ok: false, error: '缺少 character' });
        const out = await generateDiary(ctx, { character, date: body.date, debug: Boolean(body.debug) });
        return json(res, 200, { ok: true, ...out });
      }
      if (req.method === 'POST' && api === '/diary/instant') {
        if (!character) return json(res, 400, { ok: false, error: '缺少 character' });
        return json(res, 200, { ok: true, ...await generateInstantDiary(ctx, { character, sessionId: body.sessionId, date: body.date, startTime: body.startTime, endTime: body.endTime, scope: body.scope }) });
      }
      if (req.method === 'POST' && api === '/diary') {
        if (!character) return json(res, 400, { ok: false, error: '缺少 character' });
        const id = saveDiary(character, { date: body.date, title: body.title || '', content: body.content, tags: body.tags || [], hooks: body.hooks || [] });
        return json(res, 200, { ok: true, id });
      }

  return json(res, 404, { error: '接口不存在' });
}
