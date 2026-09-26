// @ts-check
import { createHash, ECDH } from 'node:crypto';
import webpush from 'web-push';
import { loadAppSetting, saveAppSetting } from './db.js';
export function pushSubscription(input) {
  const url = new URL(input?.endpoint);
  const host = url.hostname;
  const allowed =
    ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'].includes(host) ||
    host.endsWith('.notify.windows.com');
  if (
    !allowed ||
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.href.length > 4096
  )
    throw new Error('Unsupported browser push service');
  const keys = input?.keys;
  if (
    !keys ||
    !/^[\w-]+$/.test(keys.p256dh) ||
    !/^[\w-]+$/.test(keys.auth) ||
    Buffer.from(keys.auth, 'base64url').length !== 16 ||
    Buffer.from(keys.p256dh, 'base64url').length !== 65
  )
    throw new Error('Invalid browser push keys');
  ECDH.convertKey(Buffer.from(keys.p256dh, 'base64url'), 'prime256v1');
  return { endpoint: url.href, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}
const hash = (value) => createHash('sha256').update(value).digest('hex');
const revision = (item) => hash(JSON.stringify([item.id, item.revision, item.summary]));
export function notificationGroups(items, seen = {}) {
  const groups = new Map();
  for (const item of items) {
    const task = item.taskId || item.sessionId || item.id;
    if (!groups.has(task)) groups.set(task, []);
    groups.get(task).push(item);
  }
  return [...groups]
    .filter(([, group]) => group.some((i) => seen[i.id] !== revision(i)))
    .map(([task, group]) => ({
      task,
      items: group,
      payload: {
        title: 'Briareus needs your attention',
        body: `${group.length} item(s) in one task are waiting for you.`,
        tag: `briareus-${hash(task).slice(0, 24)}`,
        url: `/attention?task=${encodeURIComponent(task)}`,
      },
    }));
}
export function createNotificationService({
  load = loadAppSetting,
  save = saveAppSetting,
  send = webpush.sendNotification.bind(webpush),
  keys = webpush.generateVAPIDKeys.bind(webpush),
  now = Date.now,
} = {}) {
  let state = { vapid: null, subscriptions: [] },
    queue = Promise.resolve(),
    ticking = false;
  const transact = (fn) => {
    const task = queue.then(async () => {
      const draft = structuredClone(state);
      const result = await fn(draft);
      if (JSON.stringify(draft) !== JSON.stringify(state)) await save('web_push', draft);
      state = draft;
      return result;
    });
    queue = task.then(
      () => {},
      () => {},
    );
    return task;
  };
  return {
    async init() {
      state = await load('web_push', { vapid: null, subscriptions: [] });
    },
    status() {
      return {
        configured: !!state.vapid,
        publicKey: state.vapid?.publicKey || null,
        contact: state.vapid?.subject || '',
        subscriptions: state.subscriptions.length,
      };
    },
    configure(contact) {
      const subject = String(contact || '').trim();
      let valid = /^mailto:[^@\s]+@[^@\s]+$/.test(subject);
      try {
        const u = new URL(subject);
        valid ||= u.protocol === 'https:' && !!u.hostname && !u.username && !u.password;
      } catch {
        /* mailto checked above */
      }
      if (!valid || subject.length > 512 || /[\x00-\x20]/.test(subject))
        throw new Error('Set an HTTPS contact URL or mailto: address for this installation');
      return transact((draft) => {
        draft.vapid = { ...(draft.vapid || keys()), subject };
        return { publicKey: draft.vapid.publicKey };
      });
    },
    subscribe(input, repos = []) {
      const subscription = pushSubscription(input);
      if (!Array.isArray(repos) || repos.some((r) => typeof r !== 'string') || repos.length > 100)
        throw new Error('Invalid project filter');
      return transact((draft) => {
        if (!draft.vapid) throw new Error('Configure notifications first');
        const id = hash(subscription.endpoint);
        const existing = draft.subscriptions.find((s) => s.id === id);
        if (!existing && draft.subscriptions.length >= 100) throw new Error('Too many browser subscriptions');
        if (existing) Object.assign(existing, { subscription, repos });
        else draft.subscriptions.push({ id, subscription, repos, seen: {}, failures: 0, nextAttempt: 0 });
        return { id };
      });
    },
    unsubscribe(endpoint) {
      return transact((draft) => {
        draft.subscriptions = draft.subscriptions.filter((s) => s.subscription.endpoint !== endpoint);
        return { ok: true };
      });
    },
    async tick(items) {
      if (ticking || !state.vapid || !state.subscriptions.length) return;
      ticking = true;
      try {
        await transact(async (draft) => {
          for (const sub of [...draft.subscriptions]) {
            if (sub.nextAttempt > now()) continue;
            const relevant = items.filter((i) => !sub.repos.length || sub.repos.includes(i.repo));
            const live = new Set(relevant.map((i) => i.id));
            for (const id of Object.keys(sub.seen)) if (!live.has(id)) delete sub.seen[id];
            for (const group of notificationGroups(relevant, sub.seen).slice(0, 5)) {
              try {
                await send(sub.subscription, JSON.stringify(group.payload), {
                  vapidDetails: draft.vapid,
                  TTL: 3600,
                  timeout: 5000,
                  topic: hash(group.task).slice(0, 32),
                });
                for (const item of group.items) sub.seen[item.id] = revision(item);
                sub.failures = 0;
                sub.nextAttempt = 0;
              } catch (e) {
                if ([404, 410].includes(e.statusCode))
                  draft.subscriptions = draft.subscriptions.filter((s) => s.id !== sub.id);
                else {
                  sub.failures = Math.min(10, sub.failures + 1);
                  sub.nextAttempt = now() + Math.min(3600000, 15000 * 2 ** sub.failures);
                }
                break;
              }
            }
          }
        });
      } finally {
        ticking = false;
      }
    },
  };
}
