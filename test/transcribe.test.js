import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({ transcribe: null }));
vi.mock('../lib/config.js', () => ({ getConfig: () => cfg }));

import { transcribe, transcribeAvailable } from '../lib/transcribe.js';

const AUDIO = Buffer.from('fake-opus');

function answer(status, body) {
  const fetchMock = vi.fn(
    async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  cfg.transcribe = { apiKey: 'sk-test', model: 'gpt-4o-transcribe' };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('transcribe', () => {
  it('is unavailable, and refuses with 503, when the server has no key', async () => {
    cfg.transcribe = null;
    const fetchMock = answer(200, { text: 'x' });

    expect(transcribeAvailable()).toBe(false);
    await expect(transcribe(AUDIO, { type: 'audio/webm' })).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the recording with the model, the language and a name carrying its extension', async () => {
    const fetchMock = answer(200, { text: '  hola mundo \n' });

    const text = await transcribe(AUDIO, { type: 'audio/webm;codecs=opus', language: 'es-ES' });

    expect(text).toBe('hola mundo');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(opts.headers.Authorization).toBe('Bearer sk-test');
    const form = opts.body;
    expect(form.get('model')).toBe('gpt-4o-transcribe');
    expect(form.get('language')).toBe('es');
    const file = form.get('file');
    expect(file.name).toBe('voice-note.webm');
    expect(Buffer.from(await file.arrayBuffer()).toString()).toBe('fake-opus');
  });

  it('names a Safari recording mp4 and leaves the language to the API when none is picked', async () => {
    const fetchMock = answer(200, { text: 'hello' });

    await transcribe(AUDIO, { type: 'audio/mp4' });

    const form = fetchMock.mock.calls[0][1].body;
    expect(form.get('file').name).toBe('voice-note.mp4');
    expect(form.has('language')).toBe(false);
  });

  it('refuses a format the API does not read before calling it', async () => {
    const fetchMock = answer(200, { text: 'x' });

    await expect(transcribe(AUDIO, { type: 'application/octet-stream' })).rejects.toMatchObject({
      status: 415,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports OpenAI's own error message", async () => {
    answer(401, { error: { message: 'Incorrect API key provided' } });

    await expect(transcribe(AUDIO, { type: 'audio/webm' })).rejects.toMatchObject({
      status: 502,
      message: expect.stringMatching(/401.*Incorrect API key provided/),
    });
  });

  it('reports an unreachable service', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
      }),
    );

    await expect(transcribe(AUDIO, { type: 'audio/webm' })).rejects.toMatchObject({
      status: 502,
      message: expect.stringMatching(/ECONNREFUSED/),
    });
  });
});
