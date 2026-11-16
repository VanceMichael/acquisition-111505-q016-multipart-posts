import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Archive } from '../src/archive.mjs';
import { collect } from '../src/collect.mjs';
import { crc32hex } from '../src/yenc.mjs';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';
import { encodePost, fakeSource } from './fakes.mjs';

async function withArchive(context) {
  const directory = await mkdtemp(join(tmpdir(), 'collect-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return new Archive(directory).initialize();
}

async function withProvider(context) {
  const service = createProvider(); service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const control = value => fetch(`${base}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { base, control };
}

const recordsOfKind = async (archive, kind) => (await archive.list()).filter(record => record.versions.at(-1).data.kind === kind);

test('默认情景按真实字节范围交付完整文件，标题逆序不影响组装', async context => {
  const { base } = await withProvider(context);
  const archive = await withArchive(context);
  const report = await collect({ archive, source: base, probe: '/groups/repair/overview' });
  const set = report.fileSets.find(item => item.fileSet === 'restoration-a');
  assert.equal(set.delivered.length, 1);
  assert.deepEqual([set.delivered[0].name, set.delivered[0].size], ['notes.txt', 12]);
  assert.equal(set.delivered[0].crc32, crc32hex(Buffer.from('repair-notes')));
  const [file] = await recordsOfKind(archive, 'file');
  assert.equal((await archive.bytes(file.versions[0].sha256)).toString(), 'repair-notes');
  const segments = await recordsOfKind(archive, 'segment');
  assert.equal(segments.length, 2);
  const part1 = (await archive.list()).find(record => record.identity.message === '<part-1@local>');
  assert.equal((await archive.bytes(part1.versions[0].sha256)).toString(), 'repair');
});

test('缺段时保管已验真分段但不交付', async context => {
  const { base, control } = await withProvider(context);
  await control({ missing: true });
  const archive = await withArchive(context);
  const report = await collect({ archive, source: base, probe: '/groups/repair/overview' });
  const set = report.fileSets[0];
  assert.equal(set.delivered.length, 0);
  assert.equal(set.custody.length, 1);
  assert.deepEqual(set.incomplete[0].gaps, [[1, 6]]);
  assert.equal((await recordsOfKind(archive, 'file')).length, 0);
  assert.equal((await recordsOfKind(archive, 'segment')).length, 1);
});

test('已过期正文留依据且不当作缺段以外的材料', async context => {
  const { base, control } = await withProvider(context);
  await control({ expired: true });
  const archive = await withArchive(context);
  const report = await collect({ archive, source: base, probe: '/groups/repair/overview' });
  const set = report.fileSets[0];
  assert.equal(set.delivered.length, 0);
  assert.deepEqual(set.evidence.map(e => [e.category, e.target]), [['expired', '<part-1@local>']]);
  const [evidence] = await recordsOfKind(archive, 'evidence');
  assert.equal(evidence.versions[0].data.category, 'expired');
  assert.equal(evidence.versions[0].data.status, 410);
});

test('替代分段取代原帖并分别留依据', async context => {
  const { base, control } = await withProvider(context);
  await control({ replacement: true });
  const archive = await withArchive(context);
  const report = await collect({ archive, source: base, probe: '/groups/repair/overview' });
  const set = report.fileSets[0];
  assert.equal(set.delivered.length, 1);
  const [file] = await recordsOfKind(archive, 'file');
  assert.deepEqual(file.versions[0].data.segments.map(s => s.messageId), ['<part-1-replacement@local>', '<part-2@local>']);
  assert.equal((await archive.bytes(file.versions[0].sha256)).toString(), 'repair-notes');
  assert.deepEqual(set.evidence.map(e => [e.category, e.target]), [['replaced', '<part-1@local>']]);
});

test('替代分段内容被篡改时整体验证拦截且不交付', async context => {
  const { base, control } = await withProvider(context);
  await control({ replacement: true, conflict: true });
  const archive = await withArchive(context);
  const report = await collect({ archive, source: base, probe: '/groups/repair/overview' });
  const set = report.fileSets[0];
  assert.equal(set.delivered.length, 0);
  assert.deepEqual(set.evidence.map(e => [e.category, e.target]).sort(), [['invalid', '<part-2@local>'], ['replaced', '<part-1@local>']]);
  assert.equal(set.custody.length, 2);
  assert.match(set.incomplete[0].reason, /整体 crc32 不符/);
  assert.equal((await recordsOfKind(archive, 'file')).length, 0);
});

test('交叉发布去重、同名不同集合不混拼、撤回与缺整体CRC分别处理', async context => {
  const alpha = Buffer.from('ALPHA-ONE!');
  const beta = Buffer.from('BETA--TWO!');
  const gamma = Buffer.from('GAMMA-NOCRC!');
  const delta1 = Buffer.from('DELTA');
  const delta2 = Buffer.from('-CON!');
  const delta2b = Buffer.from('-XXXX');
  const epsilon = Buffer.from('EPSILON-OK');
  const index = [
    { articleNumber: 2, messageId: '<a2@local>', subject: 'same.txt 第二段', fileSetId: 'alpha', bodyHref: '/articles/a2' },
    { articleNumber: 1, messageId: '<a1@local>', subject: 'same.txt 第一段', fileSetId: 'alpha', bodyHref: '/articles/a1' },
    { articleNumber: 9, messageId: '<a1@local>', subject: 'same.txt 交叉发布', fileSetId: 'alpha', bodyHref: '/articles/a1' },
    { articleNumber: 3, messageId: '<b1@local>', subject: 'same.txt 第一段', fileSetId: 'beta', bodyHref: '/articles/b1' },
    { articleNumber: 4, messageId: '<b2@local>', subject: 'same.txt 第二段', fileSetId: 'beta', bodyHref: '/articles/b2' },
    { articleNumber: 5, messageId: '<cancel-1@local>', fileSetId: 'beta', cancel: '<b2@local>' },
    { articleNumber: 6, messageId: '<g1@local>', subject: 'nocrc 一', fileSetId: 'gamma', bodyHref: '/articles/g1' },
    { articleNumber: 7, messageId: '<g2@local>', subject: 'nocrc 二', fileSetId: 'gamma', bodyHref: '/articles/g2' },
    { articleNumber: 10, messageId: '<d1@local>', subject: 'delta 一', fileSetId: 'delta', bodyHref: '/articles/d1' },
    { articleNumber: 11, messageId: '<d2@local>', subject: 'delta 二', fileSetId: 'delta', bodyHref: '/articles/d2' },
    { articleNumber: 12, messageId: '<d2b@local>', subject: 'delta 二改', fileSetId: 'delta', bodyHref: '/articles/d2b' },
    { articleNumber: 13, messageId: '<e1@local>', subject: 'epsilon 一', fileSetId: 'epsilon', bodyHref: '/articles/e1' },
    { articleNumber: 14, messageId: '<e2@local>', subject: 'epsilon 二', fileSetId: 'epsilon', bodyHref: '/articles/e2' },
    { articleNumber: 15, messageId: '<z1@local>', subject: 'zeta 唯一段', fileSetId: 'zeta', bodyHref: '/articles/z1' },
  ];
  const { requestImpl, counts } = fakeSource({
    '/index': Buffer.from(JSON.stringify(index)),
    '/articles/a1': encodePost({ name: 'same.txt', totalSize: 10, part: 1, total: 2, begin: 1, end: 5, bytes: alpha.subarray(0, 5) }),
    '/articles/a2': encodePost({ name: 'same.txt', totalSize: 10, part: 2, total: 2, begin: 6, end: 10, bytes: alpha.subarray(5), wholeCrc: crc32hex(alpha) }),
    '/articles/b1': encodePost({ name: 'same.txt', totalSize: 10, part: 1, total: 2, begin: 1, end: 5, bytes: beta.subarray(0, 5) }),
    '/articles/b2': encodePost({ name: 'same.txt', totalSize: 10, part: 2, total: 2, begin: 6, end: 10, bytes: beta.subarray(5), wholeCrc: crc32hex(beta) }),
    '/articles/g1': encodePost({ name: 'nocrc.bin', totalSize: 12, part: 1, total: 2, begin: 1, end: 6, bytes: gamma.subarray(0, 6) }),
    '/articles/g2': encodePost({ name: 'nocrc.bin', totalSize: 12, part: 2, total: 2, begin: 7, end: 12, bytes: gamma.subarray(6) }),
    '/articles/d1': encodePost({ name: 'delta.bin', totalSize: 10, part: 1, total: 2, begin: 1, end: 5, bytes: delta1 }),
    '/articles/d2': encodePost({ name: 'delta.bin', totalSize: 10, part: 2, total: 2, begin: 6, end: 10, bytes: delta2, wholeCrc: crc32hex(Buffer.concat([delta1, delta2])) }),
    '/articles/d2b': encodePost({ name: 'delta.bin', totalSize: 10, part: 2, total: 2, begin: 6, end: 10, bytes: delta2b }),
    '/articles/e1': encodePost({ name: 'epsilon.bin', totalSize: 10, part: 1, total: 2, begin: 1, end: 5, bytes: epsilon.subarray(0, 5) }),
    '/articles/e2': encodePost({ name: 'epsilon.bin', totalSize: 10, part: 2, total: 2, begin: 6, end: 10, bytes: epsilon.subarray(5), wholeCrc: crc32hex(Buffer.from('WRONG-CRC!')) }),
    '/articles/z1': encodePost({ name: 'zeta.bin', totalSize: 5, part: 1, total: 1, begin: 1, end: 5, bytes: Buffer.from('ZETA1'), pcrc: '00000000', wholeCrc: crc32hex(Buffer.from('ZETA1')) }),
  });
  const archive = await withArchive(context);
  const report = await collect({ archive, source: 'http://127.0.0.1:9', probe: '/index', requestImpl });

  const alphaSet = report.fileSets.find(set => set.fileSet === 'alpha');
  assert.equal(alphaSet.delivered.length, 1);
  assert.deepEqual(alphaSet.crossPosts, ['<a1@local>']);
  assert.equal(counts.get('/articles/a1'), 1);
  const alphaFile = (await recordsOfKind(archive, 'file')).find(record => record.identity.fileSet === 'alpha');
  assert.equal((await archive.bytes(alphaFile.versions[0].sha256)).toString(), 'ALPHA-ONE!');

  const betaSet = report.fileSets.find(set => set.fileSet === 'beta');
  assert.equal(betaSet.delivered.length, 0);
  assert.deepEqual(betaSet.evidence.map(e => [e.category, e.target]), [['retracted', '<b2@local>']]);
  assert.equal(counts.get('/articles/b2'), undefined);
  assert.equal((await recordsOfKind(archive, 'segment')).filter(record => record.identity.fileSet === 'beta').length, 1);

  const gammaSet = report.fileSets.find(set => set.fileSet === 'gamma');
  assert.equal(gammaSet.delivered.length, 0);
  assert.equal(gammaSet.custody.length, 2);
  assert.match(gammaSet.incomplete[0].reason, /整体 crc32/);

  const deltaSet = report.fileSets.find(set => set.fileSet === 'delta');
  assert.equal(deltaSet.delivered.length, 0);
  assert.equal(deltaSet.custody.length, 3);
  assert.deepEqual(deltaSet.evidence.map(e => e.category), ['conflict']);

  const epsilonSet = report.fileSets.find(set => set.fileSet === 'epsilon');
  assert.equal(epsilonSet.delivered.length, 0);
  assert.deepEqual(epsilonSet.evidence.map(e => [e.category, e.target]), [['invalid', '<e2@local>']]);

  const zetaSet = report.fileSets.find(set => set.fileSet === 'zeta');
  assert.equal(zetaSet.delivered.length, 0);
  assert.equal(zetaSet.custody.length, 0);
  assert.deepEqual(zetaSet.evidence.map(e => [e.category, e.target]), [['invalid', '<z1@local>']]);
});

test('HTTP 采集入口端到端交付并拒绝非本地来源', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'collect-http-'));
  const intake = await createIntake(directory);
  const provider = createProvider();
  intake.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1');
  await Promise.all([once(intake, 'listening'), once(provider, 'listening')]);
  context.after(async () => {
    intake.closeAllConnections(); provider.closeAllConnections();
    await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${intake.address().port}`;
  const source = `http://127.0.0.1:${provider.address().port}`;
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const response = await post('/api/collect', { source });
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.summary.delivered, 1);
  const records = await (await fetch(`${base}/api/records`)).json();
  const file = records.find(record => record.versions.at(-1).data.kind === 'file');
  assert.equal(file.versions[0].data.name, 'notes.txt');
  assert.equal(file.versions[0].data.size, 12);

  const denied = await post('/api/collect', { source: 'http://192.0.2.1:4200' });
  assert.equal(denied.status, 403);
  const invalid = await fetch(`${base}/api/collect`, { method: 'POST', body: '{' });
  assert.equal(invalid.status, 400);
});
