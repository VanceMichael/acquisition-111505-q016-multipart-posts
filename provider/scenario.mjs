export const initialState = () => ({ name: '内部协作新闻组', revision: 1 });

import { deflateSync } from 'node:zlib';
function crc32(bytes) { let crc = -1; for (const value of bytes) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return ((crc ^ -1) >>> 0).toString(16).padStart(8, '0'); }
const content = Buffer.from('repair-notes');
function part(number, conflict) {
  const start = number === 1 ? 0 : 6; const raw = Buffer.from(content.subarray(start, start + 6)); if (conflict) raw[0] ^= 1;
  const encoded = []; for (const value of raw) { const next = (value + 42) & 255; if ([0, 10, 13, 61].includes(next)) encoded.push(61, (next + 64) & 255); else encoded.push(next); }
  return Buffer.concat([Buffer.from(`=ybegin part=${number} total=2 line=128 size=12 name=notes.txt\r\n=ypart begin=${start + 1} end=${start + 6}\r\n`), Buffer.from(encoded), Buffer.from(`\r\n=yend size=6 part=${number} pcrc32=${crc32(raw)}${number === 2 ? ' crc32=' + crc32(content) : ''}\r\n`)]);
}
export async function handle({ url, state, json, bytes }) {
  if (/^\/groups\/[^/]+\/overview$/.test(url.pathname)) { json(200, [
    { articleNumber: 12, messageId: '<part-2@local>', subject: 'notes.txt 第二段', fileSetId: 'restoration-a', bodyHref: '/articles/2' },
    ...(state.missing ? [] : [{ articleNumber: 14, messageId: '<part-1@local>', subject: 'notes.txt 第一段', fileSetId: 'restoration-a', bodyHref: '/articles/1' }]),
    ...(state.replacement ? [{ articleNumber: 15, messageId: '<part-1-replacement@local>', subject: 'notes.txt 更新段', fileSetId: 'restoration-a', bodyHref: '/articles/1-new', replacementOf: '<part-1@local>' }] : []) ]); return true; }
  if (url.pathname.startsWith('/articles/')) { if (state.expired && url.pathname.endsWith('/1')) json(410, { error: '正文过期' }); else bytes(200, part(url.pathname.endsWith('2') ? 2 : 1, state.conflict && url.pathname.endsWith('new')), 'application/octet-stream'); return true; }
  return false;
}
