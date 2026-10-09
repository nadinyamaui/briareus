// @ts-check
import { decodeWords } from './mail-parse.js';

// Provider writes have no automatic retry on timeouts/5xx: a send may have
// succeeded even when its response was lost. Only a refused bearer is retried.
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GRAPH = 'https://graph.microsoft.com/v1.0/me';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

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
function addresses(value) {
  if (!Array.isArray(value) || !value.length || value.length > 50)
    throw fail('Provide 1–50 recipient email addresses');
  return value.map((v) => {
    if (typeof v !== 'string' || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(v))
      throw fail('Use explicit recipient email addresses, without display names');
    return header(v);
  });
}

/** @param {{ provider: string, email: string, input: Record<string, any>, request: typeof fetch,
 * token: (force: boolean) => Promise<string> }} opts */
export async function mailAction({ provider, email, input, request, token }) {
  const action = input.action;
  if (!['send', 'reply', 'read', 'unread', 'archive'].includes(action)) throw fail('Unknown mail action');
  const needsMessage = action !== 'send';
  if (needsMessage && (typeof input.id !== 'string' || !input.id || input.id.length > 255))
    throw fail('Provide a message id');
  const id = encodeURIComponent(input.id || '');
  let text;
  let to;
  let subject;
  if (action === 'send' || action === 'reply') {
    text = input.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 100_000)
      throw fail('Provide a non-empty email body of at most 100000 characters');
    if (action === 'send') {
      to = addresses(input.to);
      subject = header(input.subject);
    }
  }
  async function call(url, method = 'GET', body = undefined) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const bearer = await token(attempt === 1);
      let res;
      try {
        res = await request(url, {
          method,
          headers: {
            Authorization: `Bearer ${bearer}`,
            'Content-Type': 'application/json',
            Prefer: 'IdType="ImmutableId"',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw fail(
          'Mail provider did not answer; the action may have succeeded. Check the mailbox before retrying.',
          502,
        );
      }
      if (res.status === 401 && attempt === 0) continue;
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
      subject = header(decodeWords(get('subject')));
      if (!get('message-id')) throw fail('Original message has no Message-ID for a threaded reply');
      extra.push(`In-Reply-To: ${header(get('message-id'))}`, `References: ${header(get('message-id'))}`);
    }
    const mime = [
      `From: ${header(email)}`,
      `To: ${to.join(', ')}`,
      subjectHeader(subject),
      ...extra,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(text)
        .toString('base64')
        .match(/.{1,76}/g)
        .join('\r\n'),
    ].join('\r\n');
    const sent = await call(`${GMAIL}/messages/send`, 'POST', {
      raw: Buffer.from(mime).toString('base64url'),
      ...(original ? { threadId: original.threadId } : {}),
    });
    return { status: 'accepted', action, id: sent.id, threadId: sent.threadId };
  }
  if (action === 'send') {
    await call(`${GRAPH}/sendMail`, 'POST', {
      message: {
        subject,
        body: { contentType: 'Text', content: text },
        toRecipients: to.map((address) => ({ emailAddress: { address } })),
      },
      saveToSentItems: true,
    });
  } else if (action === 'reply') {
    await call(`${GRAPH}/messages/${id}/reply`, 'POST', {
      message: { body: { contentType: 'Text', content: text } },
    });
  } else if (action === 'archive') {
    await call(`${GRAPH}/messages/${id}/move`, 'POST', { destinationId: 'archive' });
  } else {
    await call(`${GRAPH}/messages/${id}`, 'PATCH', { isRead: action === 'read' });
  }
  return { status: ['send', 'reply'].includes(action) ? 'accepted' : 'completed', action };
}
