import { expect, it } from 'vitest';
import { createHostHandshake, exportPublicKeyJwk, generateEcdhKeyPair } from './e2ee.js';
import * as hostCodec from './tunnel-codec.js';

import { createClientHandshake } from './client-handshake.test-helper.js';

const clientCodec = await import(new URL('../../../../ui/src/lib/relay/tunnel-codec.ts', import.meta.url).href) as Pick<
  typeof hostCodec, 'encodeTunnelFrame' | 'decodeTunnelFrame' | 'encodeFrameBatch' | 'decodeFrameBatch'
>;

async function peers(hostBatch = true, clientBatch = true) {
  const keys = await generateEcdhKeyPair();
  const publicKey = await exportPublicKeyJwk(keys.publicKey);
  const host = createHostHandshake(keys.privateKey, { batch: hostBatch });
  const client = await createClientHandshake(publicKey, { batch: clientBatch });
  const accepted = await host.handleText(client.helloText);
  if (accepted.type !== 'established') throw new Error(`Host handshake: ${accepted.type}`);
  const ready = await client.handleText(accepted.replyText);
  if (ready.type !== 'established') throw new Error(`Client handshake: ${ready.type}`);
  return { host, client, publicKey, accepted, ready };
}

it.each([[true, true], [false, true], [true, false]])(
  'real peers negotiate batching (%s, %s) and exchange encrypted tunnel frames in both directions', async (hostBatch, clientBatch) => {
    const { accepted, ready } = await peers(hostBatch, clientBatch);
    const batched = hostBatch && clientBatch;
    expect(accepted.batch).toBe(batched);
    expect(ready.batch).toBe(batched);
    for (const [sender, receiver, encoder, decoder] of [
      [ready.channel, accepted.channel, clientCodec, hostCodec],
      [accepted.channel, ready.channel, hostCodec, clientCodec],
    ] as const) {
      // High stream ids are unsigned on both sides. Payload bytes must survive, not
      // merely round-trip through one implementation's matching encoder/decoder.
      const payload = new Uint8Array([0, 255, 128, 13, 10]);
      const frame = encoder.encodeTunnelFrame(hostCodec.TunnelFrameType.HttpBody, 0xfffffffd, payload);
      const wire = batched ? encoder.encodeFrameBatch([frame, frame]) : frame;
      const plaintext = await receiver.decryptor.decrypt(await sender.encryptor.encrypt(wire));
      const frames = batched ? decoder.decodeFrameBatch(plaintext) : [plaintext];
      expect(frames).toHaveLength(batched ? 2 : 1);
      for (const received of frames) expect(decoder.decodeTunnelFrame(received)).toMatchObject({
        frameType: hostCodec.TunnelFrameType.HttpBody, streamId: 0xfffffffd, payload,
      });
    }
  },
);

it('rejects foreign-session frames, tampering and replay at both real endpoints', async () => {
  const { accepted, ready } = await peers();
  const foreign = await peers();
  await expect(accepted.channel.decryptor.decrypt(await foreign.ready.channel.encryptor.encrypt(new Uint8Array([9])))).rejects.toThrow();
  await expect(ready.channel.decryptor.decrypt(await foreign.accepted.channel.encryptor.encrypt(new Uint8Array([9])))).rejects.toThrow();
  for (const [sender, receiver] of [[ready.channel, accepted.channel], [accepted.channel, ready.channel]] as const) {
    const original = await sender.encryptor.encrypt(new Uint8Array([9]));
    const tampered = original.slice();
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    await expect(receiver.decryptor.decrypt(tampered)).rejects.toThrow();
    await expect(receiver.decryptor.decrypt(original)).resolves.toEqual(new Uint8Array([9]));
    await expect(receiver.decryptor.decrypt(original)).rejects.toThrow();
  }
});

it('replies to a repeated hello, refuses rekey and fails closed on plaintext after ready', async () => {
  const { host, client, publicKey, accepted } = await peers();
  expect(await host.handleText(client.helloText)).toEqual({ type: 'send-text', text: accepted.replyText });
  const other = await createClientHandshake(publicKey);
  expect(await host.handleText(other.helloText)).toMatchObject({ type: 'fail', closeCode: 1008 });
  const fresh = await peers();
  expect(await fresh.host.handleText(JSON.stringify({ hello: 'not a handshake' })))
    .toMatchObject({ type: 'fail', closeCode: 1011 });
});
