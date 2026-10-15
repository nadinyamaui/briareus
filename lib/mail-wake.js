// @ts-check
import crypto from 'node:crypto';
import { Router } from 'express';
import { mailSessionAllowed } from './mail-agent.js';
import { normalizeWebhookSettings, WEBHOOK_DEFAULTS } from './deliveries.js';

// A rule never gains access for its project or turns an email into an operator instruction.
export function mailWakeAllowed(job, project) {
  return (
    !job?.closing && !job?.closePending && mailSessionAllowed({ ...job, unattendedTurn: false }, project)
  );
}

export function normalizeMailWake(input, previous = {}, now = Date.now()) {
  if (!input || !Array.isArray(input.rules) || input.rules.length > 20)
    throw Object.assign(new Error('Pass rules as an array of at most 20 rules'), { status: 400 });
  // Webhooks take 0 as unlimited; email wakes keep a cap, since any sender can trigger them.
  const turns = input.maxTurns;
  if (Object.hasOwn(input, 'maxTurns') && (!Number.isInteger(turns) || turns < 1 || turns > 1000))
    throw new Error('maxTurns must be a whole number from 1 to 1000');
  const limits = normalizeWebhookSettings(input, { ...WEBHOOK_DEFAULTS, ...previous });
  const ids = new Set();
  const rules = input.rules.map((rule) => {
    if (!rule || !Number.isSafeInteger(rule.account) || rule.account < 1)
      throw new Error('Every rule needs a mailbox account id');
    const old = rule.id && previous.rules?.find((r) => r.id === rule.id);
    if (rule.id && !old) throw new Error('Unknown mail wake rule id');
    const id = old?.id || crypto.randomBytes(8).toString('hex');
    if (ids.has(id)) throw new Error('Duplicate mail wake rule id');
    ids.add(id);
    const next = { id, account: rule.account, enabled: rule.enabled ?? true, to: '', from: '', subject: '' };
    if (typeof next.enabled !== 'boolean') throw new Error('Rule enabled must be true or false');
    for (const key of ['to', 'from', 'subject']) {
      if (rule[key] != null && typeof rule[key] !== 'string') throw new Error(`Rule ${key} must be a string`);
      next[key] = (rule[key] || '').trim();
      if (next[key].length > 320) throw new Error(`Rule ${key} is too long`);
      if (key !== 'subject' && next[key] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next[key]))
        throw new Error(`Rule ${key} must be an email address`);
    }
    const unchanged =
      old && ['account', 'enabled', 'to', 'from', 'subject'].every((key) => old[key] === next[key]);
    // Also identifies the rule's revision: edits must invalidate held wakes even before the clock ticks.
    return { ...next, since: unchanged ? old.since : Math.max(now, (old?.since ?? 0) + 1) };
  });
  return { rules, perHour: limits.perHour, maxTurns: limits.maxTurns, seen: previous.seen || [] };
}

export function mailRuleMatches(rule, account, message) {
  const address = (value) => String(value || '').toLowerCase();
  return (
    rule.enabled &&
    rule.account === account.id &&
    message.inInbox &&
    message.receivedAt >= rule.since &&
    address(message.from?.address) !== address(account.email) &&
    (!rule.from || address(message.from?.address) === address(rule.from)) &&
    (!rule.to ||
      [...(message.to || []), ...(message.cc || [])].some((r) => address(r.address) === address(rule.to))) &&
    (!rule.subject ||
      String(message.subject || '')
        .toLowerCase()
        .includes(rule.subject.toLowerCase()))
  );
}

export function mailWakeView(wake = {}) {
  return {
    rules: wake.rules || [],
    perHour: wake.perHour ?? WEBHOOK_DEFAULTS.perHour,
    maxTurns: wake.maxTurns ?? WEBHOOK_DEFAULTS.maxTurns,
  };
}

export function sessionMailWakeRoutes({ state, update, service }) {
  const router = Router();
  router.use('/api/dev/sessions/:id/mail-wake', (req, res, next) => {
    if (req.headers.authorization) return res.status(403).json({ error: 'Use /api/v1 with an admin token' });
    res.set('Cache-Control', 'no-store');
    next();
  });
  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      res.status(e.status || (e.message === 'Session not found' ? 404 : 400)).json({ error: e.message });
    }
  };
  router.get(
    '/api/dev/sessions/:id/mail-wake',
    handle((req) => state(req.params.id)),
  );
  router.put(
    '/api/dev/sessions/:id/mail-wake',
    handle(async (req) => {
      await validateWakeAccounts(service, req.body);
      return update(req.params.id, req.body);
    }),
  );
  return router;
}

export async function validateWakeAccounts(service, input) {
  if (!Array.isArray(input?.rules)) throw Object.assign(new Error('Pass rules as an array'), { status: 400 });
  const accounts = await service.list();
  for (const rule of input.rules)
    if (
      rule?.enabled !== false &&
      !accounts.some((a) => a.id === rule?.account && a.enabled && a.status === 'connected')
    )
      throw Object.assign(new Error('Choose a connected, enabled mailbox'), { status: 400 });
}
