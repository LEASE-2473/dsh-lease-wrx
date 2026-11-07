/** 本功能的管理 API，宿主只负责分发。 */
import { json } from '../../common/http.js';
import { readUser, writeUser } from './repository.js';
export async function handleUser({ req, res, api, body, query, character, ctx, running }) {
      if (req.method === 'GET' && api === '/user') {
        return json(res, 200, { ok: true, user: readUser() });
      }
      if (req.method === 'POST' && api === '/user') {
        return json(res, 200, { ok: true, user: writeUser(body) });
      }
      // 角色画像：我自己的那份，结构跟用户画像一样（tag + keywords + content）。

  return json(res, 404, { error: '接口不存在' });
}
