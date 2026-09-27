import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
it('opens only the same-origin attention inbox and displays generic grouped messages', async () => {
  const handlers = {},
    showNotification = vi.fn(async () => {}),
    openWindow = vi.fn();
  let pending;
  runInNewContext(readFileSync('public/push-worker.js', 'utf8'), {
    URL,
    self: {
      location: { origin: 'https://app.example' },
      registration: { showNotification },
      addEventListener: (name, handler) => {
        handlers[name] = handler;
      },
    },
    clients: { matchAll: async () => [], openWindow },
  });
  handlers.push({
    data: {
      json: () => ({ title: 'Untrusted title', body: '2 items', url: 'https://evil.example/', tag: 'task' }),
    },
    waitUntil: (p) => {
      pending = p;
    },
  });
  await pending;
  expect(showNotification.mock.calls[0][0]).toBe('Briareus needs your attention');
  expect(showNotification.mock.calls[0][1].data.url).toBe('/attention');
  handlers.notificationclick({
    notification: { close() {}, data: { url: '/attention?task=s' } },
    waitUntil: (p) => {
      pending = p;
    },
  });
  await pending;
  expect(openWindow).toHaveBeenCalledWith('https://app.example/attention?task=s');
});
