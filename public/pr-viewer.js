// A read-only GitHub-style viewer, shared by board cards and session PR panels.
window.createPrViewer = ({ api, esc, md }) => {
  const dialog = document.createElement('dialog');
  dialog.className = 'pr-viewer';
  dialog.setAttribute('aria-labelledby', 'pr-viewer-title');
  dialog.innerHTML = `
    <header class="prv-header">
      <div class="prv-toolbar"><span id="pr-viewer-repo"></span><div>
        <button class="btn" data-refresh>⟳ Refresh</button>
        <a class="btn" id="pr-viewer-github" target="_blank" rel="noopener">Open in GitHub ↗</a>
        <button class="btn" data-close aria-label="Close pull request">✕</button>
      </div></div>
      <h2 id="pr-viewer-title">Pull request</h2>
      <div id="pr-viewer-meta" class="prv-meta"></div>
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

  function header() {
    const pr = state.pr;
    dialog.querySelector('#pr-viewer-repo').textContent = state.repo;
    dialog.querySelector('#pr-viewer-title').textContent = pr
      ? `${pr.title} #${pr.number}`
      : `Pull request #${state.number}`;
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

  function renderFiles() {
    const data = state.files;
    const files = data.files;
    content.innerHTML = `<div class="prv-file-tools">
      <input type="search" id="prv-filter" placeholder="Filter changed files…" aria-label="Filter changed files" value="${esc(state.filter)}">
      <label><input type="checkbox" id="prv-split"${state.split ? ' checked' : ''}> Split diff</label>
      <span>${files.length} of ${state.pr.changedFiles} files loaded</span>
    </div>
    ${data.truncated ? notice('GitHub makes only the first 3,000 changed files available here. Open in GitHub for the full PR.') : ''}
    <div class="prv-files-layout">
      <nav class="prv-file-nav" aria-label="Changed files">${files.map((f, i) => `<button data-file="${i}" title="${esc(f.filename)}"><span class="prv-file-status">${esc(f.status)}</span> ${esc(f.filename)}</button>`).join('')}</nav>
      <div class="prv-file-list">${files
        .map(
          (
            f,
            i,
          ) => `<details class="prv-file" id="prv-file-${i}" data-index="${i}"${(state.expanded[i] ?? i < 5) ? ' open' : ''}>
        <summary><span class="prv-filename">${esc(f.filename)}</span><span class="prv-file-status">${esc(f.status)}</span><span class="prv-added">+${f.additions}</span><span class="prv-removed">−${f.deletions}</span></summary>
        ${f.previousFilename ? `<div class="prv-rename">Renamed from ${esc(f.previousFilename)}</div>` : ''}
        <div class="prv-diff-body">${(state.expanded[i] ?? i < 5) ? diffTable(f, false) : ''}</div>
      </details>`,
        )
        .join('')}
      <p id="prv-no-files" class="prv-notice" hidden>No matching files.</p>
      </div>
    </div>
    ${data.error ? notice(data.error) : ''}
    ${data.nextPage ? `<button class="btn prv-more" data-more${data.loading ? ' disabled' : ''}>${data.loading ? 'Loading…' : data.error ? 'Retry loading more files' : 'Load more files'}</button>` : ''}`;
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
      content.innerHTML = `${notice(data.error)}<button class="btn" data-retry>Try again</button>`;
      return;
    }
    if (state.tab === 'description') {
      // Hide template comments, then use the app's escape-first Markdown renderer.
      const body = state.pr.body.replace(/<!--[\s\S]*?-->/g, '');
      content.innerHTML = `<article class="prv-description"><div class="prv-description-author">${esc(state.pr.author)} · Description</div><div class="md prose-chat">${body.trim() ? md(body).replace(/<li>\[([ xX])\] /g, (_, checked) => `<li><input type="checkbox" disabled${checked.toLowerCase() === 'x' ? ' checked' : ''}> `) : '<p class="prv-notice">No description provided.</p>'}</div></article>`;
    } else if (state.tab === 'files') renderFiles();
    else {
      const checks = data.checks;
      const passed = checks.filter((c) => c.conclusion === 'success').length;
      content.innerHTML = `${data.warnings.map(notice).join('')}
        <div class="prv-check-summary">${checks.length ? `${passed} of ${checks.length} checks passed` : data.warnings.length ? 'Checks are unavailable.' : 'No checks have been reported for this commit.'}<span>Commit ${esc(state.pr.headSha.slice(0, 7))}</span></div>
        <div class="prv-checks">${checks
          .map((c) => {
            const pending = c.status !== 'completed';
            const good = c.conclusion === 'success';
            const neutral = ['neutral', 'skipped'].includes(c.conclusion);
            const tone = pending ? 'pending' : good ? 'added' : neutral ? 'neutral' : 'removed';
            const status = pending ? c.status : c.conclusion || 'unknown';
            const elapsed =
              c.startedAt && c.completedAt
                ? Math.max(0, Math.round((new Date(c.completedAt) - new Date(c.startedAt)) / 1000))
                : null;
            return `<div class="prv-check"><span class="prv-check-icon prv-${tone}">${pending ? '●' : good ? '✓' : neutral ? '○' : '✗'}</span><div><strong>${esc(c.name)}</strong><div class="prv-check-note">${esc([c.app, status.replaceAll('_', ' '), elapsed === null ? '' : `${elapsed}s`].filter(Boolean).join(' · '))}</div>${c.description ? `<div class="prv-check-note">${esc(c.description)}</div>` : ''}</div><span class="prv-check-link">${link(c.url, 'Details')}</span></div>`;
          })
          .join('')}</div>`;
    }
  }

  async function load(section, more = false) {
    const current = state;
    if (!current || current[section]?.loading) return;
    const previous = more ? current.files : null;
    const page = previous?.nextPage || 1;
    current[section] = { ...previous, loading: true };
    render();
    const params = new URLSearchParams({ repo: current.repo, pr: current.number, section, page });
    if (current.pr) {
      params.set('headSha', current.pr.headSha);
      params.set('baseSha', current.pr.baseSha);
    }
    try {
      const data = await api(`/api/pr/view?${params}`);
      if (state !== current) return;
      if (current.pr && (current.pr.headSha !== data.pr.headSha || current.pr.baseSha !== data.pr.baseSha))
        throw new Error('This pull request changed. Refresh to load its latest revision.');
      current.pr ||= data.pr;
      current[section] = { ...data, ...(previous ? { files: [...previous.files, ...data.files] } : {}) };
    } catch (error) {
      if (state !== current) return;
      current[section] = { ...previous, error: error.message };
    }
    if (state === current) {
      if (state.tab === section) render();
      else header();
    }
  }

  function open(repo, number, tab = 'description') {
    if (!dialog.open) opener = document.activeElement;
    state = { repo, number, tab, pr: null, split: false, filter: '', expanded: {} };
    if (!dialog.open) dialog.showModal();
    load(tab);
  }

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
    if (target.hasAttribute('data-close')) return dialog.close();
    if (target.hasAttribute('data-refresh')) return open(state.repo, state.number, state.tab);
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
      if (!body.innerHTML) body.innerHTML = diffTable(state.files.files[file.dataset.index], false);
    },
    true,
  );
  content.addEventListener('input', (event) => {
    if (event.target.id === 'prv-filter') {
      state.filter = event.target.value;
      filterFiles();
    }
  });
  content.addEventListener('change', (event) => {
    if (event.target.id === 'prv-split') {
      state.split = event.target.checked;
      for (const file of content.querySelectorAll('.prv-file')) {
        file.querySelector('.prv-diff-body').innerHTML = file.open
          ? diffTable(state.files.files[file.dataset.index], false)
          : '';
      }
    }
  });
  return { open };
};
