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
// The gpt-audio models speak through chat completions, which lack the oldest TTS voices.
const SPEECH_ONLY_VOICES = ['fable', 'onyx', 'nova'];
const isAudioChatModel = (model) => /^gpt-audio/.test(model);

// gpt-audio is a conversational model: the instruction asks it to read rather than reply,
// and its transcript is checked against the text so a paraphrase is never sent as if it
// were the words the session chose.
const READ_ALOUD =
  'You are a text-to-speech engine. Read the user message aloud exactly as written, word for word, ' +
  'in its own language, with natural, warm expression. Do not add, omit, translate or answer anything.';
const spoken = (s) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

function request(cfg, input, voice) {
  if (!isAudioChatModel(cfg.model))
    return {
      url: 'https://api.openai.com/v1/audio/speech',
      body: { model: cfg.model, input, voice, response_format: 'opus' },
    };
  return {
    url: 'https://api.openai.com/v1/chat/completions',
    body: {
      model: cfg.model,
      modalities: ['text', 'audio'],
      audio: { voice, format: 'opus' },
      messages: [
        { role: 'system', content: READ_ALOUD },
        { role: 'user', content: input },
      ],
    },
  };
}

const MAX_AUDIO = 25 * 1024 * 1024;

async function readBody(res, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > limit) throw fail('Generated voice note is larger than 25 MiB', 502);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Generate Ogg/Opus directly: WAHA can send it as a voice note without conversion.
export async function speech({ text, voice = 'marin' }, signal = undefined) {
  if (typeof text !== 'string' || !text.trim() || text.length > 4096 || text.includes('\0'))
    throw fail('Write a voice note of 1–4096 characters');
  if (!SPEECH_VOICES.includes(voice)) throw fail('Choose a supported OpenAI speech voice');
  const cfg = getConfig().speech;
  if (!cfg)
    throw fail(
      'Voice generation is off: set OPENAI_SPEECH_API_KEY and OPENAI_SPEECH_MODEL for the server',
      503,
    );
  if (isAudioChatModel(cfg.model) && SPEECH_ONLY_VOICES.includes(voice))
    throw fail(`The ${voice} voice is not available with ${cfg.model}; choose another voice`);
  const input = text.trim();
  const { url, body } = request(cfg, input, voice);
  let audio;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw fail(`OpenAI could not generate the voice note (HTTP ${res.status})`, 502);
    }
    // Base64 inflates the chat answer by a third; its audio is held to MAX_AUDIO once decoded.
    audio = await readBody(res, isAudioChatModel(cfg.model) ? Math.ceil(MAX_AUDIO * 1.4) : MAX_AUDIO);
  } catch (e) {
    if (e.status) throw e;
    // OpenAI sometimes accepts the request and then stalls mid-stream for minutes.
    if (e.name === 'TimeoutError')
      throw fail('OpenAI took more than 2 minutes to generate the voice note; nothing was sent', 504);
    throw fail('Could not reach OpenAI to generate the voice note', 502);
  }
  if (isAudioChatModel(cfg.model)) {
    let message;
    try {
      message = JSON.parse(audio.toString()).choices?.[0]?.message;
    } catch {
      throw fail('OpenAI returned no voice note', 502);
    }
    if (typeof message?.audio?.data !== 'string') throw fail('OpenAI returned no voice note', 502);
    if (spoken(String(message.audio.transcript || '')) !== spoken(input))
      throw fail('OpenAI did not read the text word for word; nothing was sent', 502);
    audio = Buffer.from(message.audio.data, 'base64');
    if (audio.length > MAX_AUDIO) throw fail('Generated voice note is larger than 25 MiB', 502);
  }
  if (audio.subarray(0, 4).toString() !== 'OggS') throw fail('OpenAI returned no Ogg voice note', 502);
  return audio;
}
