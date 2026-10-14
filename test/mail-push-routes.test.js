import express from 'express';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mailPushRoutes } from '../lib/mail-push-routes.js';
let server, base, service;
beforeEach(async () => {
  service = { gmailNotification: vi.fn(), outlookNotification: vi.fn() };
  const app = express();
  app.use(mailPushRoutes({ service }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/webhooks/mail`;
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});
const post = (path, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
it('returns the decoded Graph validation token in plain text before processing notifications', async () => {
  const res = await post('/outlook?validationToken=hello%2Bworld%3Ctag%3E', {});
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/plain');
  expect(await res.text()).toBe('hello+world<tag>');
  expect(service.outlookNotification).not.toHaveBeenCalled();
});
it('accepts notifications promptly and passes secrets for service authentication', async () => {
  expect((await post('/outlook', { value: [] })).status).toBe(202);
  expect(service.outlookNotification).toHaveBeenCalledWith({ value: [] });
  expect((await post('/gmail?token=secret', { message: { data: 'encoded' } })).status).toBe(204);
  expect(service.gmailNotification).toHaveBeenCalledWith({ message: { data: 'encoded' } }, 'secret');
});
it('rejects invalid authentication without accepting the notification', async () => {
  service.gmailNotification.mockImplementation(() => {
    throw Object.assign(new Error('Invalid mail push token'), { status: 401 });
  });
  expect((await post('/gmail', {})).status).toBe(401);
  service.outlookNotification.mockImplementation(() => {
    throw Object.assign(new Error('Invalid Outlook clientState'), { status: 401 });
  });
  expect((await post('/outlook', { value: [] })).status).toBe(401);
});
