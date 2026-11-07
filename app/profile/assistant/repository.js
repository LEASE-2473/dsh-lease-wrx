import { loadConfig } from '../../common/config.js';
import { readDocument, writeDocument } from '../documents.js';

const characterId = () => loadConfig().dshCharacters[0];

export function readSelf() {
  const profile = readDocument('assistant', 'profile', { entries: [], revision: 0 }, characterId());
  return { entries: Array.isArray(profile.entries) ? profile.entries : [], revision: profile.revision || 0 };
}

export function writeSelf({ entries }) {
  const current = readSelf();
  if (entries !== undefined && (!Array.isArray(entries) || entries.some(e => !e || typeof e !== 'object' || typeof e.content !== 'string'))) throw new Error('画像条目必须包含正文');
  const profile = { entries: Array.isArray(entries) ? entries.map(({ tag, keywords, content }) => ({ tag, keywords, content })) : current.entries, revision: current.revision + 1 };
  writeDocument('assistant', 'profile', profile, characterId());
  return profile;
}
