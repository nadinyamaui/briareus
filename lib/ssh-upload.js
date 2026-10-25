// @ts-check
import fs from 'node:fs/promises';
import path from 'node:path';
import { hash } from 'node:crypto';
import { readWorkspaceFile } from './session-files.js';
import { slotOwner, slotPrepared } from './recovery.js';

export const MAX_SSH_UPLOAD_BYTES = 25 * 1024 * 1024;
const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";

// Bound both source reads and payloads retained by running SSH clients to ~100 MiB.
let inFlight = 0;
export async function withSshUpload(job, sourcePath, consume) {
  if (inFlight >= 4) throw new Error('SSH upload capacity is busy; wait for an upload to finish');
  inFlight++;
  try {
    return await consume(await readSshUpload(job, sourcePath));
  } finally {
    inFlight--;
  }
}

// Read only this session's workspace or attachments actually delivered to it.
// The shared uploads directory is never itself an allowed root.
async function readSshUpload(job, sourcePath) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || /[\x00-\x1f\x7f]/.test(sourcePath))
    throw new Error('Source must be an absolute session file path without control characters');
  if (sourcePath.split(path.sep).includes('..'))
    throw new Error('Source path must not contain parent traversal');
  let root, relative;
  if (job.sshUploadAttachments?.includes(sourcePath)) {
    root = path.dirname(sourcePath);
    relative = path.basename(sourcePath);
  } else if (job.workDir) {
    const owns = () =>
      job.local ||
      job.orchestrator ||
      (slotOwner(job.workDir) === job.id && slotPrepared(job.workDir, job.id));
    if (!owns()) throw new Error('Session no longer owns this workspace');
    root = await fs.realpath(job.workDir);
    relative = path.relative(root, sourcePath);
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative
        .split(path.sep)
        .some((part) => part.startsWith('.') || part === 'node_modules' || part === 'vendor')
    )
      throw new Error('Source must be a non-hidden file in this session workspace or a delivered attachment');
    const bytes = await readWorkspaceFile(root, relative, MAX_SSH_UPLOAD_BYTES);
    if (!owns()) throw new Error('Session no longer owns this workspace');
    if (bytes === null) throw new Error('Source must be a regular file of at most 25 MiB');
    return bytes;
  } else throw new Error('Source is not a file belonging to this session');
  const bytes = await readWorkspaceFile(root, relative, MAX_SSH_UPLOAD_BYTES);
  if (bytes === null) throw new Error('Source must be a regular file of at most 25 MiB');
  return bytes;
}

export function uploadMetadata(sourcePath, destination, bytes) {
  if (
    typeof destination !== 'string' ||
    !destination.startsWith('/') ||
    destination.endsWith('/') ||
    Buffer.byteLength(destination) > 4096 ||
    /[\x00-\x1f\x7f]/.test(destination)
  )
    throw new Error('Destination must be an absolute remote file path without control characters');
  return { sourcePath, destination, size: bytes.length, sha256: hash('sha256', bytes) };
}

// stdin contains only bytes; metadata is shell-quoted separately. Python verifies before
// replacing the destination. An interrupted/truncated stream never publishes a partial file.
export function sshUploadCommand(upload) {
  const script = `import sys, os, tempfile, hashlib
p, size, expected = sys.argv[1], int(sys.argv[2]), sys.argv[3]
fd, staging = tempfile.mkstemp(prefix='.briareus-upload-', dir=os.path.dirname(p))
try:
    digest = hashlib.sha256()
    received = 0
    with os.fdopen(fd, 'wb') as out:
        os.fchmod(out.fileno(), 0o600)
        while True:
            chunk = sys.stdin.buffer.read(min(65536, size + 1 - received))
            if not chunk: break
            received += len(chunk)
            if received > size: raise ValueError('Upload exceeds approved size')
            digest.update(chunk)
            out.write(chunk)
        if received != size or digest.hexdigest() != expected:
            raise ValueError('Upload size or SHA256 mismatch')
        out.flush()
        os.fsync(out.fileno())
    os.replace(staging, p)
    print(str(received) + ' ' + digest.hexdigest())
finally:
    if os.path.exists(staging): os.unlink(staging)
`;
  return `python3 -c ${quote(script)} ${quote(upload.destination)} ${upload.size} ${quote(upload.sha256)}`;
}
