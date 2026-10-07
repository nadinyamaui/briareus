// @ts-check
// Slack for the operator's core inbox and, separately, for project sessions.
// The inbox (lib/slack-inbox.js) reads and replies without an agent; signed
// events feed native clients even when no session exists.
// An agent sends a message to a person or a channel when
// the user tells it to ("send this to Andres"), and what that person answers
// comes back into the same session.
//
// A workspace is one Slack user token: messages go out as the person who
// installed the app, not as a bot, so they read as the operator's own. That
// is why each project names the channels it may post to and whether it may
// write to people at all, and why a message waits for the operator's approval
// unless the project says it need not (as SSH commands do, lib/ssh.js). A turn
// nobody is watching (a webhook delivery, a Slack reply) always asks.
//
// Replies arrive through Slack's Events API, signed with the app's signing
// secret, on /webhooks/slack/<workspace id>. A reply is routed by what this
// service sent: an answer in a direct message goes to the session that last
// wrote to that person, a reply in a thread to the session that started it.
// Nothing else that happens in the workspace reaches any session. What arrives
// is the other person's word, not the operator's, so it reaches the agent as a
// delivery (deliverToSession in lib/jobs.js), never as an instruction.
//
// Workspaces live in `app_settings` with the token and signing secret sealed
// under CREDENTIALS_KEY (lib/secretbox.js); what was sent, which is what
// routes a reply, lives there too, so a restart does not orphan a conversation.
// Requests waiting for approval are held in memory only: a restart sends
// nothing it was not told to after the restart.

import crypto from 'node:crypto';
import { loadAppSetting, saveAppSetting } from './db.js';
import { seal, open } from './secretbox.js';
import { SIGNATURE_TOLERANCE_S, DELIVERY_MAX_CHARS, deliveryId } from './deliveries.js';
import { createSlackInbox } from './slack-inbox.js';

export const SLACK_WORKSPACE_DEFAULTS = { label: '', projects: [] };
export const SLACK_PROJECT_DEFAULTS = { repo: '', channels: [], directMessages: true, permissionMode: 'ask' };

// User scopes for the core inbox: directories, history/events, sending and
// read positions. Existing agent-only installs can keep their old scopes;
// Slack reports any missing scope when an inbox method needs it.
export const SLACK_USER_SCOPES = [
  'chat:write',
  'users:read',
  'channels:read',
  'groups:read',
  'im:read',
  'mpim:read',
  'im:write',
  'mpim:write',
  'channels:write',
  'groups:write',
  'im:history',
  'mpim:history',
  'channels:history',
  'groups:history',
];

const REPO = /^[\w.-]+\/[\w.-]+$/;
const CHANNEL = /^[\p{L}\p{N}._-]{1,80}$/u;
const USER_ID = /^[UW][A-Z0-9]+$/;
const TS = /^\d{1,12}\.\d{1,9}$/;
const MAX_TEXT = 8000;
// How long a message may wait for approval: long enough to be approved from a
// walk, short enough that a stale one is not sent days later.
const APPROVAL_TTL = 24 * 3600_000;
const DIRECTORY_TTL = 10 * 60_000;
// How long, and how many, sent messages are remembered for routing replies.
const CONVERSATION_TTL = 30 * 24 * 3600_000;
const MAX_CONVERSATIONS = 500;
// A direct message answered later than this is a new conversation, not a
// reply to whatever this app last sent there.
const DM_REPLY_WINDOW = 14 * 24 * 3600_000;

/** @param {string} message @param {number} status */
function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

// Slack's Web API, form-encoded (every method takes it) and with the token as
// a bearer. An error Slack answers with `ok: false` becomes one that says what
// to do about it where that is known.
/** @param {{ fetchImpl?: typeof fetch }} [opts] */
export function createSlackApi({ fetchImpl = fetch } = {}) {
  /**
   * @param {string} token
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<Record<string, any>>}
   */
  return async function call(token, method, params = {}) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params))
      if (v !== undefined && v !== null && v !== '') body.set(k, String(v));
    let res;
    try {
      res = await fetchImpl(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      throw httpError(`Slack could not be reached: ${e.message}`, 502);
    }
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after')) || 30;
      throw Object.assign(httpError(`Slack is rate limiting this workspace; try again in ${after} s`, 429), {
        retryAfter: after,
      });
    }
    const json = await res.json().catch(() => null);
    if (!json) throw httpError(`Slack answered HTTP ${res.status}`, 502);
    if (!json.ok) throw slackError(json);
    return json;
  };
}

/** @param {Record<string, any>} json */
function slackError(json) {
  const code = String(json.error || 'unknown_error');
  if (['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive'].includes(code))
    return httpError(`Slack refused the workspace’s token (${code})`, 502);
  if (code === 'missing_scope')
    return httpError(
      `The Slack token lacks the ${json.needed || 'needed'} scope; add it to the app’s user token scopes and reinstall the app`,
      502,
    );
  return httpError(`Slack answered ${code}`, 502);
}

// Slack signs every Events API request: HMAC-SHA256 under the app's signing
// secret over `v0:<timestamp>:<raw body>`. The timestamp is what makes a
// captured request worthless a few minutes later.
/**
 * @param {Buffer} raw
 * @param {string | undefined} timestamp
 * @param {string | undefined} signature
 * @param {string} secret
 */
export function verifySlackSignature(raw, timestamp, signature, secret, now = Date.now()) {
  if (!secret || !signature || !signature.startsWith('v0=') || !/^\d{1,12}$/.test(timestamp || ''))
    return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_S) return false;
  const expected = `v0=${crypto.createHmac('sha256', secret).update(`v0:${timestamp}:`).update(raw).digest('hex')}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** @param {unknown} list */
function normalizeProjects(list) {
  if (!Array.isArray(list))
    throw new Error('`projects` is a list of { repo, channels, directMessages, permissionMode }');
  const seen = new Set();
  return list.map((p) => {
    if (!p || typeof p !== 'object')
      throw new Error('Each project is { repo, channels, directMessages, permissionMode }');
    const e = { ...SLACK_PROJECT_DEFAULTS, ...p };
    const repo = String(e.repo ?? '').trim();
    if (!REPO.test(repo)) throw new Error('Choose projects as owner/name');
    if (seen.has(repo)) throw new Error(`${repo} is listed twice`);
    seen.add(repo);
    if (!Array.isArray(e.channels) || e.channels.some((/** @type {unknown} */ c) => typeof c !== 'string'))
      throw new Error('`channels` is a list of channel names or ids');
    const channels = [
      ...new Set(e.channels.map((/** @type {string} */ c) => c.trim().replace(/^#/, '')).filter(Boolean)),
    ];
    const bad = channels.find((c) => !CHANNEL.test(c));
    if (bad) throw new Error(`“${bad}” is not a Slack channel name or id`);
    if (typeof e.directMessages !== 'boolean') throw new Error('`directMessages` must be true or false');
    if (!['ask', 'allow'].includes(e.permissionMode))
      throw new Error('Choose a Slack permission mode: ask or allow');
    return { repo, channels, directMessages: e.directMessages, permissionMode: e.permissionMode };
  });
}

// What a workspace looks like everywhere but the store: the sealed token and
// secret stay behind, their presence does not.
/** @param {Record<string, any>} w @param {string} eventsUrl */
function publicWorkspace({ token, signingSecret, ...w }, eventsUrl) {
  return { ...w, hasToken: !!token, hasSigningSecret: !!signingSecret, eventsUrl };
}

/** @param {string} s */
const fold = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();

/** @param {Record<string, any>} u */
const personOf = (u) => ({
  id: u.id,
  handle: u.name || '',
  realName: u.real_name || u.profile?.real_name || '',
  displayName: u.profile?.display_name || '',
  title: u.profile?.title || '',
});

/**
 * @param {{
 *   load?: typeof loadAppSetting,
 *   save?: typeof saveAppSetting,
 *   api?: ReturnType<typeof createSlackApi>,
 *   getJob?: (id: string) => any,
 *   deliver?: (id: string, delivery: { text: string, source: string, id: string }) => any,
 *   note?: (id: string, text: string) => void,
 *   unfit?: (job: any) => string | null,
 *   eventsUrl?: (id: number) => string,
 *   now?: () => number,
 *   log?: (message: string) => void,
 * }} [deps]
 */
export function createSlackService({
  load = loadAppSetting,
  save = saveAppSetting,
  api = createSlackApi(),
  getJob = (_id) => null,
  deliver = () => {},
  note = () => {},
  unfit = () => null,
  eventsUrl = () => '',
  now = Date.now,
  log = (message) => console.log(`slack: ${message}`),
} = {}) {
  /** @type {Record<string, any>[]} */
  let workspaces = [];
  /** @type {Record<string, any>[]} */
  let conversations = [];
  let writes = Promise.resolve();
  let conversationWrites = Promise.resolve();
  /** @type {Map<string, Record<string, any>>} */
  const requests = new Map();
  /** @type {Map<number, Record<string, { at: number, list: Record<string, any>[] }>>} */
  const directory = new Map();
  /** @type {Map<string, number>} */
  const seenEvents = new Map();
  const inbox = createSlackInbox({
    getWorkspace: (id) => workspaces.find((w) => String(w.id) === String(id)),
    api,
    sent: (entry) => remember({ ...entry, jobId: null, at: now() }),
    log,
  });

  const view = (/** @type {Record<string, any>} */ w) => publicWorkspace(w, eventsUrl(w.id));

  /** @param {(rows: Record<string, any>[]) => Record<string, any>[]} fn */
  function mutate(fn) {
    const task = writes.then(async () => {
      const next = fn(workspaces);
      await save('slack_workspaces', next);
      const previous = workspaces;
      workspaces = next;
      for (const old of previous) {
        const updated = next.find((w) => w.id === old.id);
        if (!updated) inbox.disconnect(old.id, 'workspace.removed');
        else if (updated.token !== old.token || updated.signingSecret !== old.signingSecret)
          inbox.disconnect(old.id, 'workspace.changed');
      }
      // An approval was asked under the old token and the old rules.
      for (const r of requests.values()) {
        if (r.status === 'pending' && snapshotOf(r.workspaceId, r.repo) !== r.snapshot) {
          r.status = 'cancelled';
          r.error = 'Slack settings changed; send the message again';
        }
      }
    });
    writes = task.catch(() => {});
    return task;
  }

  /** @param {number} id @param {string} repo */
  function snapshotOf(id, repo) {
    const w = workspaces.find((w) => w.id === id);
    const p = w && w.projects.find((/** @type {any} */ p) => p.repo === repo);
    return p ? JSON.stringify({ token: w.token, project: p }) : '';
  }

  // A project is served by one workspace at most: "send this to Andres" must
  // not depend on which of two Andreses' workspaces the agent tried first.
  /** @param {Record<string, any>[]} rows @param {Record<string, any>} w */
  function checkClaims(rows, w) {
    for (const other of rows) {
      if (other.id === w.id) continue;
      const taken = w.projects.find((/** @type {any} */ p) =>
        other.projects.some((/** @type {any} */ q) => q.repo === p.repo),
      );
      if (taken) throw new Error(`${taken.repo} already sends through the ${other.label} workspace`);
    }
  }

  // The fields a body may set, checked, and when it carries a new token, who
  // that token is: what the workspace's messages go out as, and the team its
  // events must come from.
  /** @param {Record<string, any>} input @param {Record<string, any>} existing */
  async function normalize(input, existing) {
    const w = { ...existing };
    if (Object.hasOwn(input, 'label')) w.label = String(input.label ?? '').trim();
    if (Object.hasOwn(input, 'projects')) w.projects = normalizeProjects(input.projects);
    const secret = Object.hasOwn(input, 'signingSecret') ? String(input.signingSecret ?? '').trim() : '';
    if (secret) {
      if (!/^[A-Za-z0-9]{8,200}$/.test(secret))
        throw new Error('Enter the signing secret from the Slack app’s Basic Information');
      w.signingSecret = seal(secret);
    }
    // A blank or absent token keeps the stored one, so a form can be saved
    // without retyping it.
    const token = Object.hasOwn(input, 'token') ? String(input.token ?? '').trim() : '';
    if (token) {
      if (!/^(xoxe\.)?xoxp-[\w-]{10,500}$/.test(token))
        throw new Error(
          'Enter a Slack user token (xoxp-…): messages go out as the user who installed the app',
        );
      const me = await api(token, 'auth.test');
      if (w.teamId && me.team_id !== w.teamId)
        throw new Error(`That token is for ${me.team}, not ${w.team}; add it as a workspace of its own`);
      Object.assign(w, {
        token: seal(token),
        team: me.team || '',
        teamId: me.team_id || '',
        user: me.user || '',
        userId: me.user_id || '',
        url: me.url || '',
      });
      directory.delete(w.id);
    }
    if (!w.token) throw new Error('Enter a Slack user token');
    if (!w.label) w.label = w.team || 'Slack';
    if (w.label.length > 200) throw new Error('Label too long');
    return w;
  }

  /** @param {Record<string, any>} w */
  async function directoryOf(w, kind) {
    const cached = directory.get(w.id)?.[kind];
    if (cached && now() - cached.at < DIRECTORY_TTL) return cached.list;
    const token = open(w.token);
    /** @type {Record<string, any>[]} */
    const list = [];
    let cursor = '';
    for (let page = 0; page < 50; page++) {
      const res =
        kind === 'people'
          ? await api(token, 'users.list', { limit: 200, cursor })
          : await api(token, 'conversations.list', {
              types: 'public_channel,private_channel',
              exclude_archived: true,
              limit: 1000,
              cursor,
            });
      for (const row of kind === 'people' ? res.members || [] : res.channels || []) {
        if (kind === 'people' && (row.deleted || row.is_bot || row.id === 'USLACKBOT')) continue;
        list.push(row);
      }
      cursor = res.response_metadata?.next_cursor || '';
      if (!cursor) break;
    }
    directory.set(w.id, { ...directory.get(w.id), [kind]: { at: now(), list } });
    return list;
  }

  // The project's channels as Slack has them, by id or by name, and the ones
  // it does not know (renamed, archived, private and not joined).
  /** @param {Record<string, any>} w @param {Record<string, any>} project */
  async function allowedChannels(w, project) {
    if (!project.channels.length) return { channels: [], unknown: [] };
    const all = await directoryOf(w, 'channels');
    /** @type {{ id: string, name: string }[]} */
    const channels = [];
    /** @type {string[]} */
    const unknown = [];
    for (const entry of project.channels) {
      const c = all.find((c) => c.id === entry || fold(c.name) === fold(entry));
      if (c) channels.push({ id: c.id, name: c.name });
      else unknown.push(entry);
    }
    return { channels, unknown };
  }

  /** @param {string} repo */
  function access(repo) {
    for (const w of workspaces) {
      const project = w.projects.find((/** @type {any} */ p) => p.repo === repo);
      if (project) return { w, project };
    }
    return null;
  }

  /** @param {Record<string, any>} job */
  function forJob(job) {
    const why = unfit(job);
    if (why) throw httpError(`Slack is not for this session: ${why}`, 403);
    const found = access(job.repo);
    if (!found) throw httpError('This project has no Slack workspace', 404);
    return found;
  }

  // Who or where `to` names: a person by user id or @handle, or one of the
  // project's channels by name or id.
  /** @param {Record<string, any>} w @param {Record<string, any>} project @param {unknown} input */
  async function destination(w, project, input) {
    const to = String(input ?? '').trim();
    if (!to)
      throw new Error('Say who to send it to: a user id from slack_find_people, or one of the channels');
    if (USER_ID.test(to) || to.startsWith('@')) {
      if (!project.directMessages)
        throw new Error('This project may not send direct messages; use one of its channels');
      const people = await directoryOf(w, 'people');
      const u = to.startsWith('@')
        ? people.find((u) => fold(u.name) === fold(to.slice(1)))
        : people.find((u) => u.id === to);
      if (!u) throw new Error(`Nobody in ${w.team || w.label} is ${to}; look them up with slack_find_people`);
      const p = personOf(u);
      return { kind: 'user', id: p.id, label: `@${p.handle}${p.realName ? ` (${p.realName})` : ''}` };
    }
    const { channels } = await allowedChannels(w, project);
    const name = to.replace(/^#/, '');
    const c = channels.find((c) => c.id === name || fold(c.name) === fold(name));
    if (!c) {
      const list = channels.map((c) => `#${c.name}`).join(', ');
      throw new Error(
        `#${name} is not one of this project’s Slack channels${list ? ` (${list})` : '; it has none'}`,
      );
    }
    return { kind: 'channel', id: c.id, label: `#${c.name}` };
  }

  const publicRequest = (/** @type {Record<string, any>} */ { snapshot, ...r }) => ({ ...r });

  function sweep() {
    for (const [id, r] of requests) {
      if (r.status === 'pending' && (now() >= r.expiresAt || !getJob(r.jobId))) {
        r.status = 'cancelled';
        r.error = getJob(r.jobId) ? 'Not approved within a day' : 'The session is gone';
      }
      if (!['pending', 'sending'].includes(r.status) && now() - r.createdAt > APPROVAL_TTL)
        requests.delete(id);
    }
  }

  /** @param {Record<string, any>} entry */
  function remember(entry) {
    const task = conversationWrites.then(async () => {
      const cutoff = now() - CONVERSATION_TTL;
      const next = [...conversations.filter((c) => c.at > cutoff), entry].slice(-MAX_CONVERSATIONS);
      await save('slack_conversations', next);
      conversations = next;
    });
    conversationWrites = task.catch((e) => log(`could not remember a sent message: ${e.message}`));
    return conversationWrites;
  }

  /** @param {Record<string, any>} r */
  async function send(r) {
    // Claimed before the first await: two approvals cannot send twice.
    r.status = 'sending';
    try {
      const w = workspaces.find((w) => w.id === r.workspaceId);
      if (!w) throw new Error('The Slack workspace is gone');
      const token = open(w.token);
      let channel = r.to.id;
      if (r.to.kind === 'user')
        channel = (await api(token, 'conversations.open', { users: r.to.id })).channel.id;
      if (snapshotOf(r.workspaceId, r.repo) !== r.snapshot)
        throw new Error('Slack settings changed; send the message again');
      const posted = await api(token, 'chat.postMessage', { channel, text: r.text, thread_ts: r.threadTs });
      r.status = 'sent';
      r.sentAt = now();
      r.result = { channel, ts: posted.ts };
      await remember({
        workspaceId: w.id,
        channel,
        ts: posted.ts,
        threadTs: r.threadTs || '',
        jobId: r.jobId,
        repo: r.repo,
        to: r.to.label,
        at: now(),
      });
      if (r.approved) note(r.jobId, `Slack: your approved message to ${r.to.label} was sent.`);
    } catch (e) {
      r.status = 'failed';
      r.error = e.message;
      if (r.approved)
        note(r.jobId, `Slack: the approved message to ${r.to.label} could not be sent: ${e.message}`);
    }
  }

  // Slack's markup, made readable: mentions by name, links as their text and
  // address, and the three entities it escapes.
  /** @param {Record<string, any>} w @param {string} text */
  function plain(w, text) {
    const people = directory.get(w.id)?.people?.list || [];
    return String(text || '')
      .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_m, id) => {
        const u = people.find((u) => u.id === id);
        return u ? `@${u.name}` : `@${id}`;
      })
      .replace(/<#([CG][A-Z0-9]+)\|([^>]*)>/g, (_m, _id, name) => `#${name}`)
      .replace(/<(https?:[^|>]+)\|([^>]+)>/g, (_m, url, label) => `${label} (${url})`)
      .replace(/<(https?:[^>]+)>/g, '$1')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  // Which sent message a message answers: one in a thread this app started or
  // posted into, or one in a direct message this app wrote in lately.
  /** @param {Record<string, any>} w @param {Record<string, any>} e */
  function answered(w, e) {
    const here = conversations.filter((c) => c.workspaceId === w.id && c.channel === e.channel);
    if (e.thread_ts) {
      const thread = here
        .filter((c) => c.jobId && (c.ts === e.thread_ts || c.threadTs === e.thread_ts))
        .at(-1);
      if (thread) return thread;
    }
    if (e.channel_type === 'im') {
      const last = here.at(-1);
      if (last && now() - last.at < DM_REPLY_WINDOW) return last;
    }
    return null;
  }

  return {
    inbox,
    async init() {
      workspaces = (await load('slack_workspaces', [])) || [];
      conversations = (await load('slack_conversations', [])) || [];
    },
    // Every workspace, or the one a project sends through.
    /** @param {string} [repo] */
    list(repo) {
      return workspaces
        .filter((w) => repo === undefined || w.projects.some((/** @type {any} */ p) => p.repo === repo))
        .map(view);
    },
    /** @param {Record<string, any>} input */
    async create(input) {
      const w = await normalize(input, { ...SLACK_WORKSPACE_DEFAULTS, id: 0, token: '', signingSecret: '' });
      await mutate((rows) => {
        w.id = Math.max(Date.now(), ...rows.map((r) => r.id + 1));
        checkClaims(rows, w);
        return [...rows, w];
      });
      return view(w);
    },
    /** @param {number} id @param {Record<string, any>} input */
    async update(id, input) {
      const old = workspaces.find((w) => w.id === id);
      if (!old) throw httpError('Slack workspace not found', 404);
      const updated = await normalize(input, old);
      await mutate((rows) => {
        const current = rows.find((w) => w.id === id);
        if (!current) throw httpError('Slack workspace not found', 404);
        // Token validation may outlast a newer edit revoking project access.
        if (current !== old) throw httpError('Slack workspace changed; reload and try again', 409);
        checkClaims(rows, updated);
        return rows.map((w) => (w.id === id ? updated : w));
      });
      return view(updated);
    },
    /** @param {number} id */
    async remove(id) {
      await mutate((rows) => {
        if (!rows.some((w) => w.id === id)) throw httpError('Slack workspace not found', 404);
        return rows.filter((w) => w.id !== id);
      });
      directory.delete(id);
    },

    // What a session's briefing says, or null when its project has no Slack.
    /** @param {string} repo */
    briefing(repo) {
      const found = access(repo);
      if (!found) return null;
      const { w, project } = found;
      return {
        team: w.team || w.label,
        user: w.user,
        permissionMode: project.permissionMode,
        directMessages: project.directMessages,
        channels: project.channels,
        replies: !!w.signingSecret,
      };
    },

    /** @param {Record<string, any>} job */
    async destinations(job) {
      const { w, project } = forJob(job);
      const { channels, unknown } = await allowedChannels(w, project);
      return {
        workspace: w.team || w.label,
        sendsAs: w.user,
        permissionMode: job.unattendedTurn ? 'ask' : project.permissionMode,
        directMessages: project.directMessages,
        channels,
        ...(unknown.length ? { unknownChannels: unknown } : {}),
      };
    },
    /** @param {Record<string, any>} job @param {unknown} query */
    async findPeople(job, query) {
      const { w, project } = forJob(job);
      if (!project.directMessages) throw new Error('This project may not send direct messages');
      const q = fold(String(query ?? ''));
      if (!q) throw new Error('Say who to look for');
      const scored = [];
      for (const u of await directoryOf(w, 'people')) {
        const p = personOf(u);
        const names = [p.handle, p.realName, p.displayName].map(fold).filter(Boolean);
        const words = names.flatMap((n) => n.split(/[\s._-]+/));
        const score = names.includes(q)
          ? 3
          : words.includes(q)
            ? 2
            : names.some((n) => n.startsWith(q)) || words.some((n) => n.startsWith(q))
              ? 1
              : q.length >= 3 && names.some((n) => n.includes(q))
                ? 0.5
                : 0;
        if (score) scored.push({ p, score });
      }
      return scored
        .sort((a, b) => b.score - a.score || a.p.realName.localeCompare(b.p.realName))
        .slice(0, 10)
        .map(({ p }) => p);
    },
    /** @param {Record<string, any>} job @param {Record<string, any>} input */
    async request(job, input) {
      sweep();
      const { w, project } = forJob(job);
      if (job.status !== 'running') throw new Error('Slack messages are sent from a running session turn');
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!text || text.length > MAX_TEXT || text.includes('\0'))
        throw new Error(`Write a message of 1–${MAX_TEXT} characters`);
      const snapshot = snapshotOf(w.id, job.repo);
      const to = await destination(w, project, input.to);
      if (snapshotOf(w.id, job.repo) !== snapshot)
        throw new Error('Slack settings changed; send the message again');
      const threadTs = input.threadTs ? String(input.threadTs) : '';
      if (threadTs && !TS.test(threadTs))
        throw new Error('`threadTs` is a Slack message ts, like 1712345678.123456');
      if (requests.size >= 200) {
        const oldest = [...requests.values()].find((r) => !['pending', 'sending'].includes(r.status));
        if (oldest) requests.delete(oldest.id);
        else throw new Error('Too many Slack messages are waiting; wait for some to be approved or denied');
      }
      const r = {
        id: crypto.randomUUID(),
        workspaceId: w.id,
        workspaceLabel: w.team || w.label,
        sendsAs: w.user,
        repo: job.repo,
        jobId: job.id,
        sessionTitle: job.title || job.id,
        to,
        text,
        threadTs,
        status: 'pending',
        createdAt: now(),
        expiresAt: now() + APPROVAL_TTL,
        snapshot,
        // Said on the approval card, so an allow-mode project asking is no puzzle.
        unattended: !!job.unattendedTurn,
      };
      requests.set(r.id, r);
      if (project.permissionMode === 'allow' && !job.unattendedTurn) await send(r);
      return publicRequest(r);
    },
    /** @param {Record<string, any>} job @param {string} id */
    result(job, id) {
      sweep();
      const r = requests.get(id);
      if (!r || r.jobId !== job.id) throw httpError('Slack message not found', 404);
      return publicRequest(r);
    },
    pending() {
      sweep();
      return [...requests.values()].filter((r) => r.status === 'pending').map(publicRequest);
    },
    /** @param {string} id @param {unknown} decision */
    async decide(id, decision) {
      sweep();
      if (decision !== 'approve' && decision !== 'deny') throw new Error('Choose approve or deny');
      const r = requests.get(id);
      if (!r || r.status !== 'pending')
        throw new Error('That Slack message is no longer waiting for approval');
      if (decision === 'deny') {
        r.status = 'denied';
        r.error = 'The user denied this message';
        note(r.jobId, `Slack: you denied the message to ${r.to.label}.`);
        return publicRequest(r);
      }
      if (snapshotOf(r.workspaceId, r.repo) !== r.snapshot) {
        r.status = 'cancelled';
        r.error = 'Slack settings changed; send the message again';
        throw new Error(r.error);
      }
      r.approved = true;
      await send(r);
      return publicRequest(r);
    },

    // An Events API request, already read off the wire. The signature is
    // checked here, where the workspace's secret is; what the route answers
    // Slack is what this returns.
    /**
     * @param {string} id the workspace, from the URL
     * @param {Buffer} raw
     * @param {{ timestamp?: string, signature?: string }} headers
     * @returns {{ status: number, body: Record<string, any>, then?: () => Promise<void> }}
     */
    receive(id, raw, { timestamp, signature }) {
      const w = workspaces.find((w) => String(w.id) === String(id));
      if (
        !w ||
        !w.signingSecret ||
        !verifySlackSignature(raw, timestamp, signature, open(w.signingSecret), now())
      )
        return { status: 401, body: { error: 'Bad signature' } };
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        return { status: 400, body: { error: 'Body is not JSON' } };
      }
      if (payload.type === 'url_verification') return { status: 200, body: { challenge: payload.challenge } };
      if (payload.type !== 'event_callback' || (w.teamId && payload.team_id !== w.teamId))
        return { status: 200, body: { ok: true } };
      // Slack retries anything not answered in three seconds, with the same id.
      const eventId = String(payload.event_id || '');
      for (const [key, at] of seenEvents) if (now() - at > 3600_000) seenEvents.delete(key);
      const eventKey = `${w.id}:${eventId}`;
      if (eventId && seenEvents.has(eventKey)) return { status: 200, body: { ok: true } };
      if (eventId) seenEvents.set(eventKey, now());
      const e = payload.event || {};
      // Slack may report only one installation even when several can see
      // the event. A positive connected-user authorization suffices; otherwise
      // check access with that user's token rather than trusting the app secret.
      const visible =
        Array.isArray(payload.authorizations) &&
        payload.authorizations.some(
          (a) => a.user_id === w.userId && a.team_id === w.teamId && a.is_bot === false,
        );
      if (visible) inbox.receive(w.id, e, eventId);
      else
        inbox
          .receiveVisible(w.id, e, eventId)
          .catch((err) => log(`inbox event access check failed: ${err.message}`));
      const fromSomebody =
        e.type === 'message' &&
        (!e.subtype || e.subtype === 'file_share' || e.subtype === 'thread_broadcast') &&
        !e.bot_id &&
        e.user &&
        e.user !== w.userId;
      const sent = fromSomebody ? answered(w, e) : null;
      if (!sent || !getJob(sent.jobId) || !w.projects.some((p) => p.repo === sent.repo))
        return { status: 200, body: { ok: true } };
      return {
        status: 200,
        body: { ok: true },
        then: async () => {
          const people = await directoryOf(w, 'people').catch(() => []);
          const current = workspaces.find((w) => w.id === sent.workspaceId);
          if (!current?.projects.some((p) => p.repo === sent.repo)) return;
          const u = people.find((u) => u.id === e.user);
          const p = u ? personOf(u) : { id: e.user, handle: e.user, realName: '' };
          const who = `${p.realName || p.handle} (@${p.handle}, ${p.id})`;
          const where =
            e.channel_type === 'im'
              ? 'in a direct message'
              : `in ${sent.to.startsWith('#') ? sent.to : 'a channel'}, thread ${e.thread_ts || sent.ts}`;
          const files = (e.files || []).length;
          let text = plain(w, e.text);
          if (files) text += `\n\n(with ${files} attached file${files === 1 ? '' : 's'}, not shown here)`;
          const head = `Slack reply from ${who} ${where}, answering this session’s message to ${sent.to}:`;
          const body = `${head}\n\n${text}`.slice(0, DELIVERY_MAX_CHARS - 100);
          try {
            const outcome = deliver(sent.jobId, {
              text: body,
              source: `Slack @${p.handle}`,
              id: deliveryId(`slack:${eventId || e.ts}`),
            });
            log(`session ${sent.jobId} ← a reply from @${p.handle} (${outcome?.status || 'taken'})`);
          } catch (err) {
            log(`a reply from @${p.handle} for session ${sent.jobId} was not taken: ${err.message}`);
            note(sent.jobId, `Slack: a reply from @${p.handle} could not reach the agent: ${err.message}`);
          }
        },
      };
    },
  };
}
