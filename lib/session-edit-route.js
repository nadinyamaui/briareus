// @ts-check

// PATCH /api/dev/sessions/:id: session metadata edits, which do not wake the
// agent. They only change how the conversation is filed in the dashboard, or
// what happens after its turns. lib/jobs.js does each edit; this picks which.
export function sessionEditRoute({
  renameDevSession,
  setDevSessionAutoCompact,
  setDevSessionCompactInstructions,
}) {
  return (req, res) => {
    try {
      const body = req.body || {};
      // One edit per request: a body mixing them would otherwise have all but
      // one quietly dropped, and applying each would leave half of it saved
      // when a later one is refused.
      const fields = ['title', 'autoCompact', 'compactInstructions'].filter((f) => f in body);
      if (fields.length > 1) {
        return res.status(400).json({ error: `Send one of ${fields.join(', ')} per request` });
      }
      if ('autoCompact' in body) {
        return res.json({ session: setDevSessionAutoCompact(req.params.id, body.autoCompact) });
      }
      if ('compactInstructions' in body) {
        return res.json({
          session: setDevSessionCompactInstructions(req.params.id, body.compactInstructions),
        });
      }
      res.json({ session: renameDevSession(req.params.id, body.title) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  };
}
