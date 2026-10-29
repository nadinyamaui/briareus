// @ts-check
// Run with the new application stopped: older processes can still write retired state.
// Usage totals remain accounting history; review transcripts and workflow data do not.
const RETIRED_ACTIVITIES = new Set([
  'review',
  'code-review',
  'implement-feedback',
  'assess-feedback',
  'custom-feedback',
]);
const RETIRED_KEYS = [
  'reviewLoop',
  'reviewTriage',
  'feedbackAssessment',
  'reviewBranch',
  'reviewPrompt',
  'loopParentId',
  'loopFixParentId',
  'loopReviewDone',
  'loopFixDone',
  'reviewAuthors',
  'reviewRounds',
  'reviewDone',
  'pendingWorkerQuestion',
];
const TEMPLATE_KEYS = ['assessFeedback', 'implementFeedback', 'customFeedback'];

function json(text) {
  if (!text) return null;
  return JSON.parse(text);
}
function retired(meta) {
  return (
    !!meta &&
    (meta.reviewBranch ||
      meta.loopParentId ||
      meta.loopFixParentId ||
      meta.feedbackAssessment ||
      RETIRED_ACTIVITIES.has(meta.activity) ||
      RETIRED_ACTIVITIES.has(meta.orchestratorPrAction))
  );
}
function clean(meta) {
  if (!meta) return meta;
  for (const key of RETIRED_KEYS) delete meta[key];
  for (const key of ['pendingWorkerNotices', 'inFlightWorkerNotices']) {
    if (Array.isArray(meta[key]))
      meta[key] = meta[key].filter(
        (n) =>
          !['triage', 'child-question'].includes(n.kind) &&
          !/review loop|review round|findings|implement feedback/i.test(n.text || ''),
      );
  }
  if (meta.recoveryTurn?.opts) {
    delete meta.recoveryTurn.opts.review;
    delete meta.recoveryTurn.opts.resumeReview;
  }
  return meta;
}

/** @param {{ context: import('mysql2/promise').Pool }} ctx */
export async function up({ context: p }) {
  // Surviving PR actions and QA keep the operator's runtime choices and author filter.
  const renames = {
    auto_review_author: ['pr_author', "VARCHAR(255) NOT NULL DEFAULT ''"],
    auto_review_provider_id: ['action_provider_id', 'INT UNSIGNED NULL'],
    auto_review_model: ['action_model', "VARCHAR(128) NOT NULL DEFAULT ''"],
    auto_review_effort: ['action_effort', "VARCHAR(32) NOT NULL DEFAULT ''"],
    review_test_run: ['qa_test_run', 'TINYINT(1) NOT NULL DEFAULT 0'],
  };
  const [columns] = await p.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'projects'",
  );
  const names = new Set(/** @type {any[]} */ (columns).map((r) => r.COLUMN_NAME));
  for (const [old, [name, type]] of Object.entries(renames)) {
    if (names.has(old)) await p.query(`ALTER TABLE projects CHANGE COLUMN \`${old}\` \`${name}\` ${type}`);
  }
  for (const name of [
    'review_publish_instructions',
    'autonomous_review_loop',
    'feedback_instructions',
    'review_test_sheet',
  ]) {
    if (names.has(name)) await p.query(`ALTER TABLE projects DROP COLUMN \`${name}\``);
  }

  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const removed = new Set();
    for (const table of ['jobs', 'task_sessions']) {
      const [rows] = await conn.query(`SELECT id, meta FROM \`${table}\``);
      for (const row of /** @type {any[]} */ (rows)) {
        const meta = json(row.meta);
        if (retired(meta)) removed.add(row.id);
        else
          await conn.query(`UPDATE \`${table}\` SET meta = ? WHERE id = ?`, [
            JSON.stringify(clean(meta)),
            row.id,
          ]);
      }
    }
    // A snapshot may outlive its job; collect from both before deleting either.
    for (const id of removed) {
      await conn.query('DELETE FROM job_events WHERE job_id = ?', [id]);
      await conn.query('DELETE FROM jobs WHERE id = ?', [id]);
      await conn.query('DELETE FROM task_sessions WHERE id = ?', [id]);
      await conn.query(
        "UPDATE turn_usage SET activity = 'retired-action', session_title = NULL WHERE job_id = ?",
        [id],
      );
    }
    await conn.query(
      "UPDATE turn_usage SET activity = 'retired-action', session_title = NULL WHERE activity IN (?)",
      [[...RETIRED_ACTIVITIES]],
    );
    const [projects] = await conn.query('SELECT id, prompt_templates, step_runtimes FROM projects');
    for (const row of /** @type {any[]} */ (projects)) {
      const templates = json(row.prompt_templates) || {};
      for (const key of TEMPLATE_KEYS) delete templates[key];
      const runtimes = json(row.step_runtimes) || {};
      for (const key of Object.keys(runtimes))
        if (!['testSheet', 'testRun'].includes(key)) delete runtimes[key];
      await conn.query('UPDATE projects SET prompt_templates = ?, step_runtimes = ? WHERE id = ?', [
        JSON.stringify(templates),
        JSON.stringify(runtimes),
        row.id,
      ]);
    }
    await conn.query('DELETE FROM app_settings WHERE name = ?', ['incoming-feedback']);
    const [settings] = await conn.query(
      "SELECT name, value FROM app_settings WHERE name IN ('templates', 'babysitter')",
    );
    for (const row of /** @type {any[]} */ (settings)) {
      const value = json(row.value) || {};
      if (row.name === 'templates') for (const key of TEMPLATE_KEYS) delete value[key];
      else
        for (const entry of Object.values(value)) if (entry && typeof entry === 'object') delete entry.review;
      await conn.query('UPDATE app_settings SET value = ? WHERE name = ?', [JSON.stringify(value), row.name]);
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  await p.query('DROP TABLE IF EXISTS review_findings');
}

export async function down() {
  throw new Error(
    'Code review removal deletes workflow data permanently; restore a database backup and the previous application together to roll back.',
  );
}
