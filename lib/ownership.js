// @ts-check
// Whose sessions a user sees. Its own module because the gateway (lib/api-v1.js), the
// handlers in server.js and the stats routes all need the one rule.
//
// A session belongs to the user who started it (lib/jobs.js createDevSession); a loop's
// review, QA and fix and an orchestrator's workers belong to whoever owns the session
// they were started for. An admin sees every session. A member sees their own, and the
// ones nobody started (the babysitter's errands) on projects shared with them; the
// project half is the gateway's, which holds a member's token to those projects.

/**
 * @param {{ id: number, role: string } | null | undefined} user
 * @param {{ ownerId?: number | null } | null | undefined} job
 */
export function seesSession(user, job) {
  if (!user || !job) return false;
  if (user.role === 'admin') return true;
  return job.ownerId == null || job.ownerId === user.id;
}
