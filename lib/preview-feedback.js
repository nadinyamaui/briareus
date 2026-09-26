// @ts-check
import { Router } from 'express';
import { assertAcceptingWork } from './recovery.js';
export function previewFeedback(job, input, upload) {
  if (!job || job.kind !== 'devchat' || job.orchestrator) throw new Error('Choose a session with a preview');
  let url;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error('Enter the preview page URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !job.serveLinks?.some((link) => new URL(link.url).origin === url.origin)
  )
    throw new Error('The page must belong to this session’s preview');
  const { width, height, x, y } = input;
  if (
    ![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 8192) ||
    ![x, y].every(Number.isFinite) ||
    x < 0 ||
    y < 0 ||
    x >= width ||
    y >= height
  )
    throw new Error('Capture a screenshot and mark a point within it');
  if (!upload || !/\.png$/i.test(upload.name) || upload.size > 25 * 1024 * 1024)
    throw new Error('Attach the annotated PNG screenshot');
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text || text.length > 12000) throw new Error('Write a comment of 1–12000 characters');
  return `Preview feedback from the user\nPage: ${url.href}\nScreenshot: ${width} × ${height} image pixels (not necessarily CSS viewport pixels).\nMarked point: (${Math.round(x)}, ${Math.round(y)}) in the attached image, ${((100 * x) / width).toFixed(1)}% from the left and ${((100 * y) / height).toFixed(1)}% from the top.\n\n${text}`;
}
export function previewFeedbackRoutes({ getJob, getUpload, sendMessage }) {
  const router = Router();
  router.get('/api/operations/preview/:id', (req, res) => {
    const job = getJob(req.params.id);
    if (!job || job.kind !== 'devchat') return res.status(404).json({ error: 'Session not found' });
    res.json({ title: job.title, links: job.serveLinks || [] });
  });
  router.post('/api/operations/preview/:id', (req, res) => {
    try {
      assertAcceptingWork();
      const text = previewFeedback(getJob(req.params.id), req.body || {}, getUpload(req.body?.uploadId));
      res.json({ session: sendMessage(req.params.id, text, [req.body.uploadId]) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  return router;
}
