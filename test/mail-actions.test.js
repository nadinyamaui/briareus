import { describe, it, expect, vi } from 'vitest';
import { decodeWords } from '../lib/mail-parse.js';
import { mailAction } from '../lib/mail-actions.js';
import { gmailProvider, outlookProvider } from '../lib/mail-providers.js';
const make = (provider = 'gmail', ...responses) => {
  const request = vi.fn(async () => responses.shift() || new Response('{}'));
  const token = vi.fn(async () => 'access');
  return {
    request,
    token,
    run: (input) => mailAction({ provider, email: 'me@example.com', input, request, token }),
  };
};

describe('email actions', () => {
  it.each(['gmail', 'outlook'])(
    'rechecks request authorization after a 401 refresh for %s',
    async (provider) => {
      let allowed = true;
      const request = vi.fn(async () => new Response('{}', { status: 401 }));
      const token = vi.fn(async (force) => {
        if (force) allowed = false;
        return 'access';
      });
      const error = await mailAction({
        provider,
        email: 'me@example.com',
        input: { action: 'read', id: 'message' },
        request,
        token,
        authorize: () => {
          if (!allowed) throw Object.assign(new Error('Mail access revoked'), { status: 403 });
        },
      }).catch((e) => e);
      expect(error).toMatchObject({ status: 403, message: 'Mail access revoked' });
      expect(error).not.toHaveProperty('uncertain');
      expect(request).toHaveBeenCalledTimes(1);
      expect(token.mock.calls).toEqual([[false], [true]]);
    },
  );

  it.each(['network failure', 'timeout'])('keeps Gmail metadata %s definite', async (failure) => {
    const { run, request } = make();
    request.mockRejectedValue(
      failure === 'timeout' ? new DOMException('Timed out', 'TimeoutError') : new TypeError('fetch failed'),
    );
    const error = await run({ action: 'reply', id: 'abc', text: 'Answer' }).catch((e) => e);
    expect(error).toMatchObject({ status: 502, message: expect.stringMatching(/no mail action was sent/) });
    expect(error).not.toHaveProperty('uncertain');
    expect(error.message).not.toMatch(/may have succeeded|Sent|sync/);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1].method).toBe('GET');
  });

  it.each(['gmail', 'outlook'])('keeps %s write transport failures uncertain', async (provider) => {
    const { run, request } = make(provider);
    request.mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      run({ action: 'send', to: ['you@example.com'], subject: 's', text: 'b' }),
    ).rejects.toMatchObject({ uncertain: true, status: 502 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1].method).toBe('POST');
  });

  it.each(
    ['gmail', 'outlook'].flatMap((provider) =>
      ['read', 'unread', 'archive'].flatMap((action) =>
        [500, 502, 503, 504, 403, 404].map((status) => ({ provider, action, status })),
      ),
    ),
  )(
    'preserves $provider $action outcomes for HTTP $status without retrying',
    async ({ provider, action, status }) => {
      const { run, request } = make(provider, new Response('{}', { status }));
      const error = await run({ action, id: 'abc' }).catch((e) => e);
      if (status >= 500) {
        expect(error).toMatchObject({ uncertain: true, status: 502 });
        expect(error.message).toMatch(/may have succeeded/);
      } else {
        expect(error).toMatchObject({ status });
        expect(error).not.toHaveProperty('uncertain');
        expect(error.message).toMatch(/refused/);
      }
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps Gmail reply metadata server errors definite without sending', async () => {
    const { run, request } = make('gmail', new Response('{}', { status: 503 }));
    const error = await run({ action: 'reply', id: 'abc', text: 'Answer' }).catch((e) => e);
    expect(error).toMatchObject({ status: 502 });
    expect(error).not.toHaveProperty('uncertain');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1].method).toBe('GET');
  });

  it('folds multi-recipient Gmail headers and preserves every recipient', async () => {
    const { run, request } = make();
    const to = Array.from({ length: 50 }, (_, i) => `recipient.number.${i}@company.example.com`);
    await run({ action: 'send', to, subject: 'Hello', text: 'Body' });
    const mime = Buffer.from(JSON.parse(request.mock.calls[0][1].body).raw, 'base64url').toString();
    const recipient = mime.match(/To: ([^\r]*(?:\r\n [^\r]*)*)/)[1];
    expect(recipient.replace(/\r\n /g, ' ').split(', ')).toEqual(to);
    for (const line of mime.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(998);
  });

  it('rejects a recipient that cannot fit a MIME header before sending', async () => {
    const { run, request } = make();
    await expect(
      run({ action: 'send', to: ['a'.repeat(986) + '@example.com'], subject: 's', text: 'b' }),
    ).rejects.toThrow(/too long/);
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['gmail', 'outlook'])(
    'preserves uncertain %s send/reply server errors without retrying',
    async (provider) => {
      for (const action of ['send', 'reply']) {
        for (const status of [500, 502, 503, 504]) {
          const r = make(provider);
          r.request.mockImplementation(async (_url, options) =>
            options.method === 'GET'
              ? Response.json({
                  payload: {
                    headers: [
                      { name: 'From', value: 'you@example.com' },
                      { name: 'Subject', value: 's' },
                      { name: 'Message-ID', value: '<id@example.com>' },
                    ],
                  },
                })
              : new Response('{}', { status }),
          );
          await expect(
            r.run({ action, id: 'abc', to: ['you@example.com'], subject: 's', text: 'b' }),
          ).rejects.toMatchObject({
            uncertain: true,
            status: 502,
            message: expect.stringMatching(/may have succeeded.*successful fresh mailbox sync/),
          });
          expect(r.request.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
        }
      }
    },
  );

  it('keeps explicit send refusals definite', async () => {
    const { run } = make('gmail', new Response('{}', { status: 403 }));
    await expect(
      run({ action: 'send', to: ['you@example.com'], subject: 's', text: 'b' }),
    ).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/refused/) });
  });
  it('sends UTF-8 Gmail MIME with explicit recipients', async () => {
    const { run, request } = make();
    expect(
      await run({ action: 'send', to: ['you@example.com'], subject: 'Hola ñ', text: 'Buenos días' }),
    ).toMatchObject({ status: 'accepted' });
    const [url, options] = request.mock.calls[0];
    expect(url).toMatch(/\/messages\/send$/);
    const mime = Buffer.from(JSON.parse(options.body).raw, 'base64url').toString();
    expect(mime).toContain('To: you@example.com\r\n');
    expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from('Hola ñ').toString('base64')}?=`);
    expect(mime).toContain(Buffer.from('Buenos días').toString('base64'));
  });

  it('threads Gmail replies using Reply-To and original Message-ID', async () => {
    const { run, request } = make(
      'gmail',
      Response.json({
        threadId: 'thread',
        payload: {
          headers: [
            { name: 'From', value: 'sender@example.com' },
            { name: 'Reply-To', value: 'Reply Person <reply@example.com>' },
            { name: 'Subject', value: 'Original' },
            { name: 'Message-ID', value: '<original@example.com>' },
          ],
        },
      }),
    );
    await run({ action: 'reply', id: 'm/+=', text: 'Yes' });
    expect(request.mock.calls[0][0]).toContain('m%2F%2B%3D');
    const body = JSON.parse(request.mock.calls[1][1].body);
    expect(body.threadId).toBe('thread');
    const mime = Buffer.from(body.raw, 'base64url').toString();
    expect(mime).toContain('To: Reply Person <reply@example.com>');
    expect(mime).toContain('In-Reply-To: <original@example.com>');
  });

  it('sends Gmail cc and bcc without repeating a recipient', async () => {
    const { run, request } = make();
    const result = await run({
      action: 'send',
      to: ['a@example.com'],
      cc: ['b@example.com', 'A@example.com'],
      bcc: ['c@example.com', 'b@example.com'],
      subject: 's',
      text: 'body',
    });
    expect(result).toMatchObject({ to: ['a@example.com'], cc: ['b@example.com'], bcc: ['c@example.com'] });
    const mime = Buffer.from(JSON.parse(request.mock.calls[0][1].body).raw, 'base64url').toString();
    expect(mime).toContain('To: a@example.com\r\nCc: b@example.com\r\nBcc: c@example.com\r\n');
  });

  it.each([{ cc: ['Name <b@example.com>'] }, { bcc: 'b@example.com' }, { replyAll: 'yes' }])(
    'rejects malformed recipients %o before calling the provider',
    async (extra) => {
      const { run, request } = make();
      await expect(run({ action: 'reply', id: 'abc', text: 'x', ...extra })).rejects.toMatchObject({
        status: 400,
      });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('replies to all in the Gmail thread with the whole reference chain', async () => {
    const { run, request } = make(
      'gmail',
      Response.json({
        threadId: 'thread',
        payload: {
          headers: [
            { name: 'From', value: 'Andy <andy@example.com>' },
            { name: 'To', value: 'Me <ME@example.com>, Matt <matt@example.com>' },
            { name: 'Cc', value: 'alan@example.com, andy@example.com, undisclosed-recipients:;' },
            { name: 'Subject', value: 'Re: Working together' },
            { name: 'Message-ID', value: '<3@example.com>' },
            { name: 'References', value: '<1@example.com> <2@example.com>' },
          ],
        },
      }),
    );
    const result = await run({
      action: 'reply',
      id: 'abc',
      text: 'Thanks',
      replyAll: true,
      cc: ['matt@example.com', 'zoe@example.com'],
    });
    expect(result).toMatchObject({
      to: ['Andy <andy@example.com>'],
      cc: ['matt@example.com', 'alan@example.com', 'zoe@example.com'],
      threadId: undefined,
    });
    const body = JSON.parse(request.mock.calls[1][1].body);
    expect(body.threadId).toBe('thread');
    const mime = Buffer.from(body.raw, 'base64url').toString();
    expect(mime).toContain(
      'To: Andy <andy@example.com>\r\nCc: matt@example.com,\r\n alan@example.com,\r\n zoe@example.com\r\n',
    );
    expect(mime).toContain('References: <1@example.com> <2@example.com> <3@example.com>');
    expect(decodeWords(mime.match(/Subject: ([^\r]+)/)[1])).toBe('Re: Working together');
  });

  it('folds long Gmail References chains between IDs', async () => {
    const ids = Array.from({ length: 19 }, (_, i) => `<${String(i).padStart(45, 'x')}@example.com>`);
    const { run, request } = make(
      'gmail',
      Response.json({
        threadId: 'thread',
        payload: {
          headers: [
            { name: 'From', value: 'sender@example.com' },
            { name: 'Message-ID', value: ids.at(-1) },
            { name: 'References', value: ids.slice(0, -1).join('\r\n ') },
          ],
        },
      }),
    );
    await run({ action: 'reply', id: 'abc', text: 'Answer' });
    const mime = Buffer.from(JSON.parse(request.mock.calls[1][1].body).raw, 'base64url').toString();
    const references = mime.match(/References: ([^\r]*(?:\r\n [^\r]*)*)/)[1];
    expect(references.split(/\s+/)).toEqual(ids);
    for (const line of mime.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(998);
  });

  it.each(['<id@example.com>\r\nBcc: evil@example.com', '<' + 'x'.repeat(990) + '@example.com>'])(
    'rejects unsafe or oversized Gmail reference IDs',
    async (reference) => {
      const { run, request } = make(
        'gmail',
        Response.json({
          payload: {
            headers: [
              { name: 'From', value: 'sender@example.com' },
              { name: 'Message-ID', value: '<original@example.com>' },
              { name: 'References', value: reference },
            ],
          },
        }),
      );
      await expect(run({ action: 'reply', id: 'abc', text: 'Answer' })).rejects.toMatchObject({
        status: 400,
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('deduplicates every Gmail Reply-To mailbox against Cc and Bcc', async () => {
    const { run } = make(
      'gmail',
      Response.json({
        payload: {
          headers: [
            { name: 'Reply-To', value: 'First <first@example.com>, Second <second@example.com>' },
            { name: 'Message-ID', value: '<original@example.com>' },
          ],
        },
      }),
    );
    const result = await run({
      action: 'reply',
      id: 'abc',
      text: 'Answer',
      cc: ['SECOND@example.com'],
      bcc: ['second@example.com'],
    });
    expect(result).toMatchObject({ cc: [], bcc: [] });
  });

  it('counts every Gmail Reply-To mailbox toward the total recipient limit', async () => {
    const { run, request } = make(
      'gmail',
      Response.json({
        payload: {
          headers: [
            { name: 'Reply-To', value: 'a@example.com, b@example.com, c@example.com' },
            { name: 'Message-ID', value: '<original@example.com>' },
          ],
        },
      }),
    );
    await expect(
      run({
        action: 'reply',
        id: 'abc',
        text: 'Answer',
        cc: Array.from({ length: 50 }, (_, i) => `cc${i}@example.com`),
        bcc: Array.from({ length: 49 }, (_, i) => `bcc${i}@example.com`),
      }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/100 recipients/) });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(['gmail', 'outlook'])('excludes self from %s sent-message reply-all targets', async (provider) => {
    const { run, request } = make(
      provider,
      Response.json(
        provider === 'gmail'
          ? {
              payload: {
                headers: [
                  { name: 'From', value: 'Me <ME@example.com>' },
                  { name: 'To', value: 'alice@example.com, bob@example.com, me@example.com' },
                  { name: 'Cc', value: 'carol@example.com' },
                  { name: 'Message-ID', value: '<original@example.com>' },
                ],
              },
            }
          : {
              from: { emailAddress: { address: 'ME@example.com' } },
              toRecipients: ['alice@example.com', 'bob@example.com', 'me@example.com'].map((address) => ({
                emailAddress: { address },
              })),
              ccRecipients: [{ emailAddress: { address: 'carol@example.com' } }],
            },
      ),
    );
    await run({ action: 'reply', id: 'abc', text: 'Answer', replyAll: true });
    const body = JSON.parse(request.mock.calls[1][1].body);
    if (provider === 'gmail') {
      const mime = Buffer.from(body.raw, 'base64url').toString();
      expect(mime).toContain('To: alice@example.com,\r\n bob@example.com');
      expect(mime).toContain('Cc: carol@example.com');
      expect(mime).not.toMatch(/(?:To: |Cc: |\r\n )[^\r]*me@example.com/i);
    } else {
      expect(body.message.toRecipients.map((r) => r.emailAddress.address)).toEqual([
        'alice@example.com',
        'bob@example.com',
      ]);
      expect(body.message.ccRecipients.map((r) => r.emailAddress.address)).toEqual(['carol@example.com']);
    }
  });

  it('spells out Outlook reply recipients once cc or reply-all is asked for', async () => {
    const { run, request } = make(
      'outlook',
      Response.json({
        from: { emailAddress: { address: 'andy@example.com' } },
        replyTo: [],
        toRecipients: [
          { emailAddress: { address: 'me@example.com' } },
          { emailAddress: { address: 'matt@example.com' } },
        ],
        ccRecipients: [{ emailAddress: { address: 'alan@example.com' } }],
      }),
      new Response(null, { status: 202 }),
    );
    await run({ action: 'reply', id: 'm1', text: 'Thanks', replyAll: true, bcc: ['me2@example.com'] });
    expect(request.mock.calls[0][0]).toMatch(/\/messages\/m1\?\$select=/);
    const [url, options] = request.mock.calls[1];
    expect(url).toMatch(/\/messages\/m1\/reply$/);
    const address = (list) => list.map((r) => r.emailAddress.address);
    const { message } = JSON.parse(options.body);
    expect(address(message.toRecipients)).toEqual(['andy@example.com']);
    expect(address(message.ccRecipients)).toEqual(['matt@example.com', 'alan@example.com']);
    expect(address(message.bccRecipients)).toEqual(['me2@example.com']);
  });

  it.each([995, 998])('replies to a Gmail subject of %i characters', async (length) => {
    const subject = 'a'.repeat(length);
    const encoded = subject
      .match(/.{1,39}/g)
      .map((chunk) => `=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`)
      .join('\r\n ');
    const { run, request } = make(
      'gmail',
      Response.json({
        payload: {
          headers: [
            { name: 'From', value: 'sender@example.com' },
            { name: 'Subject', value: encoded },
            { name: 'Message-ID', value: '<original@example.com>' },
          ],
        },
      }),
    );
    await run({ action: 'reply', id: 'abc', text: 'Answer' });
    const mime = Buffer.from(JSON.parse(request.mock.calls[1][1].body).raw, 'base64url').toString();
    const outgoing = mime.match(/Subject: ([^\r]*(?:\r\n [^\r]*)*)/)[1];
    expect(decodeWords(outgoing)).toBe(`Re: ${subject}`);
    for (const line of `Subject: ${outgoing}`.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
  });

  it.each(['a'.repeat(999), 'hello\r\nBcc: other@example.com', 'hello\0world'])(
    'rejects unsafe original Gmail reply subjects',
    async (subject) => {
      const { run, request } = make(
        'gmail',
        Response.json({
          payload: {
            headers: [
              { name: 'From', value: 'sender@example.com' },
              { name: 'Subject', value: subject },
              { name: 'Message-ID', value: '<original@example.com>' },
            ],
          },
        }),
      );
      await expect(run({ action: 'reply', id: 'abc', text: 'Answer' })).rejects.toMatchObject({
        status: 400,
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['gmail', 'outlook'])('keeps quoted mailboxes in %s reply-all Cc', async (provider) => {
    const address = '"alice smith"@example.com';
    const { run, request } = make(
      provider,
      Response.json(
        provider === 'gmail'
          ? {
              payload: {
                headers: [
                  { name: 'From', value: 'bob@example.com' },
                  { name: 'To', value: `me@example.com, ${address}` },
                  { name: 'Message-ID', value: '<original@example.com>' },
                ],
              },
            }
          : {
              from: { emailAddress: { address: 'bob@example.com' } },
              toRecipients: ['me@example.com', address].map((address) => ({ emailAddress: { address } })),
            },
      ),
    );
    const result = await run({ action: 'reply', id: 'abc', text: 'Answer', replyAll: true });
    expect(result.cc).toEqual([address]);
    const body = JSON.parse(request.mock.calls[1][1].body);
    if (provider === 'gmail')
      expect(Buffer.from(body.raw, 'base64url').toString()).toContain(`Cc: ${address}`);
    else expect(body.message.ccRecipients).toEqual([{ emailAddress: { address } }]);
  });

  it.each(['replyTo', 'from'])('keeps a quoted Outlook %s as the primary recipient', async (field) => {
    const address = '"alice smith"@example.com';
    const recipient = { emailAddress: { address } };
    const { run, request } = make(
      'outlook',
      Response.json({
        from: { emailAddress: { address: 'bob@example.com' } },
        [field]: field === 'replyTo' ? [recipient] : recipient,
      }),
    );
    await run({ action: 'reply', id: 'abc', text: 'Answer', cc: ['carol@example.com'] });
    expect(JSON.parse(request.mock.calls[1][1].body).message.toRecipients).toEqual([recipient]);
  });

  it.each(['"alice\r\nBcc: evil@example.com"@example.com', '"alice\0smith"@example.com'])(
    'rejects unsafe quoted Outlook primary recipients',
    async (address) => {
      const { run, request } = make(
        'outlook',
        Response.json({
          from: { emailAddress: { address } },
          replyTo: [{ emailAddress: { address } }],
        }),
      );
      await expect(run({ action: 'reply', id: 'abc', text: 'Answer', replyAll: true })).rejects.toMatchObject(
        { status: 400 },
      );
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['=?UTF-8?B?Q2Fmw6k=?=', '=?UTF-8?Q?Caf=C3=A9?='])(
    'decodes a Gmail reply subject %s before serializing it',
    async (subject) => {
      const { run, request } = make(
        'gmail',
        Response.json({
          threadId: 'thread',
          payload: {
            headers: [
              { name: 'From', value: 'sender@example.com' },
              { name: 'Subject', value: subject },
              { name: 'Message-ID', value: '<original@example.com>' },
            ],
          },
        }),
      );
      await run({ action: 'reply', id: 'abc', text: 'Yes' });
      const mime = Buffer.from(JSON.parse(request.mock.calls[1][1].body).raw, 'base64url').toString();
      expect(decodeWords(mime.match(/Subject: ([^\r]+)/)[1])).toBe('Re: Café');
    },
  );

  it.each(['a'.repeat(100), 'a'.repeat(998), '😀é界 '.repeat(190), ''])(
    'folds Gmail subjects without breaking UTF-8 characters',
    async (subject) => {
      const { run, request } = make();
      await run({ action: 'send', to: ['you@example.com'], subject, text: 'body' });
      const mime = Buffer.from(JSON.parse(request.mock.calls[0][1].body).raw, 'base64url').toString();
      const encoded = mime.match(/Subject: ([^\r]*(?:\r\n [^\r]*)*)/)[1];
      expect(decodeWords(encoded)).toBe(subject);
      for (const word of encoded.match(/=\?UTF-8\?B\?[^?]+\?=/g) || []) {
        expect(word.length).toBeLessThanOrEqual(75);
        expect(Buffer.from(word.slice(10, -2), 'base64').toString()).not.toContain('�');
      }
      for (const line of `Subject: ${encoded}`.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
    },
  );

  it.each([false, true])('preserves definite token failures (after 401: %s)', async (retry) => {
    const { run, token, request } = make('gmail', new Response('{}', { status: 401 }));
    const error = Object.assign(new Error('invalid_grant'), { reauth: true });
    token.mockImplementation(async (force) => {
      if (!retry || force) throw error;
      return 'access';
    });
    await expect(run({ action: 'read', id: 'abc' })).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(retry ? 1 : 0);
  });

  it.each(['read', 'unread', 'archive'])('updates Gmail %s using labels', async (action) => {
    const { run, request } = make();
    await run({ action, id: 'abc' });
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({
      addLabelIds: action === 'unread' ? ['UNREAD'] : [],
      removeLabelIds: action === 'read' ? ['UNREAD'] : action === 'archive' ? ['INBOX'] : [],
    });
  });

  it.each(['send', 'reply', 'read', 'unread', 'archive'])(
    'performs Outlook %s with immutable IDs',
    async (action) => {
      const { run, request } = make('outlook', new Response(null, { status: 202 }));
      await run({
        action,
        id: 'm/+=',
        to: ['you@example.com'],
        subject: 'Subject',
        text: '<b>plain text</b>',
      });
      const [url, options] = request.mock.calls[0];
      expect(options.headers.Prefer).toBe('IdType="ImmutableId"');
      const body = JSON.parse(options.body);
      if (action === 'send') {
        expect(url).toMatch(/\/sendMail$/);
        expect(body.message.toRecipients).toEqual([{ emailAddress: { address: 'you@example.com' } }]);
        expect(body.message.body.contentType).toBe('Text');
      } else if (action === 'reply') {
        expect(url).toMatch(/m%2F%2B%3D\/reply$/);
        expect(body.message.body).toEqual({ contentType: 'Text', content: '<b>plain text</b>' });
      } else if (action === 'archive') expect(body).toEqual({ destinationId: 'archive' });
      else {
        expect(options.method).toBe('PATCH');
        expect(body).toEqual({ isRead: action === 'read' });
      }
    },
  );

  it('refreshes once after a 401 but never retries ambiguous failures', async () => {
    const { run, request, token } = make('gmail', new Response('{}', { status: 401 }));
    await run({ action: 'read', id: 'abc' });
    expect(token.mock.calls).toEqual([[false], [true]]);
    expect(request).toHaveBeenCalledTimes(2);
    for (const response of [new Response('{}', { status: 503 }), new Error('timeout')]) {
      const r = make();
      r.request.mockImplementation(async () => {
        if (response instanceof Error) throw response;
        return response;
      });
      await expect(
        r.run({ action: 'send', to: ['you@example.com'], subject: 's', text: 'body' }),
      ).rejects.toThrow();
      expect(r.request).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    { action: 'delete', id: 'abc' },
    { action: 'read' },
    { action: 'send', to: ['you@example.com\r\nBcc: other@example.com'], subject: 's', text: 'body' },
    { action: 'send', to: ['you@example.com'], subject: 's\nBcc: other@example.com', text: 'body' },
    { action: 'send', to: ['you@example.com'], subject: 's', text: '' },
  ])('rejects invalid inputs before contacting the provider', async (input) => {
    const { run, request } = make();
    await expect(run(input)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});

describe('management consent', () => {
  const client = {
    clientId: 'id',
    clientSecret: 'secret',
    redirectUri: 'http://localhost',
    tenant: 'consumers',
  };
  it('requests broader scopes only with explicit opt-in', () => {
    const opts = { state: 's', challenge: 'c' };
    expect(new URL(gmailProvider(client).authorizeUrl(opts)).searchParams.get('scope')).toMatch(
      /gmail.readonly$/,
    );
    expect(
      new URL(gmailProvider(client, { manage: true }).authorizeUrl(opts)).searchParams.get('scope'),
    ).toMatch(/gmail.modify$/);
    expect(
      new URL(outlookProvider(client, { manage: true }).authorizeUrl(opts)).searchParams.get('scope'),
    ).toContain('Mail.Send');
    expect(new URL(outlookProvider(client).authorizeUrl(opts)).searchParams.get('scope')).not.toContain(
      'Mail.Send',
    );
  });
  it.each(['gmail', 'outlook'])('refuses partially granted management scopes for %s', async (provider) => {
    const request = vi.fn(async () =>
      Response.json({
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 3600,
        scope: provider === 'gmail' ? 'https://www.googleapis.com/auth/gmail.readonly' : 'Mail.ReadWrite',
      }),
    );
    const p = (provider === 'gmail' ? gmailProvider : outlookProvider)(client, { manage: true, request });
    await expect(p.exchange('code', 'verifier')).rejects.toThrow(/did not grant/);
  });
});
