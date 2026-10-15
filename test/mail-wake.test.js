import { describe, it, expect } from 'vitest';
import { normalizeMailWake, mailRuleMatches, mailWakeView, mailWakeAllowed } from '../lib/mail-wake.js';

const account = { id: 7, email: 'me@example.com' };
const message = {
  id: 'm',
  inInbox: true,
  receivedAt: 101,
  from: { address: 'sender@example.com' },
  to: [{ address: 'alerts@example.com' }],
  cc: [],
  subject: 'Urgent outage',
};
const rule = normalizeMailWake(
  { rules: [{ account: 7, from: 'Sender@Example.com', to: 'alerts@example.com', subject: 'OUTAGE' }] },
  {},
  100,
).rules[0];

describe('email wake rules', () => {
  it('combines filters, matches cc and ignores old, outgoing or other mailboxes', () => {
    expect(mailRuleMatches(rule, account, message)).toBe(true);
    expect(mailRuleMatches(rule, account, { ...message, to: [], cc: message.to })).toBe(true);
    for (const change of [
      { inInbox: false },
      { receivedAt: 99 },
      { to: [] },
      { subject: 'newsletter' },
      { from: { address: 'other@example.com' } },
      { from: { address: account.email } },
    ])
      expect(mailRuleMatches(rule, account, { ...message, ...change })).toBe(false);
    expect(mailRuleMatches(rule, { ...account, id: 8 }, message)).toBe(false);
    expect(mailRuleMatches({ ...rule, enabled: false }, account, message)).toBe(false);
  });
  it('preserves activation times only for unchanged rules and excludes private bookkeeping from responses', () => {
    const previous = { rules: [rule], seen: ['m'], perHour: 2, maxTurns: 3 };
    const next = normalizeMailWake({ rules: [rule] }, previous, 200);
    expect(next.rules[0].since).toBe(100);
    expect(normalizeMailWake({ rules: [{ ...rule, subject: 'new' }] }, previous, 200).rules[0].since).toBe(
      200,
    );
    expect(mailWakeView(next)).toEqual({ rules: [rule], perHour: 2, maxTurns: 3 });
    expect(normalizeMailWake({ rules: [] }, previous).rules).toEqual([]);
  });
  it('advances edited rules even when the clock has not ticked or moves backwards', () => {
    const first = normalizeMailWake({ rules: [{ account: 7 }] }, {}, 100);
    const edited = normalizeMailWake({ rules: [{ ...first.rules[0], subject: 'new' }] }, first, 100);
    expect(edited.rules[0].since).toBe(101);
    const again = normalizeMailWake({ rules: [{ ...edited.rules[0], subject: 'other' }] }, edited, 99);
    expect(again.rules[0].since).toBe(102);
    expect(normalizeMailWake({ rules: again.rules }, again, 99).rules[0].since).toBe(102);
  });
  it.each([
    {},
    { rules: [null] },
    { rules: [{ account: '7' }] },
    { rules: [{ account: 7, from: '*' }] },
    { rules: [{ account: 7, enabled: 'true' }] },
    { rules: [{ ...rule, id: 'fake' }] },
    { rules: Array(21).fill({ account: 7 }) },
    { rules: [], maxTurns: 0 },
  ])('rejects invalid settings %j', (input) => {
    expect(() => normalizeMailWake(input)).toThrow();
  });
  it.each([0, -1, 1001, 1.5, '5'])('states the 1–1000 range for maxTurns %j', (maxTurns) => {
    expect(() => normalizeMailWake({ rules: [], maxTurns })).toThrow(
      'maxTurns must be a whole number from 1 to 1000',
    );
  });
  it('allows receiving while busy but never bypasses project opt-in or revives closed sessions', () => {
    const job = { kind: 'devchat', repo: 'a/b', status: 'running', unattendedTurn: true };
    const project = { enabled: true, mailToolsEnabled: true };
    expect(mailWakeAllowed(job, project)).toBe(true);
    expect(mailWakeAllowed(job, { ...project, mailToolsEnabled: false })).toBe(false);
    expect(mailWakeAllowed({ ...job, status: 'closed' }, project)).toBe(false);
    expect(mailWakeAllowed({ ...job, closing: true }, project)).toBe(false);
    expect(mailWakeAllowed({ ...job, closePending: true }, project)).toBe(false);
    expect(mailWakeAllowed({ ...job, parentId: 'parent' }, project)).toBe(false);
  });
});
