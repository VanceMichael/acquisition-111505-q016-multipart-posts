import { crc32hex } from '../src/yenc.mjs';

export function encodePost({ name, totalSize, part = 1, total = 1, begin, end, bytes, withPcrc = true, pcrc = null, wholeCrc = null }) {
  const encoded = [];
  for (const value of bytes) {
    const next = (value + 42) & 255;
    if ([0, 10, 13, 61].includes(next)) encoded.push(61, (next + 64) & 255);
    else encoded.push(next);
  }
  let head = `=ybegin part=${part} total=${total} line=128 size=${totalSize} name=${name}\r\n`;
  if (begin !== undefined) head += `=ypart begin=${begin} end=${end}\r\n`;
  let tail = `\r\n=yend size=${bytes.length} part=${part}`;
  if (pcrc ?? withPcrc) tail += ` pcrc32=${pcrc ?? crc32hex(bytes)}`;
  if (wholeCrc) tail += ` crc32=${wholeCrc}`;
  tail += '\r\n';
  return Buffer.concat([Buffer.from(head, 'latin1'), Buffer.from(encoded), Buffer.from(tail, 'latin1')]);
}

export function fakeSource(routes) {
  const counts = new Map();
  const requestImpl = async url => {
    const { pathname } = new URL(url);
    counts.set(pathname, (counts.get(pathname) ?? 0) + 1);
    const route = routes[pathname];
    if (!route) return { status: 404, headers: {}, bytes: Buffer.from('not found') };
    if (Buffer.isBuffer(route)) return { status: 200, headers: {}, bytes: route };
    return { status: route.status, headers: {}, bytes: route.bytes ?? Buffer.from(JSON.stringify(route.body ?? '')) };
  };
  return { requestImpl, counts };
}
