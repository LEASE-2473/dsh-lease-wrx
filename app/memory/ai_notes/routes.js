/** 本功能的管理 API，宿主只负责分发。 */
import { json } from '../../common/http.js';
import { loadConfig } from '../../common/config.js';
import { listActivity } from './repository.js';
import { generateActivity } from './service.js';
export async function handleAiNotes({ req, res, api, body, query, character, ctx, running }) {
      if (req.method === 'GET' && api === '/activity') {
        return json(res, 200, { ok: true, notes: listActivity(character || null), enabled: loadConfig().activity.enabled });
      }
      // 转冷规则：日记 / 外出记录超过保留天数的标 cold（不删数据、不进上下文）。
      if (req.method === 'POST' && api === '/activity/generate') {
        if (!character) return json(res, 400, { ok: false, error: '缺少 character' });
        const out = await generateActivity(ctx, { character, hours: Number(body.hours) || 24, debug: Boolean(body.debug) });
        return json(res, 200, { ok: true, ...out });
      }

  return json(res, 404, { error: '接口不存在' });
}
