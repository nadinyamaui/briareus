// @ts-check
import { githubStoreConnection } from './db.js';

// Only identifiers defined here enter SQL; values always use placeholders.
async function upsert(c, table, values) {
  const keys = Object.keys(values).filter((key) => values[key] !== undefined);
  await c.query(
    `INSERT INTO ${table} (${keys.map((k) => `\`${k}\``).join(',')})
     VALUES (${keys.map(() => '?').join(',')}) ON DUPLICATE KEY UPDATE
     ${keys.map((k) => `\`${k}\`=VALUES(\`${k}\`)`).join(',')}`,
    keys.map((key) => values[key]),
  );
}

export function createGithubStore({ connection = () => githubStoreConnection() } = {}) {
  async function transaction(fn) {
    const c = await connection();
    try {
      await c.beginTransaction();
      const result = await fn(c);
      await c.commit();
      return result;
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
  }

  async function repository(c, repo) {
    await c.query('INSERT IGNORE INTO github_repositories (repo) VALUES (?)', [repo.toLowerCase()]);
    const [[row]] = await c.query('SELECT * FROM github_repositories WHERE repo = ? FOR UPDATE', [repo]);
    return row;
  }

  async function user(c, login, avatar) {
    if (login) await upsert(c, 'github_users', { login, avatar_url: avatar });
    return login || null;
  }

  async function labels(c, repositoryId, itemId, rows) {
    await c.query('DELETE FROM github_item_labels WHERE item_id = ?', [itemId]);
    for (const label of rows) {
      await upsert(c, 'github_labels', {
        repository_id: repositoryId,
        name: label.name,
        color: label.color || '',
      });
      await c.query(
        `INSERT IGNORE INTO github_item_labels (item_id, label_id)
         SELECT ?, id FROM github_labels WHERE repository_id = ? AND name = ?`,
        [itemId, repositoryId, label.name],
      );
    }
  }

  async function item(c, repositoryId, row, kind, { stub = false } = {}) {
    const [[existing]] = await c.query(
      'SELECT id, updated_at, observed_at FROM github_items WHERE repository_id = ? AND number = ? FOR UPDATE',
      [repositoryId, row.number],
    );
    if (
      !stub &&
      existing &&
      (Number(existing.observed_at) > (row.observedAt || 0) ||
        (row.updatedAt && Date.parse(existing.updated_at) > Date.parse(row.updatedAt)))
    )
      return { id: existing.id, skipped: true };
    let milestone;
    if (row.milestone !== undefined) {
      milestone = null;
      if (row.milestone) {
        await upsert(c, 'github_milestones', { repository_id: repositoryId, title: row.milestone });
        const [[m]] = await c.query(
          'SELECT id FROM github_milestones WHERE repository_id = ? AND title = ?',
          [repositoryId, row.milestone],
        );
        milestone = m.id;
      }
    }
    // References can name a closed item or another repository that has not been
    // synced. A stub supplies link text but must never overwrite a complete item.
    if (stub) {
      await c.query(
        `INSERT IGNORE INTO github_items (repository_id, number, kind, title, url, state)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [repositoryId, row.number, kind, row.title || '', row.url || '', row.state || 'open'],
      );
      if (!existing || Number(existing.observed_at) === 0) {
        const supplied = Object.entries({
          title: row.title,
          url: row.url,
          state: row.state,
          state_reason: row.stateReason,
        }).filter(([, value]) => value !== undefined);
        if (supplied.length)
          await c.query(
            `UPDATE github_items SET ${supplied.map(([key]) => `\`${key}\` = ?`).join(', ')}
          WHERE repository_id = ? AND number = ?`,
            [...supplied.map(([, value]) => value), repositoryId, row.number],
          );
      }
    } else {
      await upsert(c, 'github_items', {
        repository_id: repositoryId,
        number: row.number,
        kind,
        title: row.title,
        url: row.url,
        body: row.body,
        state: row.state,
        state_reason: row.stateReason,
        author_login: row.author === undefined ? undefined : await user(c, row.author, row.authorAvatar),
        milestone_id: milestone,
        comments: row.comments,
        issue_type: row.type,
        sub_issues_total: row.subIssues === undefined ? undefined : row.subIssues?.total || 0,
        sub_issues_completed: row.subIssues === undefined ? undefined : row.subIssues?.completed || 0,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        closed_at: row.closedAt,
        observed_at: row.observedAt,
        source_updated_at: row.sourceUpdatedAt,
        board_visible: row.state === undefined ? undefined : row.state === 'open',
      });
    }
    const [[saved]] = await c.query('SELECT id FROM github_items WHERE repository_id = ? AND number = ?', [
      repositoryId,
      row.number,
    ]);
    const id = saved.id;
    if (kind === 'pull' && !stub) {
      await upsert(c, 'github_pull_requests', {
        item_id: id,
        draft: row.draft,
        head_ref: row.branch,
        base_ref: row.baseBranch,
        head_sha: row.headSha,
        base_sha: row.baseSha,
        cross_repository: row.crossRepository,
        mergeable: row.mergeable,
        checks_state: row.checks,
        review_decision: row.reviewDecision,
        additions: row.additions,
        deletions: row.deletions,
        changed_files: row.changedFiles,
        commits: row.commits,
        merged_at: row.mergedAt,
      });
    }
    if (row.labels !== undefined && (!stub || !existing || Number(existing.observed_at) === 0))
      await labels(c, repositoryId, id, row.labels);
    if (row.assignees !== undefined && !stub) {
      await c.query('DELETE FROM github_item_assignees WHERE item_id = ?', [id]);
      for (const login of row.assignees) {
        await user(c, login);
        await c.query('INSERT IGNORE INTO github_item_assignees (item_id, user_login) VALUES (?, ?)', [
          id,
          login,
        ]);
      }
    }
    if (row.reviewers !== undefined && !stub) {
      await c.query('DELETE FROM github_reviewers WHERE item_id = ?', [id]);
      for (const r of row.reviewers) {
        await user(c, r.user);
        await upsert(c, 'github_reviewers', { item_id: id, user_login: r.user, state: r.state, url: r.url });
      }
    }
    return { id, skipped: false };
  }

  async function links(c, repo, id, relation, rows, kind, observedAt, replace = true) {
    if (replace)
      await c.query('DELETE FROM github_item_links WHERE item_id = ? AND relation = ?', [id, relation]);
    for (const row of rows) {
      const targetRepo = row.repo || repo;
      const r = await repository(c, targetRepo);
      const { id: targetId } = await item(c, r.id, row, kind, { stub: true });
      // An external pull reference can carry its draft flag before its own
      // repository is registered or backfilled.
      if (kind === 'pull' && row.draft !== undefined)
        await c.query(
          `INSERT INTO github_pull_requests (item_id, draft, draft_observed_at)
          SELECT id, ?, ? FROM github_items WHERE id = ? AND observed_at = 0
          ON DUPLICATE KEY UPDATE
          draft = IF(draft_observed_at <= VALUES(draft_observed_at), VALUES(draft), draft),
          draft_observed_at = GREATEST(draft_observed_at, VALUES(draft_observed_at))`,
          [!!row.draft, observedAt || 0, targetId],
        );
      await c.query('INSERT IGNORE INTO github_item_links (item_id, target_id, relation) VALUES (?, ?, ?)', [
        id,
        targetId,
        relation,
      ]);
    }
    if (replace && (relation === 'closes' || relation === 'closed_by'))
      await c.query(
        `DELETE reciprocal FROM github_item_links reciprocal
        LEFT JOIN github_item_links retained
          ON retained.item_id = ? AND retained.target_id = reciprocal.item_id AND retained.relation = ?
        WHERE reciprocal.target_id = ? AND reciprocal.relation = ? AND retained.item_id IS NULL`,
        [id, relation, id, relation === 'closes' ? 'closed_by' : 'closes'],
      );
  }

  async function relations(c, repo, id, row, kind, complete = true) {
    if (row.parent !== undefined)
      await links(c, repo, id, 'parent', row.parent ? [row.parent] : [], 'issue', row.observedAt);
    // Board closing references are bounded projections. Only a complete item
    // refresh may remove historical links; board observations can add links.
    if (kind === 'pull' && row.issues !== undefined)
      await links(c, repo, id, 'closes', row.issues, 'issue', row.observedAt, complete);
    if (kind === 'issue' && row.pulls !== undefined)
      await links(c, repo, id, 'closed_by', row.pulls, 'pull', row.observedAt, complete);
    if (row.subIssueItems !== undefined)
      await links(c, repo, id, 'child', row.subIssueItems, 'issue', row.observedAt);
  }

  async function saveBoard(repo, board) {
    return transaction(async (c) => {
      const r = await repository(c, repo);
      if (Number(r.board_observed_at) > board.observedAt) return;
      // Only a complete successful list can remove rows from a board. Historical
      // records and their actual closed/merged state remain intact.
      await c.query(
        "UPDATE github_items SET board_visible = FALSE WHERE repository_id = ? AND kind = 'pull' AND observed_at <= ?",
        [r.id, board.observedAt],
      );
      if (!board.issuesError && !board.issuesTruncated) {
        await c.query(
          "UPDATE github_items SET board_visible = FALSE WHERE repository_id = ? AND kind = 'issue' AND observed_at <= ?",
          [r.id, board.observedAt],
        );
      }
      for (const [kind, rows] of [
        ['pull', board.pulls],
        ['issue', board.issues],
      ]) {
        for (const row of rows) {
          const { id, skipped } = await item(
            c,
            r.id,
            { ...row, state: 'open', observedAt: board.observedAt },
            kind,
          );
          if (!skipped) await relations(c, repo, id, { ...row, observedAt: board.observedAt }, kind, false);
          else
            await c.query("UPDATE github_items SET board_visible = TRUE WHERE id = ? AND state = 'open'", [
              id,
            ]);
        }
      }
      await c.query(
        `UPDATE github_repositories SET board_synced_at = ?, board_observed_at = ?, default_branch = ?,
        issues_error = ?, issues_truncated = ? WHERE id = ?`,
        [
          Date.parse(board.syncedAt),
          board.observedAt,
          board.defaultBranch || null,
          board.issuesError,
          board.issuesTruncated,
          r.id,
        ],
      );
    });
  }

  async function readBoard(repo) {
    return transaction(async (c) => {
      const [[r]] = await c.query('SELECT * FROM github_repositories WHERE repo = ?', [repo]);
      if (!r?.board_synced_at) return null;
      const [items] = await c.query(
        `SELECT i.*, p.*, i.id AS id, m.title AS milestone
        FROM github_items i LEFT JOIN github_pull_requests p ON p.item_id = i.id
        LEFT JOIN github_milestones m ON m.id = i.milestone_id
        WHERE i.repository_id = ? AND i.board_visible = TRUE ORDER BY i.updated_at DESC, i.number DESC`,
        [r.id],
      );
      const [labelRows] = await c.query(
        `SELECT il.item_id, l.name, l.color FROM github_item_labels il
        JOIN github_labels l ON l.id = il.label_id JOIN github_items i ON i.id = il.item_id
        WHERE i.repository_id = ? AND i.board_visible = TRUE ORDER BY l.name`,
        [r.id],
      );
      const [assignees] = await c.query(
        `SELECT a.* FROM github_item_assignees a JOIN github_items i ON i.id = a.item_id
        WHERE i.repository_id = ? AND i.board_visible = TRUE ORDER BY a.user_login`,
        [r.id],
      );
      const [reviewers] = await c.query(
        `SELECT v.* FROM github_reviewers v JOIN github_items i ON i.id = v.item_id
        WHERE i.repository_id = ? AND i.board_visible = TRUE ORDER BY v.user_login`,
        [r.id],
      );
      const [linked] = await c.query(
        `SELECT l.item_id, l.relation, t.*, r.repo, p.draft
        FROM github_item_links l JOIN github_items i ON i.id = l.item_id
        JOIN github_items t ON t.id = l.target_id JOIN github_repositories r ON r.id = t.repository_id
        LEFT JOIN github_pull_requests p ON p.item_id = t.id WHERE i.repository_id = ? AND i.board_visible = TRUE`,
        [r.id],
      );
      const [linkedLabels] = await c.query(
        `SELECT DISTINCT il.item_id, la.name, la.color FROM github_item_labels il
        JOIN github_labels la ON la.id = il.label_id JOIN github_item_links l ON l.target_id = il.item_id
        JOIN github_items i ON i.id = l.item_id WHERE i.repository_id = ? AND i.board_visible = TRUE`,
        [r.id],
      );
      const labelsById = group(
        [...labelRows, ...linkedLabels],
        'item_id',
        (l) => ({ name: l.name, color: l.color }),
        (l) => l.name,
      );
      const assigneesById = group(assignees, 'item_id', (a) => a.user_login);
      const reviewersById = group(reviewers, 'item_id', (v) => ({
        user: v.user_login,
        state: v.state,
        url: v.url,
      }));
      const linksById = group(linked, 'item_id', (l) => l);
      const pulls = [],
        issues = [];
      for (const i of items) {
        const linkRows = linksById.get(i.id) || [];
        const brief = (l) => ({ number: l.number, title: l.title, url: l.url, repo: l.repo });
        const common = {
          number: i.number,
          title: i.title,
          url: i.url,
          author: i.author_login,
          assignees: assigneesById.get(i.id) || [],
          labels: labelsById.get(i.id) || [],
          updatedAt: i.updated_at,
        };
        if (i.kind === 'pull') {
          pulls.push({
            ...common,
            draft: !!i.draft,
            branch: i.head_ref,
            baseBranch: i.base_ref,
            crossRepository: !!i.cross_repository,
            mergeable: i.mergeable || 'unknown',
            checks: i.checks_state,
            headSha: i.head_sha,
            reviewDecision: i.review_decision,
            reviewers: reviewersById.get(i.id) || [],
            issues: linkRows
              .filter((l) => l.relation === 'closes')
              .map((l) => ({
                ...brief(l),
                state: l.state,
                stateReason: l.state_reason,
                labels: labelsById.get(l.id) || [],
              })),
          });
        } else {
          const parent = linkRows.find((l) => l.relation === 'parent');
          issues.push({
            ...common,
            comments: i.comments,
            milestone: i.milestone,
            createdAt: i.created_at,
            parent: parent ? brief(parent) : null,
            subIssues: i.sub_issues_total
              ? {
                  total: i.sub_issues_total,
                  completed: i.sub_issues_completed,
                  open: i.sub_issues_total - i.sub_issues_completed,
                }
              : null,
            pulls: linkRows
              .filter((l) => l.relation === 'closed_by' && l.state === 'open')
              .map((l) => ({ ...brief(l), draft: !!l.draft })),
          });
        }
      }
      return {
        pulls,
        issues,
        defaultBranch: r.default_branch,
        issuesError: r.issues_error,
        issuesTruncated: !!r.issues_truncated,
        syncedAt: new Date(Number(r.board_synced_at)).toISOString(),
      };
    });
  }

  // Fetch all pages before replacing any collection; a failed page must leave
  // yesterday's complete comments/reviews/commits intact.
  async function saveItem(repo, row, collections = {}) {
    return transaction(async (c) => {
      const r = await repository(c, repo);
      const { id, skipped } = await item(c, r.id, row, row.kind);
      if (skipped) return false;
      await relations(c, repo, id, row, row.kind);
      for (const [kind, rows] of Object.entries(collections)) {
        const table = {
          comments: 'github_comments',
          reviewComments: 'github_comments',
          reviews: 'github_reviews',
          commits: 'github_pull_commits',
          files: 'github_pull_files',
          checks: 'github_checks',
        }[kind];
        if (!table) throw new Error('Unknown GitHub collection');
        const commentKind = kind === 'comments' ? 'issue' : 'review';
        await c.query(
          `DELETE FROM ${table} WHERE item_id = ?${table === 'github_comments' ? ' AND kind = ?' : ''}`,
          table === 'github_comments' ? [id, commentKind] : [id],
        );
        for (const [position, raw] of rows.entries()) {
          const author = await user(c, raw.user?.login, raw.user?.avatar_url);
          if (table === 'github_comments') {
            await upsert(c, table, {
              item_id: id,
              github_id: raw.id,
              kind: commentKind,
              author_login: author,
              body: raw.body || '',
              url: raw.html_url,
              created_at: raw.created_at,
              updated_at: raw.updated_at,
              review_id: raw.pull_request_review_id,
              in_reply_to: raw.in_reply_to_id,
              file_path: raw.path,
              line: raw.line,
              original_line: raw.original_line,
              side: raw.side,
              diff_hunk: raw.diff_hunk,
              commit_sha: raw.commit_id,
            });
          } else if (kind === 'reviews') {
            await upsert(c, table, {
              item_id: id,
              github_id: raw.id,
              author_login: author,
              state: raw.state.toLowerCase(),
              body: raw.body || '',
              url: raw.html_url,
              commit_sha: raw.commit_id,
              submitted_at: raw.submitted_at,
            });
          } else if (kind === 'commits') {
            await upsert(c, 'github_commits', {
              repository_id: r.id,
              sha: raw.sha,
              message: raw.commit?.message || '',
              author_name: raw.author?.login || raw.commit?.author?.name,
              authored_at: raw.commit?.author?.date,
              url: raw.html_url,
            });
            await upsert(c, table, { item_id: id, repository_id: r.id, sha: raw.sha, position });
          } else if (kind === 'files') {
            await upsert(c, table, {
              item_id: id,
              position,
              filename: raw.filename,
              previous_filename: raw.previous_filename,
              status: raw.status,
              additions: raw.additions,
              deletions: raw.deletions,
              patch: raw.patch,
              url: raw.blob_url,
            });
          } else if (kind === 'checks') {
            await upsert(c, table, {
              item_id: id,
              github_id: raw.id,
              kind: raw.context ? 'status' : 'check_run',
              name: raw.context || raw.name,
              status: raw.status || (raw.state === 'pending' ? 'in_progress' : 'completed'),
              conclusion: raw.conclusion ?? (raw.context && raw.state !== 'pending' ? raw.state : null),
              url: raw.target_url || raw.details_url || raw.html_url,
              head_sha: row.headSha,
              started_at: raw.started_at,
              completed_at: raw.completed_at,
              description: raw.description || raw.output?.title,
            });
          }
        }
      }
      return true;
    });
  }

  async function syncState(repo) {
    const c = await connection();
    try {
      const [[row]] = await c.query('SELECT synced_at, last_error FROM github_repositories WHERE repo = ?', [
        repo,
      ]);
      return row || { synced_at: null, last_error: null };
    } finally {
      c.release();
    }
  }

  async function syncedItems(repo) {
    const c = await connection();
    try {
      const [rows] = await c.query(
        `SELECT i.number, i.source_updated_at FROM github_items i
        JOIN github_repositories r ON r.id = i.repository_id WHERE r.repo = ? AND i.source_updated_at IS NOT NULL`,
        [repo],
      );
      return new Map(rows.map((r) => [r.number, r.source_updated_at]));
    } finally {
      c.release();
    }
  }

  async function hideItem(repo, number) {
    await transaction(async (c) => {
      const r = await repository(c, repo);
      await c.query('UPDATE github_items SET board_visible = FALSE WHERE repository_id = ? AND number = ?', [
        r.id,
        number,
      ]);
    });
  }

  async function openPullNumbers(repo, { sha = '', branch = '' } = {}) {
    const c = await connection();
    try {
      const [rows] = await c.query(
        `SELECT i.number FROM github_items i
        JOIN github_repositories r ON r.id = i.repository_id JOIN github_pull_requests p ON p.item_id = i.id
        WHERE r.repo = ? AND i.board_visible = TRUE AND (p.head_sha = ? OR p.head_ref = ?)`,
        [repo, sha, branch],
      );
      return rows.map((r) => r.number);
    } finally {
      c.release();
    }
  }

  // Stable GitHub IDs let renames update historical assignments as well.
  async function saveMetadata(repo, metadata) {
    return transaction(async (c) => {
      const r = await repository(c, repo);
      for (const kind of ['labels', 'milestones']) {
        const rows = metadata[kind];
        const table = `github_${kind}`;
        const nameColumn = kind === 'labels' ? 'name' : 'title';
        for (const raw of rows) {
          const [existing] = await c.query(
            `SELECT id, github_id FROM ${table}
            WHERE repository_id = ? AND (github_id = ? OR ${nameColumn} = ?)`,
            [r.id, raw.id, raw[nameColumn]],
          );
          const canonical = existing.find((e) => Number(e.github_id) === raw.id) || existing[0];
          for (const duplicate of existing.filter((e) => e.id !== canonical.id)) {
            if (kind === 'labels') {
              await c.query(
                `INSERT IGNORE INTO github_item_labels (item_id, label_id)
                SELECT item_id, ? FROM github_item_labels WHERE label_id = ?`,
                [canonical.id, duplicate.id],
              );
            } else
              await c.query('UPDATE github_items SET milestone_id = ? WHERE milestone_id = ?', [
                canonical.id,
                duplicate.id,
              ]);
            await c.query(`DELETE FROM ${table} WHERE id = ?`, [duplicate.id]);
          }
          await upsert(c, table, {
            id: canonical?.id,
            repository_id: r.id,
            github_id: raw.id,
            [nameColumn]: raw[nameColumn],
            description: raw.description,
            ...(kind === 'labels'
              ? { color: raw.color || '' }
              : { number: raw.number, state: raw.state, due_on: raw.due_on, closed_at: raw.closed_at }),
          });
        }
        const ids = rows.map((row) => row.id);
        await c.query(
          `DELETE FROM ${table} WHERE repository_id = ?${
            ids.length ? ` AND (github_id IS NULL OR github_id NOT IN (${ids.map(() => '?').join(',')}))` : ''
          }`,
          [r.id, ...ids],
        );
      }
    });
  }

  async function finishSync(repo, at, error = null) {
    await transaction(async (c) => {
      const r = await repository(c, repo);
      if (error) await c.query('UPDATE github_repositories SET last_error = ? WHERE id = ?', [error, r.id]);
      else
        await c.query('UPDATE github_repositories SET synced_at = ?, last_error = NULL WHERE id = ?', [
          at,
          r.id,
        ]);
    });
  }

  return {
    saveBoard,
    readBoard,
    saveItem,
    syncState,
    syncedItems,
    hideItem,
    openPullNumbers,
    saveMetadata,
    finishSync,
  };
}

function group(rows, key, map, unique = null) {
  const out = new Map();
  for (const row of rows) {
    const list = out.get(row[key]) || [];
    const value = map(row);
    if (!unique || !list.some((v) => unique(v) === unique(value))) list.push(value);
    out.set(row[key], list);
  }
  return out;
}

export const githubStore = createGithubStore();
