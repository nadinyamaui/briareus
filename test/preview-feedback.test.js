import { expect, it } from 'vitest';
import { previewFeedback } from '../lib/preview-feedback.js';
const job = { kind: 'devchat', serveLinks: [{ url: 'https://preview.example/' }] };
const input = {
  url: 'https://preview.example/cart?mobile=1',
  width: 390,
  height: 844,
  x: 10,
  y: 20,
  text: 'Move this button',
};
const file = { name: 'preview-feedback.png', size: 1024 };
it('delivers exact visual context and distinguishes image pixels from viewport pixels', () => {
  expect(previewFeedback(job, input, file)).toContain('not necessarily CSS viewport pixels');
  expect(previewFeedback(job, input, file)).toContain(input.url);
});
it('rejects foreign preview origins, credentials, invalid points and absent attachments', () => {
  for (const bad of [
    { url: 'https://other.example/' },
    { url: 'https://user@preview.example/' },
    { x: 390 },
    { y: -1 },
    { width: 0 },
    { text: '' },
  ])
    expect(() => previewFeedback(job, { ...input, ...bad }, file)).toThrow();
  expect(() => previewFeedback(job, input, null)).toThrow();
});
