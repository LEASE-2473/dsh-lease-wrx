/** 本功能的管理 API，宿主只负责分发。 */
import { json } from '../../common/http.js';
import { readSelf, writeSelf } from './repository.js';
import { characterDoc, updateCharacterDoc } from './information.js';
export async function handleAssistant({ req, res, api, body, query, character, ctx, running }) {
      if (req.method === 'GET' && api === '/self') {
        return json(res, 200, { ok: true, self: readSelf() });
      }
      if (req.method === 'POST' && api === '/self') {
        return json(res, 200, { ok: true, self: writeSelf(body) });
      }
      if (req.method === 'GET' && api === '/character') {
        if (!character) return json(res, 400, { ok: false, error: '缺少 character' });
        return json(res, 200, { ok: true, character: characterDoc(character) });
      }
      if (req.method === 'POST' && api === '/character') {
        if (!character) return json(res, 400, { ok: false, error: '缺少 character' });
        return json(res, 200, { ok: true, character: updateCharacterDoc(character, body.fields || {}) });
      }

  return json(res, 404, { error: '接口不存在' });
}
