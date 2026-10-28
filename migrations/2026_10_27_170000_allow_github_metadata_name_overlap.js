// @ts-check
const indexes = [
  ['github_labels', 'label_name', 'name'],
  ['github_milestones', 'milestone_title', 'title'],
];

async function setUnique(p, unique) {
  for (const [table, index, column] of indexes) {
    const [[current]] = await p.query(
      `SELECT NON_UNIQUE FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
      [table, index],
    );
    if (current && !!current.NON_UNIQUE !== !unique)
      await p.query(
        `ALTER TABLE ${table} DROP INDEX ${index}, ADD ${unique ? 'UNIQUE ' : ''}INDEX ${index} (repository_id, ${column})`,
      );
  }
}

export async function up({ context: p }) {
  // Item and metadata downloads observe renames independently. Stable GitHub
  // IDs remain unique; names can overlap until an authoritative sweep finishes.
  await setUnique(p, false);
}

export async function down({ context: p }) {
  // Refuse rollback while names overlap rather than discard stable assignments.
  // A successful metadata sweep restores the source's unique names first.
  for (const [table, , column] of indexes) {
    const [duplicates] = await p.query(
      `SELECT 1 FROM ${table} GROUP BY repository_id, ${column} HAVING COUNT(*) > 1 LIMIT 1`,
    );
    if (duplicates.length) throw new Error('Reconcile GitHub metadata before restoring unique names');
  }
  await setUnique(p, true);
}
