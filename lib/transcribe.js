// @ts-check
// Voice notes: the composer records the audio and posts it here, and OpenAI's
// transcription API turns it into the text that lands in the message box. The
// call is the server's so the key stays in its environment, never in a page.

import { getConfig } from './config.js';

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

// OpenAI tells the format by the file name, not by the part's type, so the
// name has to carry the extension of what the browser recorded: Chrome and
// Firefox record webm or ogg (opus), Safari mp4.
const EXTENSIONS = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

export function transcribeAvailable() {
  return !!getConfig().transcribe;
}

/** @param {string} message @param {number} status */
function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

// language: the picker's BCP 47 tag (es-ES); the API wants its ISO 639-1
// half, and guesses the language itself when there is none.
/**
 * @param {Buffer} audio
 * @param {{ type?: string, language?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function transcribe(audio, { type = '', language = '' } = {}) {
  const cfg = getConfig().transcribe;
  if (!cfg)
    throw httpError(
      'Voice notes are off: set OPENAI_TRANSCRIBE_API_KEY and OPENAI_TRANSCRIBE_MODEL for the server',
      503,
    );
  const mime = type.split(';')[0].trim().toLowerCase();
  const ext = EXTENSIONS[mime];
  if (!ext) throw httpError(`Voice notes cannot be transcribed from ${mime || 'an untyped recording'}`, 415);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `voice-note.${ext}`);
  form.append('model', cfg.model);
  const lang = /^([a-z]{2,3})(?:-|$)/i.exec(language)?.[1];
  if (lang) form.append('language', lang.toLowerCase());
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
      // Five minutes of audio, the most a voice note records, comes back well
      // inside this; past it the service is not answering.
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    throw httpError(`Could not reach OpenAI to transcribe: ${e.cause?.message || e.message}`, 502);
  }
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* reported below */
  }
  if (!res.ok)
    throw httpError(
      `OpenAI answered ${res.status} to the transcription: ${body?.error?.message || text.slice(0, 200)}`,
      502,
    );
  if (typeof body?.text !== 'string')
    throw httpError('OpenAI answered the transcription without a text', 502);
  return body.text.trim();
}
