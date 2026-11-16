const ESCAPE = 61; // '='

export function crc32hex(bytes) {
  let crc = -1;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return ((crc ^ -1) >>> 0).toString(16).padStart(8, '0');
}

function tokenFields(line) {
  const out = {};
  for (const token of line.trim().split(/\s+/)) {
    if (!token) continue;
    const eq = token.indexOf('=');
    if (eq === -1) throw new Error(`无法解析的字段 ${token}`);
    out[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return out;
}

function beginFields(line) {
  const marker = line.indexOf(' name=');
  const out = tokenFields(marker === -1 ? line : line.slice(0, marker));
  if (marker !== -1) out.name = line.slice(marker + ' name='.length);
  return out;
}

function decodePayload(encoded) {
  const out = [];
  for (let index = 0; index < encoded.length; index++) {
    let value = encoded[index];
    if (value === ESCAPE) {
      index++;
      if (index >= encoded.length) throw new Error('转义序列在末尾截断');
      value = (encoded[index] - 64) & 255;
    }
    out.push((value - 42) & 255);
  }
  return Buffer.from(out);
}

export function parsePost(raw) {
  const lines = raw.toString('latin1').split(/\r\n|\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length < 2 || !lines[0].startsWith('=ybegin ')) throw new Error('报文缺少 =ybegin 头');
  const begin = beginFields(lines[0].slice('=ybegin '.length));
  let cursor = 1;
  let part = null;
  if (lines[cursor]?.startsWith('=ypart ')) { part = tokenFields(lines[cursor].slice('=ypart '.length)); cursor++; }
  const dataLines = [];
  let endLine = null;
  for (; cursor < lines.length; cursor++) {
    if (lines[cursor].startsWith('=yend')) { endLine = lines[cursor]; break; }
    dataLines.push(lines[cursor]);
  }
  if (endLine === null) throw new Error('报文缺少 =yend 尾');
  const end = tokenFields(endLine.startsWith('=yend ') ? endLine.slice('=yend '.length) : '');
  return { begin, part, end, data: decodePayload(Buffer.from(dataLines.join(''), 'latin1')) };
}

export function decodeSegment(raw) {
  const post = parsePost(raw);
  const name = post.begin.name;
  if (!name) throw new Error('=ybegin 缺少 name');
  const totalSize = Number(post.begin.size);
  if (!Number.isInteger(totalSize) || totalSize <= 0) throw new Error('=ybegin size 无效');
  const begin = post.part ? Number(post.part.begin) : 1;
  const end = post.part ? Number(post.part.end) : Number(post.end.size);
  if (!Number.isInteger(begin) || !Number.isInteger(end) || begin < 1 || end < begin || end > totalSize) {
    throw new Error(`=ypart 范围 ${begin}..${end} 超出 1..${totalSize}`);
  }
  const bytes = post.data;
  if (bytes.length !== end - begin + 1) throw new Error(`解码长度 ${bytes.length} 与声明范围 ${begin}..${end} 不符`);
  if (Number(post.end.size) !== bytes.length) throw new Error('=yend size 与解码长度不符');
  const pcrc32 = post.end.pcrc32?.toLowerCase();
  if (!pcrc32) throw new Error('缺少 pcrc32，分段无法验真');
  if (crc32hex(bytes) !== pcrc32) throw new Error('pcrc32 与解码内容不符');
  return { name, totalSize, begin, end, bytes, pcrc32, wholeCrc: post.end.crc32 ? post.end.crc32.toLowerCase() : null };
}
