import { afterEach, describe, expect, it, vi } from 'vitest';
const cfg = vi.hoisted(() => ({ speech: { apiKey: 'private-key', model: 'gpt-4o-mini-tts' } }));
vi.mock('../lib/config.js', () => ({ getConfig: () => cfg }));
import { speech } from '../lib/speech.js';
const AUDIO = Buffer.from('OggSfake-opus');
afterEach(() => {
  vi.unstubAllGlobals();
  cfg.speech = { apiKey: 'private-key', model: 'gpt-4o-mini-tts' };
});
describe('OpenAI voice note synthesis', () => {
  it('requests Opus with the configured model and selected voice', async () => {
    const mock = vi.fn(async () => new Response(AUDIO));
    vi.stubGlobal('fetch', mock);
    expect(await speech({ text: ' Hola ', voice: 'nova' })).toEqual(AUDIO);
    const [url, options] = mock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/speech');
    expect(options.headers.Authorization).toBe('Bearer private-key');
    expect(JSON.parse(options.body)).toEqual({
      model: 'gpt-4o-mini-tts',
      input: 'Hola',
      voice: 'nova',
      response_format: 'opus',
    });
  });
  it('uses marin by default and propagates cancellation', async () => {
    const mock = vi.fn(async () => new Response(AUDIO));
    vi.stubGlobal('fetch', mock);
    const controller = new AbortController();
    await speech({ text: 'Hola' }, controller.signal);
    expect(JSON.parse(mock.mock.calls[0][1].body).voice).toBe('marin');
    controller.abort();
    expect(mock.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('rejects invalid inputs and missing settings before calling OpenAI', async () => {
    const mock = vi.fn();
    vi.stubGlobal('fetch', mock);
    for (const input of [
      { text: '' },
      { text: ' ' },
      { text: 'a'.repeat(4097) },
      { text: 'x', voice: 'Sara' },
      { text: 'x\0' },
    ])
      await expect(speech(input)).rejects.toMatchObject({ status: 400 });
    cfg.speech = null;
    await expect(speech({ text: 'Hola' })).rejects.toMatchObject({ status: 503 });
    expect(mock).not.toHaveBeenCalled();
  });
  it('reports upstream failures without exposing private error bodies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('private-key', { status: 401 })),
    );
    await expect(speech({ text: 'Hola' })).rejects.toMatchObject({
      status: 502,
      message: 'OpenAI could not generate the voice note (HTTP 401)',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('private-key');
      }),
    );
    await expect(speech({ text: 'Hola' })).rejects.toMatchObject({
      status: 502,
      message: 'Could not reach OpenAI to generate the voice note',
    });
  });
  it('names a stalled generation as a timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }),
    );
    await expect(speech({ text: 'Hola' })).rejects.toMatchObject({
      status: 504,
      message: 'OpenAI took more than 2 minutes to generate the voice note; nothing was sent',
    });
  });
  it('rejects empty, non-Ogg and oversized responses', async () => {
    for (const body of ['', 'not audio', Buffer.alloc(25 * 1024 * 1024 + 1)]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(body)),
      );
      await expect(speech({ text: 'Hola' })).rejects.toMatchObject({ status: 502 });
    }
  });
});

describe('gpt-audio voice notes', () => {
  const answer = (transcript, data = AUDIO.toString('base64')) =>
    Response.json({ choices: [{ message: { audio: { data, transcript } } }] });
  afterEach(() => vi.unstubAllGlobals());
  it('asks chat completions to read the text aloud and returns the decoded Opus', async () => {
    cfg.speech = { apiKey: 'private-key', model: 'gpt-audio-1.5' };
    const mock = vi.fn(async () => answer('¡Hola, Hannah!'));
    vi.stubGlobal('fetch', mock);
    expect(await speech({ text: ' ¡Hola, Hannah! ', voice: 'cedar' })).toEqual(AUDIO);
    const [url, options] = mock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(options.headers.Authorization).toBe('Bearer private-key');
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({
      model: 'gpt-audio-1.5',
      modalities: ['text', 'audio'],
      audio: { voice: 'cedar', format: 'opus' },
    });
    expect(body.messages[0]).toMatchObject({ role: 'system' });
    expect(body.messages[1]).toEqual({ role: 'user', content: '¡Hola, Hannah!' });
  });
  it('accepts a transcript that differs only in case, spacing or punctuation', async () => {
    cfg.speech = { apiKey: 'private-key', model: 'gpt-audio-1.5' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer('hola hannah… ¿Cómo estás')),
    );
    expect(await speech({ text: '¡Hola, Hannah! ¿Cómo estás?' })).toEqual(AUDIO);
  });
  it('sends nothing when the model said something else', async () => {
    cfg.speech = { apiKey: 'private-key', model: 'gpt-audio-1.5' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer('¡Hola! Claro, aquí tienes el mensaje.')),
    );
    await expect(speech({ text: '¡Hola, Hannah!' })).rejects.toMatchObject({
      status: 502,
      message: 'OpenAI did not read the text word for word; nothing was sent',
    });
  });
  it('rejects answers without Ogg audio', async () => {
    cfg.speech = { apiKey: 'private-key', model: 'gpt-audio-1.5' };
    for (const res of [
      () => new Response('not json'),
      () => Response.json({ choices: [{ message: { content: 'Hola' } }] }),
      () => answer('Hola', Buffer.from('RIFFwav').toString('base64')),
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => res()),
      );
      await expect(speech({ text: 'Hola' })).rejects.toMatchObject({ status: 502 });
    }
  });
  it('refuses the voices only the speech endpoint has before calling OpenAI', async () => {
    cfg.speech = { apiKey: 'private-key', model: 'gpt-audio-1.5' };
    const mock = vi.fn();
    vi.stubGlobal('fetch', mock);
    await expect(speech({ text: 'Hola', voice: 'nova' })).rejects.toMatchObject({ status: 400 });
    expect(mock).not.toHaveBeenCalled();
  });
});
