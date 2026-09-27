/* global clients */
self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data.json();
  } catch {
    return;
  }
  // All clicks lead back to our inbox, even if malformed data reaches the worker.
  const url = new URL(data.url || '/attention', self.location.origin);
  const target =
    url.origin === self.location.origin && url.pathname === '/attention'
      ? url.pathname + url.search
      : '/attention';
  event.waitUntil(
    self.registration.showNotification('Briareus needs your attention', {
      body: data.body || 'Open the attention inbox.',
      tag: data.tag || 'briareus-attention',
      data: { url: target },
    }),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const url = new URL(event.notification.data?.url || '/attention', self.location.origin);
      if (url.origin !== self.location.origin || url.pathname !== '/attention') return;
      const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((client) => client.url === url.href);
      if (existing) return existing.focus();
      return clients.openWindow(url.href);
    })(),
  );
});
