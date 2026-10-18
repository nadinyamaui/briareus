// @ts-check
import { getConfig } from './config.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const SPEECH_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
  'fable',
  'onyx',
  'nova',
];

// Generate Ogg/Opus directly: WAHA can send it as a voice note without conversion.
export async function speech({ text, voice = 'coral' }, signal = undefined) {
  if (typeof text !== 'string' || !text.trim() || text.length > 4096 || text.includes('\0'))
    throw fail('Write a voice note of 1–4096 characters');
  if (!SPEECH_VOICES.includes(voice)) throw fail('Choose a supported OpenAI speech voice');
  const cfg = getConfig().speech;
  if (!cfg)
    throw fail(
      'Voice generation is off: set OPENAI_SPEECH_API_KEY and OPENAI_SPEECH_MODEL for the server',
      503,
    );
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, input: text.trim(), voice, response_format: 'opus' }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw fail(`OpenAI could not generate the voice note (HTTP ${res.status})`, 502);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > 25 * 1024 * 1024) throw fail('Generated voice note is larger than 25 MiB', 502);
      chunks.push(chunk);
    }
    const audio = Buffer.concat(chunks);
    if (audio.subarray(0, 4).toString() !== 'OggS') throw fail('OpenAI returned no Ogg voice note', 502);
    return audio;
  } catch (e) {
    if (e.status) throw e;
    throw fail('Could not reach OpenAI to generate the voice note', 502);
  }
}
