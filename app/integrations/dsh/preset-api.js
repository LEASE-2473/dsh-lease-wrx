import { currentRole } from '../../common/role-context.js';
import { presetStore } from '../../preset/store.js';
/** 预设 UI/API 接入；编排器不依赖 HTTP 和 DSH ctx。 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_DIR } from '../../common/paths.js';
import { createPresetHandler } from '../../preset/routes.js';
import { compilePrompt } from '../../prompting/compiler/index.js';
import { listMacros } from '../../prompting/macros/index.js';
import { presentRequest } from './request-presentation.js';

export function createPresetApi({ sources = () => ({}), loadConfig, getSourceCatalog = () => [] }) {
  return createPresetHandler({ store: {
    load: () => presetStore.loadForRole(),
    save: value => {
      if (!currentRole()) throw new Error('保存预设必须指定管理角色');
      return presetStore.save({ ...value, active_preset_id: presetStore.load().active_preset_id });
    },
  }, getMacros: () => [...listMacros(), ...getSourceCatalog()], preview: ({ state, history = [], currentUser = '', historyWindow, timestamps, midConversationSystem, excludeModelSelection }) => {
    if (!Array.isArray(history)) throw new Error('历史必须是消息数组');
    const messages = [...history, { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: String(currentUser) }] }];
    const { _historyWindow, _sharedHistory, ...provided } = sources({ historyWindow });
    const config = loadConfig();
    const result = compilePrompt({ state, messages, sources: provided, historyWindow: _historyWindow, sharedHistory: _sharedHistory, historyTurns: config.prompting?.historyTurns ?? 30 });
    const rendered = presentRequest(result.messages, { excludeModelSelection: excludeModelSelection ?? config.prompting?.excludeModelSelection, timestamps: timestamps ?? config.prompting?.timestamps, midConversationSystem: midConversationSystem ?? config.prompting?.midConversationSystem, timeZone: config.timezone });
    return { ...result, messages: rendered.messages, warnings: [...result.warnings, ...rendered.warnings] };
  } });
}
export function servePresetUi(req, res) {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname.endsWith('/preset-ui')) {
    res.statusCode = 302;
    res.setHeader('location', pathname + '/');
    res.end();
    return;
  }
  const name = pathname.split('/').at(-1) || 'index.html';
  const types = { 'index.html': 'text/html', 'inspector.html': 'text/html', 'editor.js': 'text/javascript', 'slots.js': 'text/javascript', 'history-window.js': 'text/javascript', 'editor.css': 'text/css' };
  if (req.method !== 'GET' || !types[name]) { res.statusCode = 404; res.end('not found'); return; }
  res.statusCode = 200;
  res.setHeader('content-type', types[name] + '; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(readFileSync(join(PLUGIN_DIR, 'app', 'preset', 'ui', name)));
}
