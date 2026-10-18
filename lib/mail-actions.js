// @ts-check
import crypto from 'node:crypto';
import { decodeWords, parseAddressList } from './mail-parse.js';

// Provider writes have no automatic retry on timeouts/5xx: a send may have
// succeeded even when its response was lost. Only a refused bearer is retried.
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GRAPH = 'https://graph.microsoft.com/v1.0/me';
// Gmail's JSON send takes small messages only; one with attachments goes through its upload URI.
const GMAIL_UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media';
// Gmail caps a message at 25 MB after base64, and Graph's sendMail request at 4 MB:
// files beyond that need an Outlook upload session, which this does not do.
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = { gmail: 18 * 1024 * 1024, outlook: 3 * 1024 * 1024 };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const uncertain = (reason) =>
  Object.assign(
    fail(
      `${reason}; the action may have succeeded. Complete a successful fresh mailbox sync and inspect Sent before considering a retry.`,
      502,
    ),
    { uncertain: true },
  );

function header(value) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value) || value.length > 998)
    throw fail('Invalid email header');
  return value;
}
// Keep each encoded word and header line within RFC 2047 limits. Iterate
// code points so a UTF-8 character never straddles encoded words.
function subjectHeader(subject) {
  const words = [];
  let chunk = '';
  for (const char of subject) {
    if (Buffer.byteLength(chunk + char) > 39) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
  return `Subject: ${words.join('\r\n ')}`;
}
const BARE = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;
// Provider mailboxes may have quoted local parts, including spaces and escapes.
const MAILBOX =
  /^(?:[^\s<>@,;"\\\0]+|"(?:[\x20-\x21\x23-\x5b\x5d-\x7e]|\\[\x20-\x7e])*")@[^\s<>@,;"\\\0]+\.[^\s<>@,;"\\\0]+$/;
function addresses(value, optional = false) {
  if (optional && (value == null || (Array.isArray(value) && !value.length))) return [];
  if (!Array.isArray(value) || !value.length || value.length > 50)
    throw fail('Provide 1–50 recipient email addresses');
  return value.map((v) => {
    if (typeof v !== 'string' || !BARE.test(v))
      throw fail('Use explicit recipient email addresses, without display names');
    return header(v);
  });
}

// Reply-all: everyone on the original's To and Cc except the mailbox itself
// and whoever the reply already goes to. Unparseable entries are skipped.
function replyAllCc(lists, own, taken) {
  const out = [];
  for (const list of lists)
    for (const address of list) {
      const key = address.toLowerCase();
      if (!MAILBOX.test(address) || key === own || taken.has(key)) continue;
      taken.add(key);
      out.push(address);
    }
  return out;
}
// Drop repeats across To, Cc and Bcc (first one wins) and cap the total.
function dedupe(to, cc, bcc) {
  const seen = new Set(to.flatMap((r) => parseAddressList(r).map((a) => a.address.toLowerCase())));
  const keep = (list) => list.filter((r) => !seen.has(r.toLowerCase()) && seen.add(r.toLowerCase()));
  const result = { cc: keep(cc), bcc: keep(bcc) };
  if (seen.size > 100) throw fail('Send to at most 100 recipients in total');
  return result;
}

// Files arrive base64-encoded from the session's MCP, which read them from disk.
function attachmentList(value, provider) {
  if (value == null || (Array.isArray(value) && !value.length)) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS)
    throw fail(`Attach at most ${MAX_ATTACHMENTS} files`);
  let total = 0;
  const files = value.map((file) => {
    const name = file?.name;
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      /[\0-\x1f\x7f/\\]/.test(name) ||
      Buffer.byteLength(name) > 255
    )
      throw fail('Give every attachment a plain file name of at most 255 bytes');
    const mimeType =
      typeof file.mimeType === 'string' && file.mimeType ? file.mimeType : 'application/octet-stream';
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) throw fail(`Invalid attachment type for ${name}`);
    if (typeof file.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data))
      throw fail(`Attachment ${name} is not base64 data`);
    const data = Buffer.from(file.data, 'base64');
    if (!data.length) throw fail(`Attachment ${name} is empty`);
    total += data.length;
    return { name, mimeType, data };
  });
  const cap = MAX_ATTACHMENT_BYTES[provider] || MAX_ATTACHMENT_BYTES.gmail;
  if (total > cap)
    throw fail(`Attachments are limited to ${cap / 1024 / 1024} MiB in total for ${provider}`, 413);
  return files;
}

// RFC 2231 for names that are not plain ASCII.
function filenameParam(name) {
  if (/^[\x20-\x7e]+$/.test(name) && !/["\\]/.test(name)) return `filename="${name}"`;
  const encoded = encodeURIComponent(name).replace(
    /['()*!]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `filename*=UTF-8''${encoded}`;
}

const base64Lines = (data) => (data.toString('base64').match(/.{1,76}/g) || []).join('\r\n');

function recipientHeader(to, name = 'To') {
  const lines = to.map(
    (recipient, index) => `${index === 0 ? `${name}: ` : ' '}${recipient}${index < to.length - 1 ? ',' : ''}`,
  );
  if (lines.some((line) => Buffer.byteLength(line) > 998))
    throw fail('Recipient is too long for an email header');
  return lines.join('\r\n');
}

function referencesHeader(value, messageId) {
  const unfolded = value.replace(/\r\n[ \t]+/g, ' ');
  if (/[\r\n\0]/.test(unfolded)) throw fail('Invalid email header');
  const ids = [...unfolded.split(/\s+/).filter(Boolean), header(messageId)].slice(-20);
  const lines = ['References:'];
  for (const id of ids) {
    header(id);
    if (Buffer.byteLength(lines.at(-1) + ' ' + id) > 78) lines.push('');
    lines[lines.length - 1] += ` ${id}`;
  }
  if (lines.some((line) => Buffer.byteLength(line) > 998)) throw fail('Invalid email header');
  return lines.join('\r\n');
}

const graphRecipients = (list) => list.map((address) => ({ emailAddress: { address } }));

/** @param {{ provider: string, email: string, input: Record<string, any>, request: typeof fetch,
 * token: (force: boolean) => Promise<string>, authorize?: () => void }} opts */
export async function mailAction({ provider, email, input, request, token, authorize }) {
  const action = input.action;
  if (!['send', 'reply', 'read', 'unread', 'archive'].includes(action)) throw fail('Unknown mail action');
  const needsMessage = action !== 'send';
  if (needsMessage && (typeof input.id !== 'string' || !input.id || input.id.length > 255))
    throw fail('Provide a message id');
  const id = encodeURIComponent(input.id || '');
  let text;
  let to;
  let subject;
  let cc = [];
  let bcc = [];
  let attachments = [];
  const replyAll = action === 'reply' && input.replyAll === true;
  if (action === 'send' || action === 'reply') {
    text = input.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 100_000)
      throw fail('Provide a non-empty email body of at most 100000 characters');
    if (input.replyAll != null && typeof input.replyAll !== 'boolean')
      throw fail('replyAll must be a boolean');
    cc = addresses(input.cc, true);
    bcc = addresses(input.bcc, true);
    if (action === 'send') {
      to = addresses(input.to);
      subject = header(input.subject);
      ({ cc, bcc } = dedupe(to, cc, bcc));
      attachments = attachmentList(input.attachments, provider);
    } else if (input.attachments?.length) throw fail('Only a new email (mail_send) can carry attachments');
  }
  const own = String(email).toLowerCase();
  // A `type` sends `body` as those raw bytes instead of JSON.
  async function call(url, method = 'GET', body = undefined, type = undefined) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const bearer = await token(attempt === 1);
      // Recheck request eligibility after every asynchronous token/metadata wait,
      // outside the transport catch so a revoked request is a definite refusal.
      authorize?.();
      let res;
      try {
        res = await request(url, {
          method,
          headers: {
            Authorization: `Bearer ${bearer}`,
            'Content-Type': type || 'application/json',
            Prefer: 'IdType="ImmutableId"',
          },
          ...(body === undefined ? {} : { body: type ? body : JSON.stringify(body) }),
          // Uploading attachments can take longer than a JSON call.
          signal: AbortSignal.timeout(type ? 120_000 : 30_000),
        });
      } catch {
        if (method === 'GET')
          throw fail('Mail provider did not answer; no mail action was sent. Retry the request.', 502);
        throw uncertain('Mail provider did not answer');
      }
      if (res.status === 401 && attempt === 0) continue;
      if (res.status >= 500 && method !== 'GET') throw uncertain(`Mail provider returned HTTP ${res.status}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw fail(
          `Mail provider refused the action (HTTP ${res.status})`,
          res.status === 403 ? 403 : res.status === 404 ? 404 : 502,
        );
      return data;
    }
  }
  if (provider === 'gmail') {
    if (['read', 'unread', 'archive'].includes(action)) {
      await call(`${GMAIL}/messages/${id}/modify`, 'POST', {
        addLabelIds: action === 'unread' ? ['UNREAD'] : [],
        removeLabelIds: action === 'read' ? ['UNREAD'] : action === 'archive' ? ['INBOX'] : [],
      });
      return { status: 'completed', action };
    }
    let original;
    const extra = [];
    if (action === 'reply') {
      original = await call(`${GMAIL}/messages/${id}?format=metadata`);
      const headers = original.payload?.headers || [];
      const get = (name) => headers.find((h) => h.name.toLowerCase() === name)?.value || '';
      // Respect Reply-To, including a display name; never infer recipients from body text.
      const recipient = get('reply-to') || get('from');
      if (!recipient) throw fail('Original message has no reply address');
      to = [header(recipient)];
      const originalSubject = header(decodeWords(get('subject')));
      subject = /^re:/i.test(originalSubject.trim()) ? originalSubject : `Re: ${originalSubject}`;
      const messageId = get('message-id');
      if (!messageId) throw fail('Original message has no Message-ID for a threaded reply');
      // Keep the whole chain so every client threads the reply.
      extra.push(`In-Reply-To: ${header(messageId)}`, referencesHeader(get('references'), messageId));
      if (replyAll) {
        const list = (name) => parseAddressList(get(name)).map((a) => a.address);
        const targets = list(get('reply-to') ? 'reply-to' : 'from');
        if (targets.some((a) => a.toLowerCase() === own)) {
          to = replyAllCc([targets], own, new Set());
          if (!to.length) to = replyAllCc([list('to')], own, new Set());
          if (!to.length) to = replyAllCc([list('cc')], own, new Set());
          if (!to.length) throw fail('Original message has no reply address');
        }
        cc = [
          ...replyAllCc(
            [list('to'), list('cc')],
            own,
            new Set(to.flatMap((r) => parseAddressList(r).map((a) => a.address.toLowerCase()))),
          ),
          ...cc,
        ];
      }
      ({ cc, bcc } = dedupe(to, cc, bcc));
    }
    const head = [
      `From: ${header(email)}`,
      recipientHeader(to),
      ...(cc.length ? [recipientHeader(cc, 'Cc')] : []),
      ...(bcc.length ? [recipientHeader(bcc, 'Bcc')] : []),
      subjectHeader(subject),
      ...extra,
      'MIME-Version: 1.0',
    ];
    const body = [
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(Buffer.from(text)),
    ];
    let sent;
    if (!attachments.length) {
      const mime = [...head, ...body].join('\r\n');
      sent = await call(`${GMAIL}/messages/send`, 'POST', {
        raw: Buffer.from(mime).toString('base64url'),
        ...(original ? { threadId: original.threadId } : {}),
      });
    } else {
      const boundary = `briareus-${crypto.randomBytes(12).toString('hex')}`;
      const mime = [
        ...head,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        ...body,
        ...attachments.flatMap((file) => [
          `--${boundary}`,
          `Content-Type: ${file.mimeType}`,
          `Content-Disposition: attachment; ${filenameParam(file.name)}`,
          'Content-Transfer-Encoding: base64',
          '',
          base64Lines(file.data),
        ]),
        `--${boundary}--`,
        '',
      ].join('\r\n');
      sent = await call(GMAIL_UPLOAD, 'POST', mime, 'message/rfc822');
    }
    return {
      status: 'accepted',
      action,
      id: sent.id,
      threadId: sent.threadId,
      to,
      cc,
      bcc,
      ...(attachments.length ? { attachments: attachments.map((file) => file.name) } : {}),
    };
  }
  if (action === 'send') {
    await call(`${GRAPH}/sendMail`, 'POST', {
      message: {
        subject,
        body: { contentType: 'Text', content: text },
        toRecipients: graphRecipients(to),
        ...(cc.length ? { ccRecipients: graphRecipients(cc) } : {}),
        ...(bcc.length ? { bccRecipients: graphRecipients(bcc) } : {}),
        ...(attachments.length
          ? {
              attachments: attachments.map((file) => ({
                '@odata.type': '#microsoft.graph.fileAttachment',
                name: file.name,
                contentType: file.mimeType,
                contentBytes: file.data.toString('base64'),
              })),
            }
          : {}),
      },
      saveToSentItems: true,
    });
  } else if (action === 'reply') {
    const message = { body: { contentType: 'Text', content: text } };
    if (replyAll || cc.length || bcc.length) {
      // Graph's default reply keeps the original recipients only when none
      // are given, so spell the whole list out once any are added.
      const original = await call(`${GRAPH}/messages/${id}?$select=from,replyTo,toRecipients,ccRecipients`);
      const list = (field) => (original[field] || []).map((r) => r.emailAddress?.address || '');
      to = list('replyTo').filter((a) => MAILBOX.test(a));
      if (!to.length) to = [original.from?.emailAddress?.address || ''];
      if (!to.every((a) => MAILBOX.test(a))) throw fail('Original message has no reply address');
      if (replyAll) {
        to = to.filter((a) => a.toLowerCase() !== own);
        if (!to.length) to = replyAllCc([list('toRecipients')], own, new Set());
        if (!to.length) to = replyAllCc([list('ccRecipients')], own, new Set());
        if (!to.length) throw fail('Original message has no reply address');
        cc = [
          ...replyAllCc(
            [list('toRecipients'), list('ccRecipients')],
            own,
            new Set(to.map((a) => a.toLowerCase())),
          ),
          ...cc,
        ];
      }
      ({ cc, bcc } = dedupe(to, cc, bcc));
      Object.assign(message, {
        toRecipients: graphRecipients(to),
        ccRecipients: graphRecipients(cc),
        bccRecipients: graphRecipients(bcc),
      });
    }
    await call(`${GRAPH}/messages/${id}/reply`, 'POST', { message });
  } else if (action === 'archive') {
    await call(`${GRAPH}/messages/${id}/move`, 'POST', { destinationId: 'archive' });
  } else {
    await call(`${GRAPH}/messages/${id}`, 'PATCH', { isRead: action === 'read' });
  }
  if (action === 'send' || action === 'reply')
    return {
      status: 'accepted',
      action,
      ...(to ? { to } : {}),
      cc,
      bcc,
      ...(attachments.length ? { attachments: attachments.map((file) => file.name) } : {}),
    };
  return { status: 'completed', action };
}
