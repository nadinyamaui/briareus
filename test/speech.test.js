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
  it('uses coral by default and propagates cancellation', async () => {
    const mock = vi.fn(async () => new Response(AUDIO));
    vi.stubGlobal('fetch', mock);
    const controller = new AbortController();
    await speech({ text: 'Hola' }, controller.signal);
    expect(JSON.parse(mock.mock.calls[0][1].body).voice).toBe('coral');
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
