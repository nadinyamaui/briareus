import { describe, it, expect, vi } from 'vitest';
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
