// A GitHub-style pull request viewer that can also merge the revision it shows,
// shared by board cards and session PR panels.
window.createPrViewer = ({ api, esc, md, onMerged, onMergeFailed }) => {
  const dialog = document.createElement('dialog');
  dialog.className = 'pr-viewer';
  dialog.setAttribute('aria-labelledby', 'pr-viewer-title');
  dialog.innerHTML = `
    <header class="prv-header">
      <div class="prv-toolbar"><span id="pr-viewer-repo"></span><div>
        <button class="btn" data-refresh>⟳ Refresh</button>
        <button class="btn prv-merge-btn" data-merge hidden>Merge</button>
        <a class="btn" id="pr-viewer-github" target="_blank" rel="noopener">Open in GitHub ↗</a>
        <button class="btn" data-close aria-label="Close pull request">✕</button>
      </div></div>
      <h2><span id="pr-viewer-title">Pull request</span><span id="pr-viewer-checks" class="prv-title-checks" role="img" hidden></span></h2>
      <div id="pr-viewer-meta" class="prv-meta"></div>
      <div id="pr-viewer-merge" class="prv-merge" hidden>
        <div id="prv-merge-warnings" class="prv-merge-warnings"></div>
        <select id="prv-merge-method" aria-label="Merge method"></select>
        <button class="btn prv-merge-btn" data-merge-confirm></button>
        <button class="btn" data-refresh hidden>⟳ Refresh</button>
        <button class="btn" data-merge-cancel>Cancel</button>
        <p id="prv-merge-error" class="prv-merge-warning" role="alert" hidden></p>
      </div>
    </header>
    <div class="prv-tabs" role="tablist" aria-label="Pull request sections">
      <button role="tab" id="prv-tab-description" data-tab="description" aria-controls="prv-content">Description</button>
      <button role="tab" id="prv-tab-files" data-tab="files" aria-controls="prv-content">Files changed</button>
      <button role="tab" id="prv-tab-checks" data-tab="checks" aria-controls="prv-content">Checks</button>
    </div>
    <div id="prv-content" class="prv-content" role="tabpanel" tabindex="0"></div>`;
  document.body.append(dialog);
  const content = dialog.querySelector('#prv-content');
  let state = null;
  let opener = null;
  const safeUrl = (value) => (/^https?:\/\//i.test(String(value || '')) ? esc(value) : '');
  const link = (url, text) =>
    safeUrl(url) ? `<a href="${safeUrl(url)}" target="_blank" rel="noopener">${text} ↗</a>` : '';
  const notice = (text) => `<p class="prv-notice" role="status">${esc(text)}</p>`;
  const STALE = 'This pull request changed. Refresh to load its latest revision.';

  // One icon for every check on the head commit, the way GitHub marks a PR:
  // any completed check that didn't pass (cancelled and stale included) is ✗,
  // anything still running is ●, checks that couldn't all be loaded are ?,
  // otherwise ✓. Until the checks have loaded, CI status is unknown too.
  const PASSED = ['success', 'neutral', 'skipped'];
  const checkFailed = (c) => c.status === 'completed' && !PASSED.includes(c.conclusion);
  function checksRollup() {
    const data = state.checks;
    if (state.pr && !data?.checks) {
      if (data?.stale)
        return {
          tone: 'neutral',
          icon: '?',
          label:
            'This pull request changed since it loaded. Refresh to see the checks on its latest revision',
        };
      if (data?.error)
        return { tone: 'neutral', icon: '?', label: 'Checks could not be loaded, so CI status is unknown' };
      return { tone: 'neutral', icon: '…', label: 'Checks are still loading' };
    }
    if (!data?.checks || (!data.checks.length && !data.warnings.length)) return null;
    const checks = data.checks;
    const failed = checks.filter(checkFailed).length;
    const pending = checks.filter((c) => c.status !== 'completed').length;
    if (failed)
      return { tone: 'removed', icon: '✗', label: `${failed} of ${checks.length} checks did not pass` };
    if (pending)
      return { tone: 'pending', icon: '●', label: `${pending} of ${checks.length} checks still running` };
    if (data.warnings.length)
      return {
        tone: 'neutral',
        icon: '?',
        label: 'Not every check could be loaded, so CI status is unknown',
      };
    return { tone: 'added', icon: '✓', label: `All ${checks.length} checks passed` };
  }

  const METHOD_LABELS = {
    squash: 'Squash and merge',
    merge: 'Create a merge commit',
    rebase: 'Rebase and merge',
  };
  // GitHub's mergeable_state values worth a word before the confirm; dirty
  // is the conflict case, which `mergeable === false` already covers.
  const MERGE_STATE_WARNINGS = {
    blocked: 'GitHub reports this pull request as blocked: a required review or check is missing.',
    behind: 'This branch is behind its base branch and may need updating before it can merge.',
    unstable: 'GitHub reports some checks on this branch as not passing.',
  };
  // The box's controls are built once with the dialog and only updated here,
  // so background loads never take focus or an open dropdown away from them.
  function mergeBox() {
    const pr = state.pr;
    const box = dialog.querySelector('#pr-viewer-merge');
    const button = dialog.querySelector('[data-merge]');
    const hadFocus = box.contains(document.activeElement);
    const open = pr?.state === 'open' && pr.mergeMethods?.length > 0;
    button.hidden = !open || !!state.merge;
    box.hidden = !open || !state.merge;
    // No closing or refreshing while a merge is in flight: its outcome would be lost.
    const toolbarRefresh = dialog.querySelector('.prv-toolbar [data-refresh]');
    for (const b of [toolbarRefresh, dialog.querySelector('[data-close]')]) b.disabled = !!state.merge?.busy;
    if (box.hidden) {
      // Focus left in the hidden box would fall to <body>, where Escape
      // reaches the dashboard's global handlers: keep it in the dialog.
      if (hadFocus) (button.hidden ? toolbarRefresh : button).focus();
      return;
    }
    const m = state.merge;
    const rollup = checksRollup();
    const warnings = [];
    if (pr.mergeable === false)
      warnings.push('This branch has conflicts that must be resolved before it can merge.');
    if (pr.mergeable === null) warnings.push('GitHub is still checking whether this branch can merge.');
    const checksWarning = rollup && rollup.tone !== 'added';
    if (checksWarning) warnings.push(`${rollup.label}.`);
    // unstable only says checks are failing, which a ✗ rollup already told.
    if (
      !(rollup?.tone === 'removed' && pr.mergeableState === 'unstable') &&
      MERGE_STATE_WARNINGS[pr.mergeableState]
    )
      warnings.push(MERGE_STATE_WARNINGS[pr.mergeableState]);
    box.querySelector('#prv-merge-warnings').innerHTML = warnings
      .map((w) => `<p class="prv-merge-warning">${esc(w)}</p>`)
      .join('');
    box.querySelector('#prv-merge-method').disabled = !!m.busy;
    const confirm = box.querySelector('[data-merge-confirm]');
    const confirmFocused = document.activeElement === confirm;
    // After a 409 (the head moved or the PR was retargeted) confirming the
    // same revision again can only fail the same way.
    confirm.hidden = !!m.stale;
    box.querySelector('[data-refresh]').hidden = !m.stale;
    // aria-disabled while merging, so the focused button can keep focus.
    if (m.busy) confirm.setAttribute('aria-disabled', 'true');
    else confirm.removeAttribute('aria-disabled');
    confirm.disabled = !m.busy && pr.mergeable === false;
    confirm.textContent = m.busy ? 'Merging…' : `Confirm merge of ${pr.headSha.slice(0, 7)}`;
    box.querySelector('[data-merge-cancel]').disabled = !!m.busy;
    const error = box.querySelector('#prv-merge-error');
    error.hidden = !m.error;
    error.textContent = m.error || '';
    // Confirm is the one control that can hide or disable under focus.
    if (confirmFocused && (confirm.hidden || confirm.disabled))
      box.querySelector(confirm.hidden ? '[data-refresh]' : '[data-merge-cancel]').focus();
  }

  function header() {
    const pr = state.pr;
    dialog.querySelector('#pr-viewer-repo').textContent = state.repo;
    dialog.querySelector('#pr-viewer-title').textContent = pr
      ? `${pr.title} #${pr.number}`
      : `Pull request #${state.number}`;
    const rollup = checksRollup();
    const badge = dialog.querySelector('#pr-viewer-checks');
    badge.hidden = !rollup;
    badge.className = `prv-title-checks prv-${rollup?.tone || 'neutral'}`;
    badge.textContent = rollup?.icon || '';
    badge.title = rollup?.label || '';
    badge.setAttribute('aria-label', rollup?.label || '');
    mergeBox();
    dialog.querySelector('#pr-viewer-github').href = `https://github.com/${state.repo}/pull/${state.number}`;
    dialog.querySelector('#pr-viewer-meta').innerHTML = pr
      ? `
      <span class="prv-state ${esc(pr.state)}">${esc(pr.state)}</span>
      <span><strong>${esc(pr.author)}</strong> ${pr.state === 'merged' ? 'merged' : 'proposes merging'} <code>${esc(pr.headRef)}</code> into <code>${esc(pr.baseRef)}</code></span>
      <span class="prv-stats"><span class="prv-added">+${pr.additions}</span> <span class="prv-removed">−${pr.deletions}</span></span>`
      : '';
    dialog.querySelector('[data-tab="files"]').textContent =
      `Files changed${pr ? ` (${pr.changedFiles})` : ''}`;
    dialog.querySelector('[data-tab="checks"]').textContent =
      `Checks${state.checks?.checks ? ` (${state.checks.checks.length}${state.checks.warnings.length ? '+' : ''})` : ''}`;
    for (const tab of dialog.querySelectorAll('[data-tab]')) {
      const selected = tab.dataset.tab === state.tab;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    content.setAttribute('aria-labelledby', `prv-tab-${state.tab}`);
  }

  function diffRows(patch) {
    let oldLine = 0;
    let newLine = 0;
    return patch.split('\n').map((line) => {
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        return { kind: 'hunk', text: line };
      }
      if (line.startsWith('\\')) return { kind: 'note', text: line };
      if (line.startsWith('+')) return { kind: 'add', newLine: newLine++, text: line };
      if (line.startsWith('-')) return { kind: 'del', oldLine: oldLine++, text: line };
      return { kind: 'context', oldLine: oldLine++, newLine: newLine++, text: line };
    });
  }

  function hideTemplateComments(text) {
    // Strip HTML comments the way GitHub hides template notes, but leave
    // fenced samples alone so a ``` block that contains <!-- --> still shows it.
    let out = '';
    let buf = '';
    let fence = false;
    const take = (s) => {
      out += fence ? s : s.replace(/<!--[\s\S]*?-->/g, '');
    };
    for (const line of String(text).split('\n')) {
      const piece = (buf || out ? '\n' : '') + line;
      if (/^\s*```/.test(line)) {
        if (fence) {
          take(buf + piece);
          buf = '';
          fence = false;
        } else {
          take(buf);
          buf = piece;
          fence = true;
        }
      } else buf += piece;
    }
    take(buf);
    return out;
  }

  function diffTable(file, full) {
    if (!file.patch)
      return (
        notice('No text diff is available for this file (binary, renamed without edits, or too large).') +
        link(file.url, 'View file on GitHub')
      );
    const all = diffRows(file.patch);
    const partial =
      all.filter((r) => r.kind === 'add').length < file.additions ||
      all.filter((r) => r.kind === 'del').length < file.deletions;
    const warning = partial
      ? notice('GitHub returned only part of this text diff.') +
        link(`${state.pr.url}/files`, 'View complete changes on GitHub')
      : '';
    const rows = full ? all : all.slice(0, 2000);
    const num = (n) => `<td class="prv-num">${n ?? ''}</td>`;
    let body = '';
    if (!state.split) {
      body = rows
        .map(
          (r) =>
            `<tr class="prv-${r.kind}">${num(r.oldLine)}${num(r.newLine)}<td class="prv-code">${esc(r.text)}</td></tr>`,
        )
        .join('');
    } else {
      const side = (r, n) =>
        `${num(r?.[n])}<td class="prv-code prv-${r?.kind || 'empty'}">${esc(r?.text || '')}</td>`;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r.kind === 'hunk' || r.kind === 'note') {
          body += `<tr class="prv-${r.kind}"><td colspan="4" class="prv-code">${esc(r.text)}</td></tr>`;
        } else if (r.kind === 'context') {
          body += `<tr>${side(r, 'oldLine')}${side(r, 'newLine')}</tr>`;
        } else {
          const removed = [],
            added = [];
          while (rows[i]?.kind === 'del') removed.push(rows[i++]);
          while (rows[i]?.kind === 'add') added.push(rows[i++]);
          i--;
          for (let j = 0; j < Math.max(removed.length, added.length); j++)
            body += `<tr>${side(removed[j], 'oldLine')}${side(added[j], 'newLine')}</tr>`;
        }
      }
    }
    return `${warning}<div class="prv-diff-scroll"><table class="prv-diff${state.split ? ' prv-split' : ''}" aria-label="Changes to ${esc(file.filename)}"><tbody>${body}</tbody></table></div>${all.length > rows.length ? '<button class="btn prv-expand" data-full>Show remaining diff lines</button>' : ''}`;
  }

  function fileNavItem(f, i) {
    return `<button data-file="${i}" title="${esc(f.filename)}"><span class="prv-file-status">${esc(f.status)}</span> ${esc(f.filename)}</button>`;
  }

  function fileBlock(f, i) {
    const open = state.expanded[i] ?? i < 5;
    return `<details class="prv-file" id="prv-file-${i}" data-index="${i}"${open ? ' open' : ''}>
        <summary><span class="prv-filename">${esc(f.filename)}</span><span class="prv-file-status">${esc(f.status)}</span><span class="prv-added">+${f.additions}</span><span class="prv-removed">−${f.deletions}</span></summary>
        ${f.previousFilename ? `<div class="prv-rename">Renamed from ${esc(f.previousFilename)}</div>` : ''}
        <div class="prv-diff-body">${open ? diffTable(f, !!state.full[i]) : ''}</div>
      </details>`;
  }

  function filesFooter(data) {
    const retry = data.stale
      ? '<button class="btn prv-more" data-refresh>Refresh</button>'
      : data.nextPage
        ? `<button class="btn prv-more" data-more${data.loading ? ' disabled' : ''}>${data.loading ? 'Loading…' : data.error ? 'Retry loading more files' : 'Load more files'}</button>`
        : '';
    return `${data.error ? notice(data.error) : ''}${retry}`;
  }

  function paintFilesFooter(data) {
    const footer = content.querySelector('#prv-files-footer');
    if (footer) footer.innerHTML = filesFooter(data);
    const count = content.querySelector('#prv-file-count');
    if (count && data.files)
      count.textContent = `${data.files.length} of ${state.pr.changedFiles} files loaded`;
  }

  function appendFileEntries(start, files) {
    const nav = content.querySelector('.prv-file-nav');
    const sentinel = content.querySelector('#prv-no-files');
    if (!nav || !sentinel) return false;
    files.forEach((f, j) => {
      const i = start + j;
      nav.insertAdjacentHTML('beforeend', fileNavItem(f, i));
      sentinel.insertAdjacentHTML('beforebegin', fileBlock(f, i));
    });
    return true;
  }

  function renderFiles() {
    const data = state.files;
    const files = data.files;
    content.innerHTML = `<div class="prv-file-tools">
      <input type="search" id="prv-filter" placeholder="Filter changed files…" aria-label="Filter changed files" value="${esc(state.filter)}">
      <label><input type="checkbox" id="prv-split"${state.split ? ' checked' : ''}> Split diff</label>
      <span id="prv-file-count">${files.length} of ${state.pr.changedFiles} files loaded</span>
    </div>
    ${data.truncated ? notice('GitHub makes only the first 3,000 changed files available here. Open in GitHub for the full PR.') : ''}
    <div class="prv-files-layout">
      <nav class="prv-file-nav" aria-label="Changed files">${files.map((f, i) => fileNavItem(f, i)).join('')}</nav>
      <div class="prv-file-list">${files.map((f, i) => fileBlock(f, i)).join('')}
      <p id="prv-no-files" class="prv-notice" hidden>No matching files.</p>
      </div>
    </div>
    <div id="prv-files-footer">${filesFooter(data)}</div>`;
    filterFiles();
  }

  function filterFiles() {
    const query = state.filter.toLowerCase();
    let visible = 0;
    state.files.files.forEach((f, i) => {
      const match = `${f.filename}\n${f.previousFilename || ''}`.toLowerCase().includes(query);
      content.querySelector(`#prv-file-${i}`).hidden = !match;
      content.querySelector(`[data-file="${i}"]`).hidden = !match;
      if (match) visible++;
    });
    content.querySelector('#prv-no-files').hidden = visible > 0;
  }

  function render() {
    header();
    const data = state[state.tab];
    content.setAttribute('aria-busy', String(!!data?.loading));
    if (!data || (data.loading && !data.files)) {
      content.innerHTML = notice('Loading pull request…');
      return;
    }
    if (data.error && !data.files) {
      const action = data.stale
        ? '<button class="btn" data-refresh>Refresh</button>'
        : '<button class="btn" data-retry>Try again</button>';
      content.innerHTML = `${notice(data.error)}${action}`;
      return;
    }
    if (state.tab === 'description') {
      // Hide template comments outside fences, then use the app's escape-first Markdown renderer.
      const body = hideTemplateComments(state.pr.body);
      content.innerHTML = `<article class="prv-description"><div class="prv-description-author">${esc(state.pr.author)} · Description</div><div class="md prose-chat">${body.trim() ? md(body).replace(/<li>\[([ xX])\] /g, (_, checked) => `<li><input type="checkbox" disabled${checked.toLowerCase() === 'x' ? ' checked' : ''}> `) : '<p class="prv-notice">No description provided.</p>'}</div></article>`;
    } else if (state.tab === 'files') renderFiles();
    else {
      const checks = data.checks;
      // Counted the way the title's rollup counts them, so the two agree.
      const passed = checks.filter((c) => c.status === 'completed' && PASSED.includes(c.conclusion)).length;
      content.innerHTML = `${data.warnings.map(notice).join('')}
        <div class="prv-check-summary">${checks.length ? `${passed} of ${checks.length} checks passed` : data.warnings.length ? 'Checks are unavailable.' : 'No checks have been reported for this commit.'}<span>Commit ${esc(state.pr.headSha.slice(0, 7))}</span></div>
        <div class="prv-checks">${checks
          .map((c) => {
            const pending = c.status !== 'completed';
            const good = c.conclusion === 'success';
            // The rollup's rule, so a ✗ in the title always has a ✗ row here.
            const failed = checkFailed(c);
            const tone = pending ? 'pending' : good ? 'added' : failed ? 'removed' : 'neutral';
            const status = pending ? c.status : c.conclusion || 'unknown';
            const elapsed =
              c.startedAt && c.completedAt
                ? Math.max(0, Math.round((new Date(c.completedAt) - new Date(c.startedAt)) / 1000))
                : null;
            return `<div class="prv-check"><span class="prv-check-icon prv-${tone}">${pending ? '●' : good ? '✓' : failed ? '✗' : '○'}</span><div><strong>${esc(c.name)}</strong><div class="prv-check-note">${esc([c.app, status.replaceAll('_', ' '), elapsed === null ? '' : `${elapsed}s`].filter(Boolean).join(' · '))}</div>${c.description ? `<div class="prv-check-note">${esc(c.description)}</div>` : ''}</div><span class="prv-check-link">${link(c.url, 'Details')}</span></div>`;
          })
          .join('')}</div>`;
    }
  }

  function filesViewOpen() {
    return state?.tab === 'files' && !!content.querySelector('.prv-file-list');
  }

  async function load(section, more = false) {
    const current = state;
    if (!current || current[section]?.loading) return;
    const previous = more ? current.files : null;
    const page = previous?.nextPage || 1;
    current[section] = { ...previous, loading: true, error: undefined, stale: false };
    if (more && filesViewOpen()) {
      paintFilesFooter(current.files);
      content.setAttribute('aria-busy', 'true');
    } else if (current.tab !== section) header();
    else render();
    const params = new URLSearchParams({ repo: current.repo, pr: current.number, section, page });
    // Checks and mergeability belong to the head, so only the diff pins the
    // base: the base branch moving on is routine and must not fail the rest.
    const pinned = !!current.pr;
    if (pinned) {
      params.set('headSha', current.pr.headSha);
      if (section === 'files') params.set('baseSha', current.pr.baseSha);
    }
    let first = false;
    try {
      const data = await api(`/api/pr/view?${params}`);
      if (state !== current) return;
      // A tab clicked before the first read resolved was sent unpinned. If
      // another read set the PR meanwhile, a newer revision must not mix in.
      if (
        !pinned &&
        current.pr &&
        (data.pr.headSha !== current.pr.headSha ||
          (section === 'files' && data.pr.baseSha !== current.pr.baseSha))
      )
        throw new Error(STALE);
      first = !current.pr;
      current.pr ||= data.pr;
      current[section] = { ...data, ...(previous ? { files: [...previous.files, ...data.files] } : {}) };
    } catch (error) {
      if (state !== current) return;
      current[section] = {
        ...previous,
        error: error.message,
        stale: error.message === STALE,
      };
    }
    if (state !== current) return;
    if (state.tab !== section) header();
    else if (more && previous?.files && filesViewOpen()) {
      const next = current.files;
      if (!next.error && next.files.length > previous.files.length)
        appendFileEntries(previous.files.length, next.files.slice(previous.files.length));
      paintFilesFooter(next);
      filterFiles();
      content.setAttribute('aria-busy', 'false');
      header();
    } else render();
    if (!first) return;
    // The title's checks icon needs the checks whichever tab loaded the PR
    // first (on open or on Try again). Load them now, pinned to its head.
    if (!current.checks) load('checks');
    if (current.pr.state === 'open' && current.pr.mergeable === null) recheckMergeable(current);
  }

  // GitHub computes mergeability lazily, so the first read after a push
  // often has mergeable null. Read it once more, pinned to the same head
  // (not the base: a base that moved on is what mergeability is about).
  async function recheckMergeable(current) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (state !== current || current.pr.mergeable !== null) return;
    const params = new URLSearchParams({
      repo: current.repo,
      pr: current.number,
      section: 'description',
      headSha: current.pr.headSha,
    });
    try {
      const { pr } = await api(`/api/pr/view?${params}`);
      if (state !== current) return;
      current.pr.mergeable = pr.mergeable;
      current.pr.mergeableState = pr.mergeableState;
      header();
    } catch {
      // A moved head or a failed read leaves the "still checking" warning up.
    }
  }

  function open(repo, number, tab = 'description') {
    if (!dialog.open) opener = document.activeElement;
    state = { repo, number, tab, pr: null, split: false, filter: '', expanded: {}, full: {} };
    if (!dialog.open) dialog.showModal();
    load(tab);
  }

  async function merge() {
    const current = state;
    const m = current.merge;
    if (!current.pr || m.busy) return;
    m.busy = true;
    m.error = '';
    mergeBox();
    try {
      await api('/api/pr/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: current.repo,
          pr: current.number,
          method: m.method,
          headSha: current.pr.headSha,
          baseRef: current.pr.baseRef,
        }),
      });
      onMerged?.(current.repo, current.number);
      if (state !== current) return;
      open(current.repo, current.number, current.tab);
    } catch (error) {
      // Chromium lets a second Escape close the dialog mid-merge anyway;
      // GitHub's reason must still reach the user.
      if (state !== current) return onMergeFailed?.(current.repo, current.number, error.message);
      m.busy = false;
      m.error = error.message;
      m.stale = error.status === 409;
      mergeBox();
    }
  }

  const merging = () => !!state?.merge?.busy;
  dialog.addEventListener('cancel', (event) => {
    if (merging()) event.preventDefault();
  });
  dialog.addEventListener('close', () => {
    state = null;
    if (opener?.isConnected) opener.focus();
  });
  dialog.addEventListener('keydown', (event) => {
    // Keep the dashboard's global Escape handlers out of this modal.
    event.stopPropagation();
    if (!event.target.matches('[data-tab]')) return;
    const tabs = [...dialog.querySelectorAll('[data-tab]')];
    let index = tabs.indexOf(event.target);
    if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = tabs.length - 1;
    else return;
    event.preventDefault();
    tabs[index].focus();
    tabs[index].click();
  });
  dialog.addEventListener('click', (event) => {
    const target = event.target.closest('button');
    if (!target || !state) return;
    if (target.hasAttribute('data-close')) return merging() || dialog.close();
    if (target.hasAttribute('data-refresh')) return merging() || open(state.repo, state.number, state.tab);
    if (target.hasAttribute('data-merge')) {
      state.merge = { method: state.pr.mergeMethods[0], busy: false, error: '' };
      dialog.querySelector('#prv-merge-method').innerHTML = state.pr.mergeMethods
        .map((k) => `<option value="${k}">${METHOD_LABELS[k]}</option>`)
        .join('');
      mergeBox();
      // The Merge button just hid; keep focus inside the dialog even when a
      // conflict leaves the confirm button disabled.
      const confirm = dialog.querySelector('[data-merge-confirm]');
      return (confirm?.disabled ? dialog.querySelector('[data-merge-cancel]') : confirm)?.focus();
    }
    if (target.hasAttribute('data-merge-cancel')) {
      state.merge = null;
      return mergeBox();
    }
    if (target.hasAttribute('data-merge-confirm')) return merge();
    if (target.dataset.tab) {
      state.tab = target.dataset.tab;
      content.scrollTop = 0;
      if (!state[state.tab]) load(state.tab);
      else render();
    }
    if (target.hasAttribute('data-retry')) load(state.tab);
    if (target.hasAttribute('data-more')) load('files', true);
    if (target.dataset.file !== undefined) {
      const file = content.querySelector(`#prv-file-${target.dataset.file}`);
      file.open = true;
      file.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    if (target.hasAttribute('data-full')) {
      const file = target.closest('[data-index]');
      state.full[file.dataset.index] = true;
      file.querySelector('.prv-diff-body').innerHTML = diffTable(state.files.files[file.dataset.index], true);
    }
  });
  content.addEventListener(
    'toggle',
    (event) => {
      const file = event.target;
      if (!file.matches('.prv-file') || !file.isConnected || !state?.files?.files) return;
      state.expanded[file.dataset.index] = file.open;
      if (!file.open) return;
      const body = file.querySelector('.prv-diff-body');
      if (!body.innerHTML)
        body.innerHTML = diffTable(state.files.files[file.dataset.index], !!state.full[file.dataset.index]);
    },
    true,
  );
  content.addEventListener('input', (event) => {
    if (event.target.id === 'prv-filter') {
      state.filter = event.target.value;
      filterFiles();
    }
  });
  dialog.addEventListener('change', (event) => {
    if (event.target.id === 'prv-merge-method' && state?.merge) state.merge.method = event.target.value;
  });
  content.addEventListener('change', (event) => {
    if (event.target.id === 'prv-split') {
      state.split = event.target.checked;
      for (const file of content.querySelectorAll('.prv-file')) {
        file.querySelector('.prv-diff-body').innerHTML = file.open
          ? diffTable(state.files.files[file.dataset.index], !!state.full[file.dataset.index])
          : '';
      }
    }
  });
  return { open };
};
