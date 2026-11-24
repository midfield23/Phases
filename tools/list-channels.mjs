#!/usr/bin/env node
/**
 * list-channels.mjs — READ-ONLY. Every track and bus with its ids and inserts, as the SDK sees
 * them. For working out which channel a command will reach.
 *
 *   node tools/list-channels.mjs
 */
import { connect, sleep } from '../lib/live.mjs';

const { luna, session } = await connect();
const channels = session.channelsInOrder;
for (const ch of channels) await ch.effects.load().catch(() => {});
await sleep(300);

for (const ch of channels) {
  const kind = ch.trackType?.value ?? (ch.constructor?.name ?? '?');
  console.log(`\n${String(ch.name.value).padEnd(20)} type=${kind}  path-id=${ch.id}  uid=${ch.uid.value}` +
    (ch.uid.value && ch.uid.value !== ch.id ? '   <-- path id and uid DIFFER' : ''));
  for (const s of ch.effectSlots) {
    const id = s.pluginId.value;
    if (id === null || id === '') continue;
    console.log(`   ${s.id.padEnd(10)} ${String(s.pluginName.value ?? '').padEnd(30)} ${id === undefined ? '(not loaded)' : id}`);
  }
}
await luna.close();
