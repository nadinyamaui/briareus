// @ts-check
import express from 'express';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { MAX_UPLOAD_BYTES } from './uploads.js';

// raw-body retains chunks plus the concatenated buffer: cap their combined payload
// at roughly 1 GiB across all HTTP file uploads, including ongoing publication.
let reserved = 0;
const leases = new WeakMap();
const raw = express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES, inflate: false });

async function compressedBody(req, encoding) {
  const decoders = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress };
  const create = Object.hasOwn(decoders, encoding) && decoders[encoding];
  if (!create) throw Object.assign(new Error('Unsupported content encoding'), { status: 415 });
  const stream = create();
  // Express's inflater does not finish its callback when the source request aborts.
  const aborted = () => stream.destroy(Object.assign(new Error('Request aborted'), { status: 400 }));
  req.once('aborted', aborted);
  req.once('error', aborted);
  req.pipe(stream);
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES)
        throw Object.assign(new Error('Files are limited to 500 MiB'), { status: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } catch (err) {
    req.resume();
    throw Object.assign(err, { status: err.status || 400 });
  } finally {
    req.removeListener('aborted', aborted);
    req.removeListener('error', aborted);
    req.unpipe(stream);
    stream.destroy();
  }
}

export function uploadBody(req, res, next) {
  // Native requests pass through both the API gateway and the destination router.
  if (leases.has(req)) return next();
  const length = Number(req.headers['content-length']);
  const size =
    (!req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity') &&
    req.headers['content-length'] !== undefined &&
    Number.isSafeInteger(length) &&
    length >= 0
      ? length
      : MAX_UPLOAD_BYTES;
  if (size > MAX_UPLOAD_BYTES) return res.status(413).json({ error: 'Files are limited to 500 MiB' });
  if (reserved + size > MAX_UPLOAD_BYTES)
    return res.set('Retry-After', '1').status(503).json({ error: 'Upload capacity is busy; retry shortly' });

  reserved += size;
  const lease = { parsing: true, handling: 0, ended: false, released: false, release: () => {} };
  lease.release = () => {
    if (lease.released || lease.parsing || lease.handling || !lease.ended) return;
    lease.released = true;
    reserved -= size;
    req.body = undefined;
    leases.delete(req);
  };
  leases.set(req, lease);
  const ended = () => {
    lease.ended = true;
    lease.release();
  };
  res.once('finish', ended);
  res.once('close', ended);
  const parsed = (err = null) => {
    lease.parsing = false;
    if (err) lease.ended = true;
    lease.release();
    if (res.destroyed) return;
    next(err);
  };
  const encoding = (req.headers['content-encoding'] || 'identity').toLowerCase();
  if (encoding === 'identity') raw(req, res, parsed);
  else
    compressedBody(req, encoding).then((body) => {
      req.body = body;
      parsed();
    }, parsed);
}

// A disconnected client must not free the budget while async storage still holds bytes.
export function uploadHandler(handler) {
  return async (req, res, next) => {
    const lease = leases.get(req);
    if (lease) lease.handling++;
    try {
      await handler(req, res, next);
    } finally {
      if (lease) {
        lease.handling--;
        lease.release();
      }
    }
  };
}
