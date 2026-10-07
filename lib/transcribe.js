// @ts-check
// Voice notes: the composer posts recorded audio here and OpenAI's transcription API turns
// it into text. The call is server-side so the key never reaches a page.

import { getConfig } from './config.js';

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

// OpenAI detects the format by file name, not part type, so the name must carry the
// recorded extension: Chrome and Firefox record webm or ogg (opus), Safari mp4.
const EXTENSIONS = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

// The API takes ISO 639-1 codes only and answers 400 otherwise. A client's BCP 47 tag may
// name some differently: nb and nn as no, fil as Tagalog, and the retired iw for Hebrew.
const LANGUAGE_ALIASES = { nb: 'no', nn: 'no', fil: 'tl', iw: 'he' };

/** @param {string} tag */
function apiLanguage(tag) {
  const primary = /^([a-z]{2,3})(?:-|$)/i.exec(tag)?.[1]?.toLowerCase() || '';
  const code = LANGUAGE_ALIASES[primary] || primary;
  return code.length === 2 ? code : '';
}

export function transcribeAvailable() {
  return !!getConfig().transcribe;
}

/** @param {string} message @param {number} status */
function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

// language: a BCP 47 tag (es-ES); the API wants its ISO 639-1 half and guesses when there
// is none it accepts (yue). signal: aborts the call when the requester has gone.
/**
 * @param {Buffer} audio
 * @param {{ type?: string, language?: string, signal?: AbortSignal }} [opts]
 * @returns {Promise<string>}
 */
export async function transcribe(audio, { type = '', language = '', signal } = {}) {
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
  // A Buffer is a Uint8Array already, so the recording is not copied again.
  form.append(
    'file',
    new Blob([/** @type {Uint8Array<ArrayBuffer>} */ (audio)], { type: mime }),
    `voice-note.${ext}`,
  );
  form.append('model', cfg.model);
  const lang = apiLanguage(language);
  if (lang) form.append('language', lang);
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
      // Five minutes of audio (a voice note's maximum) returns well inside this; past it
      // the service is not answering.
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
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
