import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const intake = await createIntake(directory);
const provider = createProvider();
try {
  intake.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1');
  await Promise.all([once(intake, 'listening'), once(provider, 'listening')]);
  const base = `http://127.0.0.1:${intake.address().port}`;
  const source = `http://127.0.0.1:${provider.address().port}`;
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const collect = async () => (await (await post(`${base}/api/collect`, { source })).json());

  const first = await collect();
  console.log(JSON.stringify({ 默认情景: first.summary, 交付: first.fileSets.flatMap(set => set.delivered.map(file => `${file.name} ${file.size}字节 crc32=${file.crc32}`)) }));

  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  const manual = await (await post(`${base}/api/manual`, sample)).json();
  console.log(JSON.stringify({ 人工收件: { 版本: manual.version, 摘要: manual.rawSha256.slice(0, 12) } }));

  await post(`${source}/__control`, { replacement: true, conflict: true });
  const second = await collect();
  console.log(JSON.stringify({ 替代段冲突情景: second.summary, 依据: second.fileSets.flatMap(set => set.evidence.map(e => `${e.category}:${e.target}`)) }));

  await post(`${source}/__control`, { replacement: false, conflict: false, missing: true });
  const third = await collect();
  console.log(JSON.stringify({ 缺段情景: third.summary, 缺口: third.fileSets.flatMap(set => set.incomplete.map(file => `${file.name} 缺 ${JSON.stringify(file.gaps)}`)) }));

  const records = await (await fetch(`${base}/api/records`)).json();
  console.log(JSON.stringify({ 归档记录: records.map(record => ({ 来源: record.source, 身份: record.identity, 版本数: record.versions.length, 类型: record.versions.at(-1).data.kind ?? 'manual' })) }));
} finally {
  intake.closeAllConnections(); provider.closeAllConnections();
  await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]);
  await rm(directory, { recursive: true, force: true });
}
