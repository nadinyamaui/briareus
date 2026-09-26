import { createECDH } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createNotificationService, notificationGroups, pushSubscription } from '../lib/notifications.js';
const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const sub = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/test',
  keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: Buffer.alloc(16).toString('base64url') },
};
const items = [
  { id: 's:ask', sessionId: 's', repo: 'a/b', summary: 'private question' },
  { id: 's:findings', sessionId: 's', repo: 'a/b', summary: 'private finding' },
];
function fixture(send = vi.fn(async () => {})) {
  let stored;
  const options = {
    load: async () => stored || { vapid: null, subscriptions: [] },
    save: async (_key, s) => {
      stored = structuredClone(s);
    },
    send,
    keys: () => ({ publicKey: 'public', privateKey: 'private' }),
  };
  return { service: createNotificationService(options), options, send };
}
it('groups a task and never includes private text in notification payloads', () => {
  const groups = notificationGroups(items);
  expect(groups).toHaveLength(1);
  expect(JSON.stringify(groups[0].payload)).not.toContain('private');
});
it('deduplicates across polls and restarts, then notifies when resolved work becomes pending again', async () => {
  const { service, options, send } = fixture();
  await service.init();
  await service.configure('mailto:operator@example.com');
  await service.subscribe(sub, ['a/b']);
  await service.tick(items);
  await service.tick(items);
  expect(send).toHaveBeenCalledTimes(1);
  const restarted = createNotificationService(options);
  await restarted.init();
  await restarted.tick(items);
  expect(send).toHaveBeenCalledTimes(1);
  await restarted.tick([]);
  await restarted.tick(items);
  expect(send).toHaveBeenCalledTimes(2);
  expect(service.status()).not.toHaveProperty('privateKey');
  expect(JSON.stringify(service.status())).not.toContain('private');
});
it('removes expired subscriptions and honors project filters', async () => {
  const send = vi.fn(async () => {
    throw Object.assign(new Error('gone'), { statusCode: 410 });
  });
  const { service } = fixture(send);
  await service.init();
  await service.configure('https://example.com/contact');
  await service.subscribe(sub, ['other/repo']);
  await service.tick(items);
  expect(send).not.toHaveBeenCalled();
  await service.subscribe(sub, ['a/b']);
  await service.tick(items);
  expect(service.status().subscriptions).toBe(0);
});
it('backs off failures and rejects arbitrary endpoints and invalid keys', async () => {
  const send = vi.fn(async () => {
    throw Error('offline');
  });
  const { service } = fixture(send);
  await service.init();
  await service.configure('mailto:op@example.com');
  await service.subscribe(sub);
  await service.tick(items);
  await service.tick(items);
  expect(send).toHaveBeenCalledTimes(1);
  for (const endpoint of [
    'http://127.0.0.1/',
    'https://fcm.googleapis.com.evil.example/',
    'https://fcm.googleapis.com:8443/',
    'https://user@fcm.googleapis.com/',
  ])
    expect(() => pushSubscription({ ...sub, endpoint })).toThrow();
  expect(() => pushSubscription({ ...sub, keys: { auth: 'invalid', p256dh: 'invalid' } })).toThrow();
});
