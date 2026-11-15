import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createProvider } from '../provider/server.mjs';
async function withSource(context) {
  const service = createProvider(); service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const control = value => fetch(base + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { base, control, post };
}

test('索引故意逆序且编码分段使用真实字节范围', async context => {
  const { base } = await withSource(context); const rows = await (await fetch(base + '/groups/repair/overview')).json(); assert.equal(rows[0].messageId, '<part-2@local>');
  const raw = Buffer.from(await (await fetch(base + '/articles/2')).arrayBuffer()); assert.match(raw.toString('latin1'), /begin=7 end=12/); assert.match(raw.toString('latin1'), /crc32=/);
});
test('交叉发布保持Message-ID而替代段有新身份', async context => {
  const { base, control } = await withSource(context); const first = await (await fetch(base + '/groups/repair/overview')).json(); const cross = await (await fetch(base + '/groups/tour/overview')).json(); assert.equal(first[0].messageId, cross[0].messageId);
  await control({ replacement: true }); const rows = await (await fetch(base + '/groups/repair/overview')).json(); assert.equal(rows.at(-1).replacementOf, '<part-1@local>');
});
