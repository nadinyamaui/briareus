// Developer mode: a chat over dev sessions. Each session is a conversation
// with one coding agent (claude / codex / grok / opencode) inside its own project clone;
// this page only renders the event stream and posts messages.
(() => {
  const $ = (id) => document.getElementById(id);
  const listEl = $('session-list');
  const messagesEl = $('messages');
  const scrollEl = $('chat-scroll');
  const inputEl = $('input');
  const selWorkspace = $('sel-workspace');
  const selProject = $('sel-project');
  const selProvider = $('sel-provider');
  const selModel = $('sel-model');
  const selEffort = $('sel-effort');

  let zeusDraft = null;
  let providers = [];
  let projects = []; // [{ repo, label }], the enabled ones, from settings
  let sessions = [];
  let current = null; // session id being viewed (null = new-session view)
  let currentProject = null; // repo whose dashboard is open, if any
  let es = null; // EventSource for the open session
  let lastSeq = 0;
  let prepBox = null; // open <details> the prep log lines append into
  let toolBox = null; // open <details> the current run of tool calls appends into

  // ---------- helpers ----------

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Message timestamps: time alone for today, day + time otherwise.
  function fmtWhen(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString()
      ? time
      : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
  }

  // The line under a message carrying when it was sent. Short form in the
  // conversation, the full date on hover.
  function stamp(iso, extra = '') {
    const when = document.createElement('div');
    when.className = 'mt-1.5 text-[11px] text-muted' + extra;
    when.textContent = fmtWhen(iso);
    when.title = new Date(iso).toLocaleString();
    return when;
  }

  // Inline spans: code, links, bold, italic, strikethrough. Code is pulled out
  // first so a `*` or `_` inside a code span stays literal, and everything is
  // escaped before any tag is inserted.
  function inline(text) {
    const codes = [];
    let s = String(text ?? '').replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
    s = esc(s)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
      .replace(/(?<![*\w])\*(?=\S)([^*]*\S)\*(?!\*)/g, '<em>$1</em>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${esc(codes[n])}</code>`);
  }

  // The row of dashes under a pipe-table header: |---|:--:|
  const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const cells = (line) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());

  // Minimal, escape-first markdown renderer (same one the review board uses):
  // headings, fenced code, blockquotes, rules, pipe tables, and nestable
  // bullet / numbered lists.
  function md(text) {
    const lines = String(text ?? '')
      .replace(/\r\n?/g, '\n')
      .split('\n');
    let out = '';
    const stack = []; // open lists, innermost last; each has an open <li>
    const closeTo = (indent) => {
      while (stack.length && stack[stack.length - 1].indent > indent) out += `</li></${stack.pop().tag}>`;
    };
    const closeAll = () => closeTo(-1);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/^\s*```/.test(line)) {
        closeAll();
        const body = [];
        while (++i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i]);
        out += `<pre>${esc(body.join('\n'))}</pre>`;
        continue;
      }

      if (line.includes('|') && TABLE_RULE.test(lines[i + 1] || '')) {
        closeAll();
        const head = cells(line);
        i++; // the rule row
        const rows = [];
        while (i + 1 < lines.length && lines[i + 1].includes('|')) rows.push(cells(lines[++i]));
        out +=
          '<div class="tbl"><table><thead><tr>' +
          head.map((c) => `<th>${inline(c)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table></div>';
        continue;
      }

      if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        closeAll();
        out += '<hr>';
        continue;
      }

      const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
      if (h) {
        closeAll();
        const lvl = Math.min(h[1].length + 1, 4);
        out += `<h${lvl}>${inline(h[2].replace(/\s*#+\s*$/, ''))}</h${lvl}>`;
        continue;
      }

      const q = line.match(/^\s{0,3}>\s?(.*)$/);
      if (q) {
        closeAll();
        out += `<blockquote>${inline(q[1])}</blockquote>`;
        continue;
      }

      const li = line.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/);
      if (li) {
        const indent = li[1].replace(/\t/g, '    ').length;
        const num = parseInt(li[2], 10);
        const tag = Number.isNaN(num) ? 'ul' : 'ol';
        closeTo(indent);
        const top = stack[stack.length - 1];
        const open = () => {
          out += tag === 'ol' && num !== 1 ? `<ol start="${num}">` : `<${tag}>`;
          stack.push({ tag, indent });
        };
        if (!top || indent > top.indent) open();
        else if (top.tag !== tag) {
          out += `</li></${stack.pop().tag}>`;
          open();
        } else out += '</li>';
        out += `<li>${inline(li[3])}`;
        continue;
      }

      // A blank line does not end a list: agents write loose lists, and
      // closing here would restart the numbering on the next item.
      if (line.trim() === '') continue;

      // An indented line under an open item continues that item's text.
      if (stack.length && /^\s{2,}\S/.test(line)) {
        out += ` ${inline(line.trim())}`;
        continue;
      }

      closeAll();
      out += `<p>${inline(line)}</p>`;
    }
    closeAll();
    return out;
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('border-danger', !!isErr);
    t.classList.toggle('text-danger', !!isErr);
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
  }

  // ---------- confirm modal ----------

  // Replaces window.confirm: same call shape (await a boolean), but rendered in
  // the app's own chrome. Esc / backdrop / Cancel resolve false, Enter confirms.
  // `form` is markup for controls the question carries; it is in the DOM the
  // moment this returns, so the caller wires it up and reads it after the
  // answer (the next question replaces it).
  let modalResolve = null;
  function openConfirm({ title, body, confirmLabel = 'Confirm', danger = false, icon = '?', form = '' }) {
    closeConfirm(false); // a second question supersedes an unanswered one
    const modal = $('modal');
    const btnOk = $('modal-confirm');
    $('modal-title').textContent = title;
    $('modal-body').textContent = body;
    $('modal-form').innerHTML = form;
    $('modal-form').classList.toggle('hidden', !form);
    $('modal-icon').textContent = icon;
    $('modal-icon').className =
      'flex size-9 shrink-0 items-center justify-center rounded-full text-base ' +
      (danger ? 'bg-danger/15 text-danger' : 'bg-accent/15 text-accent');
    btnOk.textContent = confirmLabel;
    btnOk.className =
      'btn px-3 py-1.5 text-[14px] ' +
      (danger ? 'border-danger bg-danger/15 text-danger hover:bg-danger/25' : 'btn-primary');

    // Re-run the entry animation on every open. A question with controls
    // takes a wider panel, so a row of three pickers sits on one line.
    const panel = $('modal-panel');
    panel.classList.toggle('max-w-[440px]', !form);
    panel.classList.toggle('max-w-[560px]', !!form);
    panel.classList.remove('animate-modal-in');
    void panel.offsetWidth;
    panel.classList.add('animate-modal-in');

    modal.classList.remove('hidden');
    btnOk.focus();
    return new Promise((resolve) => {
      modalResolve = resolve;
    });
  }

  function closeConfirm(answer) {
    if (!modalResolve) return;
    $('modal').classList.add('hidden');
    const resolve = modalResolve;
    modalResolve = null;
    resolve(answer);
    inputEl.focus();
  }

  $('modal-confirm').addEventListener('click', () => closeConfirm(true));
  $('modal-cancel').addEventListener('click', () => closeConfirm(false));
  $('modal-backdrop').addEventListener('click', () => closeConfirm(false));
  document.addEventListener('keydown', (e) => {
    if (!modalResolve) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeConfirm(false);
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      closeConfirm(true);
    }
    // Keep focus inside the dialog while it is open: its controls, when the
    // question carries some, then the two buttons.
    if (e.key === 'Tab') {
      const stops = [...$('modal-panel').querySelectorAll('select, button')].filter((el) => !el.disabled);
      const next =
        stops[(stops.indexOf(document.activeElement) + (e.shiftKey ? stops.length - 1 : 1)) % stops.length];
      e.preventDefault();
      next.focus();
    }
  });

  // ---------- ask modal ----------

  // Replaces window.prompt: await a string, or null if the user backed out.
  // Used both for actions that need prose and the small session metadata edits
  // that should not be sent to the agent as a chat message.
  let askResolve = null;
  function openPrompt({
    title,
    body = '',
    label = '',
    placeholder = '',
    confirmLabel = 'Start',
    value = '',
    rows = 6,
  }) {
    closeAsk(null); // a second question supersedes an unanswered one
    $('ask-title').textContent = title;
    $('ask-body').textContent = body;
    $('ask-body').classList.toggle('hidden', !body);
    $('ask-label').textContent = label;
    $('ask-confirm').textContent = confirmLabel;
    const input = $('ask-input');
    input.value = value;
    input.placeholder = placeholder;
    input.rows = rows;

    const form = $('ask-form');
    form.classList.remove('animate-modal-in');
    void form.offsetWidth; // re-run the entry animation on every open
    form.classList.add('animate-modal-in');
    $('ask-modal').classList.remove('hidden');
    input.focus();
    return new Promise((resolve) => {
      askResolve = resolve;
    });
  }

  function closeAsk(answer) {
    if (!askResolve) return;
    $('ask-modal').classList.add('hidden');
    const resolve = askResolve;
    askResolve = null;
    resolve(answer);
  }

  $('ask-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('ask-input').value.trim();
    if (!text) return $('ask-input').focus(); // an empty answer is not an answer
    closeAsk(text);
  });
  $('ask-cancel').addEventListener('click', () => closeAsk(null));
  $('ask-backdrop').addEventListener('click', () => closeAsk(null));
  $('ask-input').addEventListener('keydown', (e) => {
    // Enter belongs to the textarea; it is prose. Ctrl/⌘+Enter submits.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      $('ask-form').requestSubmit();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (askResolve && e.key === 'Escape') {
      e.preventDefault();
      closeAsk(null);
    }
  });

  async function api(url, opts) {
    const res = await fetch(url, opts);
    // The session cookie expired (or the login was switched on while this page
    // was open): send the reader to sign in rather than showing them an error
    // for every poll from here on.
    if (res.status === 401) {
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
      throw new Error('Signed out');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  }

  // ---------- ⚡ actions ----------
  //
  // The errands this app has a prompt of its own for (lib/actions.js). They are
  // run from the buttons on a pull request's row in the project board; this
  // list is what tells that click handler which of them ask a question first.

  let actions = [];

  async function loadActions() {
    const data = await api('/api/dev/actions');
    actions = data.actions || [];
  }

  // ---------- providers / composer ----------

  // Provider ids are database row ids (numbers), but <select> values are
  // strings, so compare loosely.
  function providerById(id) {
    return providers.find((p) => String(p.id) === String(id)) || null;
  }

  // A session started before its project was renamed (or deleted) still has
  // to render, so fall back to the repo name.
  function projectLabel(repo) {
    const project = projects.find((p) => p.repo === repo);
    return project ? project.label : String(repo || '').split('/')[1] || repo || '';
  }

  // A new session starts on the project you are already in, so opening the
  // composer from a project's board (or with its sessions in the sidebar)
  // points the chip at it rather than at whichever project sorts first. A repo
  // no new session can pick (deleted from Settings) leaves the chip alone.
  function selectProject(repo) {
    if (repo && [...selProject.options].some((o) => o.value === repo)) selProject.value = repo;
    else if (!selProject.value && selProject.options.length) selProject.selectedIndex = 0;
  }

  function fillModelControls() {
    const p = providerById(selProvider.value);
    if (!p) return;
    selModel.innerHTML = p.models
      .map((m) => `<option${m === p.defaultModel ? ' selected' : ''}>${esc(m)}</option>`)
      .join('');
    selEffort.innerHTML = p.efforts
      .map((e) => `<option${e === p.defaultEffort ? ' selected' : ''}>${esc(e)}</option>`)
      .join('');
  }

  // Projects load separately from providers: the provider probes can sit on a
  // dead gateway for many seconds, and the branch picker must not wait behind
  // them.
  async function loadProjects() {
    const data = await api('/api/dev/projects');
    projects = data.projects || [];
    renderSidebar(); // the group headers are the only way to reach a dashboard
    selProject.innerHTML = projects
      .map((p) => `<option value="${esc(p.repo)}">${esc(p.label)}</option>`)
      .join('');
    // Rebuilding the options dropped the pick, so the project the page came up
    // in, restored from localStorage before this landed, takes it back.
    selectProject(currentProject || sidebarRepo);
    // With no projects there is nothing to start a session against, so say so
    // where the project name would have been.
    document.querySelector('.wl-repo').textContent = projects.length
      ? projectLabel(selProject.value)
      : 'project (add one in Settings)';
    // Same as the providers load: an open session owns the chips.
    const open = currentSession();
    if (open) {
      reflectSession(open);
    } else {
      loadBranches(selProject.value);
      syncWorkspaceModes();
    }
  }

  async function loadProviders() {
    const data = await api('/api/dev/providers');
    providers = data.providers;
    selProvider.innerHTML = providers
      .map((p) => {
        const account = p.auth?.name || p.auth?.email || '';
        const used = (p.usage?.windows || []).map((w) => `${w.usedPct}%${w.short}`);
        const info = [account, ...used].filter(Boolean).join(' ');
        const suffix = !p.available ? ' (not installed)' : info ? ` (${info})` : '';
        return `<option value="${p.id}"${p.available ? '' : ' disabled'}>${esc(p.label)}${esc(suffix)}</option>`;
      })
      .join('');
    const firstAvailable = providers.find((p) => p.available);
    if (firstAvailable) selProvider.value = firstAvailable.id;
    fillModelControls();
    // The auth probes can resolve long after a session was opened, and the chips
    // must keep showing that session's data, not snap back to the defaults.
    const open = currentSession();
    if (open) reflectSession(open);

    const warnings = providers
      .filter((p) => p.available && p.auth && p.auth.loggedIn === false)
      .map(
        (p) =>
          `<div class="rounded-lg border border-warn px-2.5 py-1.5 text-left text-xs text-warn">⚠ ${esc(p.label)}: ${esc(p.auth.detail || 'not logged in')}</div>`,
      );
    $('provider-warnings').innerHTML = warnings.join('');
  }

  selProvider.addEventListener('change', fillModelControls);
  selProject.addEventListener('change', () => {
    document.querySelector('.wl-repo').textContent = projectLabel(selProject.value);
    loadBranches(selProject.value);
    closePromptPop();
    syncWorkspaceModes();
  });

  // ---------- workspace mode (⌗ Worktree / ⌂ Local) ----------
  //
  // Worktree is the default: a fresh clone with its own branch and database.
  // Local runs the session inside the project's existing checkout on this
  // machine, and only offered when the project has one configured in Settings.

  const isLocalMode = () => selWorkspace.value === 'local';
  // Orchestrator: a chat with no checkout that starts and supervises worker
  // sessions; no branch to pick and no loops of its own (its workers get
  // reviewed instead).
  // Zeus is the same supervisor briefed to write an epic instead of landing
  // code: no branch, no loops, workers that only read. Wherever the composer
  // asks "is this a supervisor", both count.
  const isZeusMode = () => selWorkspace.value === 'zeus';
  const isOrchMode = () => selWorkspace.value === 'orchestrator' || isZeusMode();

  // Local mode keeps the branch picker: a picked branch is checked out in the
  // local tree (a plain checkout: git refuses over conflicting changes), and
  // the empty pick means "whatever the checkout has out".
  function applyWorkspaceMode() {
    if (current) return; // an open session's controls are locked anyway
    // Re-label the empty pick for the mode; entering orchestrator mode also
    // drops a picked branch, so the disabled chip agrees with the request the
    // composer actually sends (which carries no branch in this mode).
    setBranchItems(branchItems, isOrchMode() ? '' : branchValue);
    // An orchestrator has no checkout, so there is no branch to pick either.
    branchBtn.disabled = isOrchMode();
    // No review loop though: the loop starts review sessions, and a review
    // needs a workspace clone; an orchestrator has no pull request of its own.
    $('btn-loop').classList.toggle('hidden', isLocalMode() || isOrchMode());
    $('btn-qa-loop').classList.toggle('hidden', isLocalMode() || isOrchMode());
    paintQaLoopChip(qaLoopOn, reviewLoopOn && !isLocalMode() && !isOrchMode());
  }

  function syncWorkspaceModes() {
    const project = projects.find((p) => p.repo === selProject.value);
    const localOption = selWorkspace.querySelector('option[value="local"]');
    localOption.disabled = !project || !project.hasLocal;
    localOption.title = localOption.disabled ? 'Set the project’s local checkout in Settings first' : '';
    if (localOption.disabled && isLocalMode()) selWorkspace.value = 'worktree';
    applyWorkspaceMode();
  }

  selWorkspace.addEventListener('change', async () => {
    applyWorkspaceMode();
    zeusDraft = null;
    if (!current && isZeusMode()) {
      const repo = selProject.value;
      const roles = await pickZeusRoles();
      if (roles) zeusDraft = { repo, roles };
      else {
        selWorkspace.value = 'worktree';
        applyWorkspaceMode();
      }
    }
  });

  // ---------- branch picker ----------
  //
  // A repository can have hundreds of branches, so this is a searchable
  // dropdown rather than a <select>: a button showing the pick, and a popup
  // with a filter box over the list.
  //
  // Empty value = the default behaviour: a fresh dev-<id> branch cut off the
  // repo's default branch. Any other value is an existing branch the session
  // checks out and works on directly.

  const branchBtn = $('branch-btn');
  const branchPop = $('branch-pop');
  const branchSearch = $('branch-search');
  const branchList = $('branch-list');
  const branchLabelEl = $('branch-label');

  let branchToken = 0; // guards against a slow response for a project already switched away from
  let branchItems = []; // [{ value, label }]; the first entry is the new-branch option
  let branchValue = '';
  let branchActive = 0; // highlighted row within the filtered list

  function branchItemsFrom({ defaultBranch, branches }) {
    return [{ value: '', label: `New branch off ${defaultBranch || 'the default branch'}` }].concat(
      (branches || []).map((b) => ({ value: b, label: b })),
    );
  }

  // In Local mode the empty pick keeps the checkout's own branch, so its
  // label says that instead of "New branch off …"; an orchestrator has no
  // checkout at all.
  function branchItemLabel(item) {
    if (!current && isOrchMode() && item.value === '') return 'No checkout';
    return !current && isLocalMode() && item.value === '' ? 'Current branch' : item.label;
  }

  // The label falls back to the raw value for a branch that is not in the list:
  // an open session shows the branch it works on without loading any.
  function setBranchItems(items, selected = '') {
    branchItems = items;
    branchValue = items.some((i) => i.value === selected) ? selected : (items[0]?.value ?? '');
    const item = items.find((i) => i.value === branchValue);
    branchLabelEl.textContent = item ? branchItemLabel(item) : branchValue;
  }

  function setBranchDisabled(disabled) {
    branchBtn.disabled = disabled;
    if (disabled) closeBranchPop();
    // Opening and leaving a session both land here, and both move the project
    // without firing `change` on the chip, so this is where a popover holding
    // the previous project's prompts has to go.
    closePromptPop();
  }

  function branchFiltered() {
    const q = branchSearch.value.trim().toLowerCase();
    return q ? branchItems.filter((i) => i.label.toLowerCase().includes(q)) : branchItems;
  }

  function renderBranchList() {
    const items = branchFiltered();
    branchActive = Math.min(branchActive, Math.max(0, items.length - 1));
    const row = 'branch-item cursor-pointer truncate rounded-md px-2 py-[5px] text-xs hover:bg-field';
    branchList.innerHTML = items.length
      ? items
          .map((i, n) => {
            const cls = [
              row,
              n === branchActive ? 'bg-field' : '',
              i.value === branchValue ? 'text-accent' : '',
            ].join(' ');
            return `<div class="${cls}" data-value="${esc(i.value)}">${esc(branchItemLabel(i))}</div>`;
          })
          .join('')
      : '<div class="px-2 py-[5px] text-xs text-muted">No branch matches</div>';
    branchList.children[branchActive]?.scrollIntoView({ block: 'nearest' });
  }

  const branchPopOpen = () => !branchPop.classList.contains('hidden');

  function openBranchPop() {
    if (branchBtn.disabled) return;
    branchSearch.value = '';
    branchActive = Math.max(
      0,
      branchItems.findIndex((i) => i.value === branchValue),
    );
    branchPop.classList.remove('hidden');
    renderBranchList();
    branchSearch.focus();
  }

  function closeBranchPop() {
    branchPop.classList.add('hidden');
  }

  function pickBranch(value) {
    setBranchItems(branchItems, value);
    closeBranchPop();
    branchBtn.focus();
  }

  branchBtn.addEventListener('click', () => (branchPopOpen() ? closeBranchPop() : openBranchPop()));
  branchSearch.addEventListener('input', () => {
    branchActive = 0;
    renderBranchList();
  });
  branchSearch.addEventListener('keydown', (e) => {
    const items = branchFiltered();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      branchActive = (branchActive + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      renderBranchList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[branchActive]) pickBranch(items[branchActive].value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeBranchPop();
      branchBtn.focus();
    }
  });
  branchList.addEventListener('click', (e) => {
    const row = e.target.closest('.branch-item');
    if (row) pickBranch(row.dataset.value);
  });
  document.addEventListener('mousedown', (e) => {
    if (branchPopOpen() && !$('branch-picker').contains(e.target)) closeBranchPop();
    if (promptPopOpen() && !$('prompt-picker').contains(e.target)) closePromptPop();
  });

  // ---------- saved prompts ----------
  //
  // The kickoff library, fetched every time the menu opens: it is one small
  // request, and it spares this page from tracking edits made in Settings or
  // a project switch since the last open. The project's own prompts come
  // first, then the shared ones; the server orders them.
  const promptPop = $('prompt-pop');
  const promptList = $('prompt-list');
  let promptItems = [];
  let promptToken = 0; // same job as branchToken: drop a slow list for a project already switched away from

  const promptPopOpen = () => !promptPop.classList.contains('hidden');

  async function openPromptPop() {
    const token = ++promptToken;
    promptList.innerHTML = '<div class="px-2 py-[5px] text-xs text-muted">Loading…</div>';
    $('prompt-save').disabled = !inputEl.value.trim();
    promptPop.classList.remove('hidden');
    // No project, no list: an empty repo reads as "unscoped" on the server and
    // would hand back every project's prompts.
    const repo = selProject.value;
    if (!repo) {
      promptItems = [];
      promptList.innerHTML = '<div class="px-2 py-[5px] text-xs text-muted">Pick a project first.</div>';
      return;
    }
    try {
      const data = await api(`/api/dev/prompts?repo=${encodeURIComponent(repo)}`);
      if (token !== promptToken || !promptPopOpen()) return;
      promptItems = data.prompts;
      renderPromptList();
    } catch (e) {
      if (token !== promptToken || !promptPopOpen()) return;
      promptList.innerHTML = `<div class="px-2 py-[5px] text-xs text-danger">${esc(e.message)}</div>`;
    }
  }

  function closePromptPop() {
    promptToken++;
    promptPop.classList.add('hidden');
  }

  function renderPromptList() {
    const row = 'prompt-item cursor-pointer rounded-md px-2 py-[5px] text-xs hover:bg-field';
    promptList.innerHTML = promptItems.length
      ? promptItems
          .map(
            (p) => `<div class="${row}" data-id="${p.id}" title="${esc(p.body.slice(0, 300))}">
              <div class="truncate">${esc(p.title)}</div>
              <div class="truncate text-[11px] text-muted">${p.repo ? esc(projectLabel(p.repo)) : 'all projects'}</div>
            </div>`,
          )
          .join('')
      : '<div class="px-2 py-[5px] text-xs text-muted">No saved prompts yet. Type one below and save it, or add some in Settings.</div>';
  }

  // Inserting never replaces what is typed: a saved prompt is a starting
  // point, and the text already in the box may be the specifics to go with it.
  function insertPrompt(body) {
    const current = inputEl.value;
    inputEl.value = current.trim() ? `${current.replace(/\s+$/, '')}\n\n${body}` : body;
    inputEl.dispatchEvent(new Event('input')); // re-grows the box
    inputEl.focus();
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  }

  $('prompt-btn').addEventListener('click', () => (promptPopOpen() ? closePromptPop() : openPromptPop()));
  promptList.addEventListener('click', (e) => {
    const row = e.target.closest('.prompt-item');
    const item = row && promptItems.find((p) => p.id === Number(row.dataset.id));
    if (!item) return;
    closePromptPop();
    insertPrompt(item.body);
  });
  $('prompt-save').addEventListener('click', async () => {
    const body = inputEl.value.trim();
    closePromptPop();
    if (!body) return;
    const title = await openPrompt({
      title: 'Save as prompt',
      body: 'The text in the message box becomes a saved prompt, offered on every project. Bind it to one project, or edit it later, under Saved prompts in Settings.',
      label: 'Title',
      placeholder: 'What the Prompts menu should call it',
      confirmLabel: 'Save',
    });
    if (!title) return;
    try {
      await api('/api/dev/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.split('\n')[0].trim(), body }),
      });
      toast('Saved prompt');
    } catch (e) {
      toast(e.message, true);
    }
  });

  async function loadBranches(repo, selected = '') {
    const token = ++branchToken;
    if (!repo) {
      setBranchItems([{ value: '', label: 'New branch off the default branch' }]);
      return;
    }
    setBranchItems([{ value: '', label: 'Loading branches…' }]);
    try {
      const data = await api(`/api/dev/branches?repo=${encodeURIComponent(repo)}`);
      if (token !== branchToken) return;
      setBranchItems(branchItemsFrom(data), selected);
    } catch (e) {
      if (token !== branchToken) return;
      // The picker still has to offer the default path when GitHub is out of
      // reach; only the list of existing branches is lost.
      setBranchItems(branchItemsFrom({ branches: selected ? [selected] : [] }), selected);
      toast(`Branches: ${e.message}`, true);
    }
  }

  // ---------- mobile drawers ----------

  // Below `lg` the session list and the PR panel are drawers over the chat
  // rather than columns beside it: ☰ and ⓘ slide them in, the scrim and Escape
  // send them back, and picking anything inside the session list closes it:
  // on a phone the point of tapping a session is to read it, not to keep
  // looking at the list. Above `lg` the CSS pins both open and none of this
  // does anything visible.
  const isMobile = () => window.matchMedia('(max-width: 1023px)').matches;

  function setDrawer(which, open) {
    const el = $(which === 'pr' ? 'pr-panel' : 'sidebar');
    el.classList.toggle('open', open);
    // One scrim for both; it is up whenever either drawer is.
    const any = $('sidebar').classList.contains('open') || $('pr-panel').classList.contains('open');
    $('scrim').classList.toggle('hidden', !any);
  }

  function closeDrawers() {
    setDrawer('sidebar', false);
    setDrawer('pr', false);
  }

  // Called after anything that navigates the main pane, so the drawer that
  // started the navigation gets out of the way. A no-op at desk width.
  function closeDrawersOnMobile() {
    if (isMobile()) closeDrawers();
  }

  $('btn-menu').addEventListener('click', () =>
    setDrawer('sidebar', !$('sidebar').classList.contains('open')),
  );
  $('btn-prpanel').addEventListener('click', () =>
    setDrawer('pr', !$('pr-panel').classList.contains('open')),
  );
  $('scrim').addEventListener('click', closeDrawers);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawers();
  });
  // Rotating to landscape (or resizing a desktop window down and back) must not
  // leave a drawer stuck open behind a layout that no longer has a scrim.
  window.addEventListener('resize', () => {
    if (!isMobile()) closeDrawers();
  });

  // ⓘ is only worth offering when the panel has something in it, and renderPrPanel
  // decides that by hiding the panel outright.
  function syncPrToggle() {
    const empty = $('pr-panel').classList.contains('hidden');
    $('btn-prpanel').classList.toggle('hidden', empty);
    if (empty) setDrawer('pr', false);
  }

  // ---------- sign out ----------

  // The dashboard has a password only when it is configured to; on a local
  // install there is nothing to sign out of, so the control stays hidden.
  (async () => {
    try {
      const { enabled } = await (await fetch('/api/auth/state')).json();
      if (enabled) $('btn-signout').classList.remove('hidden');
    } catch {
      /* no login, or the server is down: either way, no button */
    }
  })();

  $('btn-signout').addEventListener('click', async () => {
    try {
      await fetch('/api/logout', { method: 'POST' });
    } finally {
      location.href = '/login';
    }
  });

  // ---------- sidebar ----------

  // The sidebar is a drill-down two menus deep: the project list, and, once a
  // project is picked, that project's sessions, each carrying the branch it
  // works on as a badge. ‹ All projects walks back out. Which project is open
  // survives a reload and the sessions poll's re-render.
  const OPEN_PROJECT_KEY = 'dev.sidebarProject';
  let sidebarRepo = localStorage.getItem(OPEN_PROJECT_KEY) || null;

  // The blocks folded shut, by the id of the session at the top of each. What
  // this is for is an epic: an orchestrator carries a worker per sub-issue and
  // each worker its reviews, fix errands and QA run, which is the one thing in
  // this list long enough to be worth folding onto a single line — but any row
  // with sessions under it folds, so the caret means the same everywhere it
  // appears. Kept in memory rather than localStorage: it is where the reader
  // is looking right now, not a setting.
  const collapsedSessions = new Set();

  // The rows the last render put on screen. The pick list reads it so ☑ Select
  // only ever speaks for what can be seen, folds included.
  let visibleSessionIds = new Set();

  // Which session a row files under, most specific link first. Both the tree
  // and revealSession() walk it, so it is written once.
  const parentLinks = (s) => [s.loopParentId, s.qaParentId, s.loopFixParentId, s.parentId].filter(Boolean);

  function setSidebarRepo(repo) {
    if (sidebarRepo === repo) return;
    sidebarRepo = repo || null;
    if (sidebarRepo) localStorage.setItem(OPEN_PROJECT_KEY, sidebarRepo);
    else localStorage.removeItem(OPEN_PROJECT_KEY);
    // The pick list only ever holds one project's sessions, so leaving that
    // project leaves the pick list too, rather than closing rows off screen.
    if (selectMode) setSelectMode(false);
    else renderSidebar();
  }

  // Which branch a session belongs to: the one its workspace actually cut or
  // checked out, falling back to what was picked for it while prep is still
  // running. A local session with no pick works on whatever the checkout has
  // out, and a worktree one has not cut its dev-<id> branch yet.
  // Which branch a session is filed under. `prBranch` comes first: an errand
  // that works on a pull request through gh alone (📋 Test sheet, ✎ PR body,
  // 🧹 Delete my comments) borrows the local checkout without switching it, so
  // its `branch` is whichever branch the developer had out, filing the run
  // under someone else's pull request. The pull request it was started from is
  // the one it belongs to. A run started before `prBranch` existed says the
  // same thing through the pull request it is attached to, so it moves to the
  // right place too rather than needing the sessions rewritten.
  function sessionBranch(s) {
    const pr = s.prBranch || (s.local && s.prStatus ? s.prStatus.headRef : null);
    return pr || s.branch || s.startBranch || s.reviewBranch || (s.local ? 'Local checkout' : 'New branch');
  }

  // Opening a conversation (from the sidebar, a new session, or a project row)
  // drills the sidebar into its project, so the row it highlights is on screen.
  // Once per conversation, though: from then on where the sidebar stands is the
  // reader's, and neither the drill-down nor the folds may be taken back by the
  // next poll, seconds after the reader walked out or folded a branch away.
  let revealedFor = null;
  function revealSession(id) {
    const s = sessions.find((x) => x.id === id);
    if (!s) return; // its record has not arrived yet; the poll comes back for it
    revealedFor = id;
    // Drilling into the project is not enough on its own: a worker opened from
    // a link or started from the board can sit inside a folded orchestration,
    // and the row the sidebar is about to light has to be on screen. The walk
    // is capped the way the tree's depth is, against a parent link that somehow
    // leads back into its own ancestry.
    for (let p = s, depth = 0; p && depth < 8; depth++) {
      p = sessions.find((x) => parentLinks(p).includes(x.id));
      if (p) collapsedSessions.delete(p.id);
    }
    if (sidebarRepo === s.repo) return;
    sidebarRepo = s.repo;
    localStorage.setItem(OPEN_PROJECT_KEY, sidebarRepo);
  }

  // What the session is doing, for the dot and the line under the title. An
  // idle session the agent left a question on is not just idle; it is waiting
  // on the reader, which is the one state worth spotting from the sidebar.
  function sessionState(s) {
    return s.awaitingAnswer && s.status === 'idle' ? 'waiting' : s.status;
  }

  // GitHub's own pull-request marks (Primer's octicons, 16px viewBox), so a
  // session says from the sidebar where its change stands rather than only
  // what the agent is doing. Drawn inline because the app ships no icon set
  // and four paths are not worth one.
  const PR_ICONS = {
    open: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
    draft:
      'M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z',
    merged:
      'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z',
    closed:
      'M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z',
  };
  const PR_ICON_COLORS = {
    open: 'text-ok',
    draft: 'text-muted',
    merged: 'text-accent',
    closed: 'text-danger',
  };

  // The mark at the left of a session row: its pull request's state once it has
  // one, the status dot until then (a session with no PR has nothing else to
  // say). Either way the working pulse stays on it, because what the sidebar is
  // scanned for is which rows are still moving.
  function sessionMark(s) {
    const pr = s.prStatus;
    const state = pr && pr.state === 'open' && pr.draft ? 'draft' : pr && pr.state;
    const path = state && PR_ICONS[state];
    if (!path) return `<span class="dot ${esc(sessionState(s))}"></span>`;
    const pulse = WORKING_STATES.has(sessionState(s)) ? ' animate-pulse' : '';
    return `<svg viewBox="0 0 16 16" class="size-[13px] shrink-0 fill-current ${PR_ICON_COLORS[state]}${pulse}"><title>PR #${pr.number} ${esc(state)}</title><path d="${path}"/></svg>`;
  }

  // ---------- bulk selection ----------
  //
  // ☑ Select turns the session list into a pick list: clicking rows ticks them
  // instead of opening them, and the bar above the footer closes or deletes
  // everything ticked in one go. Ctrl/⌘-clicking a row turns the mode on too.

  let selectMode = false;
  const selected = new Set();

  // Open = the session still holds a workspace clone and a database server, so
  // it is the only kind Close has anything to release.
  const isOpenSession = (s) => ['queued', 'preparing', 'running', 'idle'].includes(s.status);
  const selectedSessions = () => sessions.filter((s) => selected.has(s.id));
  // Only the drilled-into project's sessions are in the list at all, so only
  // they are ever picked or deleted in bulk.
  const listedSessions = () => (sidebarRepo ? sessions.filter((s) => s.repo === sidebarRepo) : []);
  // What Select all speaks for: the listed rows a fold has not taken off
  // screen, so a tick is never put on a row the reader cannot see. 🗑 Delete
  // all still means every conversation in the project, folded away or not,
  // which is why it reads listedSessions() instead.
  const pickableSessions = () => listedSessions().filter((s) => visibleSessionIds.has(s.id));

  function setSelectMode(on) {
    selectMode = on;
    if (!on) selected.clear();
    $('btn-select').classList.toggle('text-accent', on);
    $('btn-select').textContent = on ? '✕ Done' : '☑ Select';
    renderSidebar();
  }

  function renderBulkBar() {
    // A session deleted elsewhere (or by the last bulk run) must not keep a
    // tick of its own in the count.
    for (const id of [...selected]) if (!sessions.some((s) => s.id === id)) selected.delete(id);
    const bar = $('bulk-bar');
    bar.classList.toggle('hidden', !selectMode);
    bar.classList.toggle('flex', selectMode);
    if (!selectMode) return;
    const picked = selectedSessions();
    const open = picked.filter(isOpenSession).length;
    const listed = listedSessions();
    const pickable = pickableSessions();
    $('bulk-count').textContent = picked.length
      ? `${picked.length} selected${open ? ` · ${open} open` : ''}`
      : pickable.length
        ? 'Click sessions to pick them'
        : 'Open a project to pick its sessions';
    $('bulk-all').textContent = picked.length === pickable.length && pickable.length ? 'Clear' : 'Select all';
    $('bulk-all').disabled = !pickable.length;
    $('bulk-close').disabled = !open;
    $('bulk-delete').disabled = !picked.length;
    // Delete all names its own count, so it never reads as a second ⌫ Delete.
    $('bulk-delete-all').textContent =
      `🗑 Delete all ${listed.length} conversation${listed.length === 1 ? '' : 's'}`;
    $('bulk-delete-all').disabled = !listed.length;
  }

  function toggleSelected(id) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    renderSidebar();
  }

  $('btn-select').addEventListener('click', () => setSelectMode(!selectMode));

  // Escape leaves the pick list, but never out from under a dialog or the
  // branch popup, which answer Escape themselves.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !selectMode || modalResolve || branchPopOpen()) return;
    e.preventDefault();
    setSelectMode(false);
  });

  $('bulk-all').addEventListener('click', () => {
    const pickable = pickableSessions();
    if (selected.size === pickable.length) selected.clear();
    else pickable.forEach((s) => selected.add(s.id));
    renderSidebar();
  });

  // Both bulk buttons walk the picks one at a time: closing a session releases
  // a MySQL instance and a clone, and the server does that work serially
  // anyway. Whatever failed is named in the toast; the rest still went through.
  async function runBulk(picks, run) {
    const failed = [];
    for (const s of picks) {
      try {
        await run(s);
      } catch (e) {
        failed.push(`${s.title || s.id}: ${e.message}`);
      }
    }
    await loadSessions();
    renderSidebar();
    return failed;
  }

  $('bulk-close').addEventListener('click', async () => {
    const picks = selectedSessions().filter(isOpenSession);
    if (!picks.length) return;
    const ok = await openConfirm({
      title: `Close ${picks.length} session${picks.length === 1 ? '' : 's'}?`,
      body: 'Their workspace clones and MySQL instances are released, and any queued message is dropped. The conversations stay readable, and ⟳ Reopen brings a session back.',
      confirmLabel: 'Close sessions',
      icon: '⏻',
    });
    if (!ok) return;
    const failed = await runBulk(picks, (s) => api(`/api/dev/sessions/${s.id}/close`, { method: 'POST' }));
    setSelectMode(false);
    toast(
      failed.length
        ? `Closed ${picks.length - failed.length} of ${picks.length}: ${failed[0]}`
        : `Closed ${picks.length} session${picks.length === 1 ? '' : 's'}`,
      !!failed.length,
    );
  });

  // 🗑 Delete and 🗑 Delete all end in the same place: a confirm naming what
  // goes, then one DELETE per conversation.
  async function deleteSessions(picks, title) {
    if (!picks.length) return;
    const open = picks.filter(isOpenSession).length;
    const ok = await openConfirm({
      title,
      body: `The conversations and their logs are removed for good. This cannot be undone.${open ? ` ${open} of them ${open === 1 ? 'is' : 'are'} still open, so ${open === 1 ? 'it is' : 'they are'} closed first, releasing ${open === 1 ? 'its' : 'their'} workspace and database.` : ''}`,
      confirmLabel: 'Delete',
      danger: true,
      icon: '🗑',
    });
    if (!ok) return;
    const ids = picks.map((s) => s.id);
    const failed = await runBulk(picks, (s) => api(`/api/dev/sessions/${s.id}`, { method: 'DELETE' }));
    setSelectMode(false);
    // The open conversation may have been one of them.
    if (current && ids.includes(current) && !sessions.some((s) => s.id === current)) showWelcome();
    toast(
      failed.length
        ? `Deleted ${picks.length - failed.length} of ${picks.length}: ${failed[0]}`
        : `Deleted ${picks.length} conversation${picks.length === 1 ? '' : 's'}`,
      !!failed.length,
    );
  }

  $('bulk-delete').addEventListener('click', () => {
    const picks = selectedSessions();
    deleteSessions(picks, `Delete ${picks.length} conversation${picks.length === 1 ? '' : 's'}?`);
  });

  // Clearing out a finished project: every conversation it has, without ticking
  // twenty rows first. Only the drilled-into project's, never the whole app's.
  $('bulk-delete-all').addEventListener('click', () => {
    const picks = listedSessions();
    deleteSessions(
      picks,
      `Delete all ${picks.length} conversation${picks.length === 1 ? '' : 's'} in ${projectLabel(sidebarRepo)}?`,
    );
  });

  function renderSidebar() {
    visibleSessionIds = new Set();
    const badge = 'rounded border border-line px-[5px] text-[11px] text-muted';
    const row = (s, under = 0) => {
      const picked = selected.has(s.id);
      const lit = selectMode ? picked : s.id === current;
      // The branch rides along as a box beside the provider's: it is the one
      // place a session says which branch it works on, and clicking it opens
      // that branch's pull request in the main pane. An orchestrator has no
      // branch, so its box just names what it is and opens nothing.
      const branch = sessionBranch(s);
      const branchBox = s.orchestrator
        ? `<span class="min-w-0 max-w-[45%] truncate ${badge}">${s.zeus ? '⚡ zeus' : '🧭 orchestrator'}</span>`
        : `<span class="brn-open min-w-0 max-w-[45%] truncate ${badge} hover:border-line-strong hover:text-ink"
                  data-repo="${esc(s.repo)}" data-branch="${esc(branch)}"
                  title="Open the pull request on ${esc(branch)} and its runs">${esc(branch)}</span>`;
      // A tooling fix says so, and which repository it is on when that is not
      // the list it is drawn in (under its orchestrator, in the other project).
      const toolingBox = s.toolingFor
        ? `<span class="shrink-0 ${badge}" title="A fix to the dashboard itself, sent by the orchestrator on ${esc(s.toolingFor)}">🩹 tooling${s.repo !== sidebarRepo ? ` on ${esc(s.repo)}` : ''}</span>`
        : s.readOnly
          ? `<span class="shrink-0 ${badge}" title="A read-only analyst started by a Zeus session: it reports, it never pushes">🔬 ${esc(zeusAnalystLabel(s.analystRole))}</span>`
          : '';
      // The caret sits in a gutter of its own down the left of the list, and a
      // row with nothing under it leaves that gutter empty rather than closing
      // it up, so every status mark still lines up. Shut, the row says how many
      // sessions it is holding: the block underneath is what it took away.
      const shut = under > 0 && collapsedSessions.has(s.id);
      const fold = under
        ? `<button type="button" class="sess-fold -ml-1 mt-[3px] w-3 shrink-0 cursor-pointer text-[11px] leading-none text-muted hover:text-ink" data-fold="${esc(s.id)}"
                   title="${shut ? `Show the ${under} session${under === 1 ? '' : 's'} under this one` : 'Fold this block away'}">${shut ? '▸' : '▾'}</button>`
        : '<span class="-ml-1 w-3 shrink-0"></span>';
      return `
      <div class="sess flex cursor-pointer items-start gap-2 rounded-lg px-2 py-2.5 hover:bg-raise lg:py-[7px]${lit ? ' bg-raise' : ''}" data-id="${s.id}">
        ${selectMode ? `<input type="checkbox" class="sess-check mt-1 shrink-0 accent-accent" tabindex="-1"${picked ? ' checked' : ''}>` : ''}
        ${fold}
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <div class="flex items-center gap-[7px] text-[14px]">
            ${sessionMark(s)}
            <span class="min-w-0 flex-1 truncate">${esc(s.title || '(untitled)')}</span>
            ${shut ? `<span class="shrink-0 text-[11px] text-muted" title="${under} session${under === 1 ? '' : 's'} folded away">${under}</span>` : ''}
          </div>
          <div class="flex items-center gap-2 text-[12px] text-muted">
            <span class="${badge}">${esc(s.provider)}</span>
            ${branchBox}
            ${toolingBox}
            <span class="shrink-0">${esc(sessionState(s))}</span>
            <span class="shrink-0">${timeAgo(s.createdAt)}</span>
          </div>
        </div>
      </div>`;
    };

    const busy = (list) => list.some((s) => ['queued', 'preparing', 'running'].includes(s.status));

    // Every configured project gets a row whether or not it has sessions yet:
    // clicking it is how its pull requests are opened. A repo with sessions but
    // no project row (deleted from Settings since) keeps its row too, so
    // those conversations stay reachable.
    const repos = [...new Set([...projects.map((p) => p.repo), ...sessions.map((s) => s.repo)])];
    // A project deleted from Settings (or a stale one left in localStorage)
    // has no menu to drill into, so the sidebar walks back out to the list.
    if (sidebarRepo && !repos.includes(sidebarRepo)) {
      sidebarRepo = null;
      localStorage.removeItem(OPEN_PROJECT_KEY);
    }

    // The first menu.
    if (!sidebarRepo) {
      listEl.innerHTML =
        repos
          .map((repo) => {
            const group = sessions.filter((s) => s.repo === repo);
            return `
        <div class="prj-open flex cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-2 text-[14px] hover:bg-raise" data-repo="${esc(repo)}"
             title="Open ${esc(projectLabel(repo))}’s pull requests and branches">
          <span class="min-w-0 flex-1 truncate">${esc(projectLabel(repo))}</span>
          ${busy(group) ? '<span class="dot running"></span>' : ''}
          <span class="shrink-0 text-[12px] text-muted">${group.length}</span>
          <span class="shrink-0 text-[11px] text-muted">›</span>
        </div>`;
          })
          .join('') ||
        '<div class="px-2 py-2 text-[12px] text-muted">No projects yet. Add one in Settings.</div>';
      renderBulkBar();
      return;
    }

    // The second menu: one project's sessions, with the way back out on top,
    // drawn as a tree. A worker files under its orchestrator, and what a
    // session's loops started for it (its code reviews, their fix errands, its
    // QA run) files under that session — so an orchestration reads as one
    // block: supervisor › worker › the review of what that worker pushed. A
    // child whose parent is not in this list falls back to the top rather than
    // disappearing with it.
    //
    // A tooling fix is the one child on another repository: an orchestrator
    // on this project sent it to the dashboard's own. It is drawn here under
    // that orchestrator (with the reviews its loop ran), and again at the top
    // of the dashboard project's own list, where its branch and pull request
    // belong.
    const group = sessions.filter((s) => s.repo === sidebarRepo);
    const listed = new Set(group.map((s) => s.id));
    for (let grew = true; grew;) {
      grew = false;
      for (const s of sessions) {
        if (listed.has(s.id) || !parentLinks(s).some((id) => listed.has(id))) continue;
        listed.add(s.id);
        group.push(s);
        grew = true;
      }
    }
    const parentOf = (s) => parentLinks(s).find((id) => listed.has(id)) || null;
    const kids = new Map(); // parent id -> its children, in list order
    const top = [];
    for (const s of group) {
      const parent = parentOf(s);
      if (parent) {
        if (!kids.has(parent)) kids.set(parent, []);
        kids.get(parent).push(s);
      } else top.push(s);
    }
    // Everything under a row, however deep: what its caret hides, and what it
    // counts once folded.
    const countUnder = (s, depth = 0) =>
      (depth < 4 ? kids.get(s.id) || [] : []).reduce((n, k) => n + 1 + countUnder(k, depth + 1), 0);
    // Depth is capped rather than trusted: nothing writes a parent link back
    // into its own ancestry today, and a record that somehow did would hang
    // the sidebar instead of drawing one odd row.
    const treeRows = (s, depth = 0) => {
      visibleSessionIds.add(s.id);
      const mine = depth < 4 ? kids.get(s.id) || [] : [];
      const shut = mine.length > 0 && collapsedSessions.has(s.id);
      return (
        row(s, countUnder(s, depth)) +
        (mine.length && !shut
          ? `<div class="ml-3 border-l border-line pl-1">${mine.map((k) => treeRows(k, depth + 1)).join('')}</div>`
          : '')
      );
    };
    listEl.innerHTML = `
      <div class="prj-back flex cursor-pointer select-none items-center gap-1.5 rounded-lg px-2 py-2 text-[12px] lg:py-[5px] text-muted hover:bg-raise hover:text-ink"
           title="Back to the project list">
        <span class="text-[13px]">‹</span><span>All projects</span>
      </div>
      <div class="prj-board mt-0.5 mb-1 flex cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-2.5 text-[14px] lg:py-1.5 ${sidebarRepo === currentProject ? 'bg-raise text-ink' : 'hover:bg-raise'}"
           data-repo="${esc(sidebarRepo)}" title="Open ${esc(projectLabel(sidebarRepo))}’s pull requests">
        <span class="min-w-0 flex-1 truncate">${esc(projectLabel(sidebarRepo))}</span>
        <span class="shrink-0 text-[12px] text-muted">${group.length}</span>
      </div>
      ${
        group.length
          ? top.map((s) => treeRows(s)).join('')
          : '<div class="px-2 py-2 text-[12px] text-muted">No sessions on this project yet.</div>'
      }`;
    renderBulkBar();
  }

  listEl.addEventListener('click', (e) => {
    const projRow = e.target.closest('.prj-open');
    if (projRow) {
      setSidebarRepo(projRow.dataset.repo);
      openPullRequest(projRow.dataset.repo, null);
      return;
    }
    if (e.target.closest('.prj-back')) {
      // Leaving the project takes its dashboard with it, so the main pane never
      // shows a board the sidebar has walked away from.
      if (currentProject) showWelcome();
      setSidebarRepo(null);
      return;
    }
    const boardRow = e.target.closest('.prj-board');
    if (boardRow) {
      openPullRequest(boardRow.dataset.repo, null);
      return;
    }
    // Folding a block is a view state of the sidebar, not a trip to the server:
    // the rows are loaded already, and the list redraws where it is. A tick
    // never survives out of sight, so the pick list still speaks for exactly
    // the rows on screen.
    const fold = e.target.closest('.sess-fold');
    if (fold) {
      const id = fold.dataset.fold;
      if (collapsedSessions.has(id)) collapsedSessions.delete(id);
      else collapsedSessions.add(id);
      renderSidebar();
      if (selectMode) {
        for (const picked of [...selected]) if (!visibleSessionIds.has(picked)) selected.delete(picked);
        renderBulkBar();
      }
      return;
    }
    // The branch box on a session row opens that branch's pull request rather
    // than the conversation, except while ticking rows, where every click on a
    // row is a tick.
    const branchBox = e.target.closest('.brn-open');
    if (branchBox && !selectMode) {
      openPullRequest(branchBox.dataset.repo, branchBox.dataset.branch);
      return;
    }
    const item = e.target.closest('.sess');
    if (!item) return;
    // Ctrl/⌘-click is the shortcut into the pick list: from there a plain
    // click ticks rows, and ☑ Done goes back to opening them.
    if (!selectMode && (e.ctrlKey || e.metaKey)) setSelectMode(true);
    if (selectMode) toggleSelected(item.dataset.id);
    else openSession(item.dataset.id);
  });

  async function loadSessions() {
    try {
      sessions = (await api('/api/dev/sessions')).sessions;
      // A session may have landed from another tab, so the sidebar follows it
      // into its project and onto the screen — once, on the tick its record
      // arrives, and never again over the reader's shoulder afterwards.
      if (current && revealedFor !== current) revealSession(current);
      renderSidebar();
      if (officeOpen) renderOffice(); // the poll is what empties a chair a deleted session left
      if (boardBranch) renderBoard(); // the open pull request's runs are these sessions
      if (current) updateHead();
    } catch {
      /* the poll retries */
    }
  }

  // ---------- chat view ----------

  function currentSession() {
    return sessions.find((s) => s.id === current) || null;
  }

  // While a session is open its chips are locked, and they must always show
  // that session's data, however late the providers/projects loads land and
  // however the session changes mid-run (prep cutting its dev-<id> branch).
  // A value a new session could not pick (a deleted project, a legacy
  // provider slug, a model no longer offered) gets a temporary option,
  // dropped again by showWelcome().
  function ensureOption(sel, value, label = value) {
    const v = String(value ?? '');
    let opt = [...sel.options].find((o) => o.value === v);
    if (!opt) {
      opt = document.createElement('option');
      opt.value = v;
      opt.textContent = label;
      opt.dataset.session = '1';
      sel.appendChild(opt);
    }
    sel.value = v;
  }

  function reflectSession(s) {
    // Newer sessions carry the provider row id; ones from before providers
    // moved into the database only have the old slug in s.provider.
    const sessionProvider = providerById(s.providerId ?? s.provider);
    if (sessionProvider) selProvider.value = sessionProvider.id;
    else ensureOption(selProvider, s.providerId ?? s.provider ?? '', s.provider || '(unknown provider)');
    fillModelControls();
    ensureOption(selModel, s.model);
    ensureOption(selEffort, s.effort);
    ensureOption(selProject, s.repo, projectLabel(s.repo));
    selWorkspace.value = s.zeus ? 'zeus' : s.orchestrator ? 'orchestrator' : s.local ? 'local' : 'worktree';
    // A branches load still in flight must not clobber the chip when it lands.
    branchToken++;
    // Show the branch the session actually works on: the dev-<id> branch it
    // cut once prep got that far, or the one that was picked for it.
    const picked = s.startBranch || s.reviewBranch || '';
    setBranchItems([
      {
        value: picked,
        label:
          s.branch ||
          picked ||
          (s.zeus
            ? 'Read-only clone of the default branch'
            : s.orchestrator
              ? 'No checkout'
              : s.local
                ? 'Local checkout'
                : 'New branch off the default branch'),
      },
    ]);
  }

  // The 🔁 chip's two states, painted from whatever it stands for right now:
  // the composer's pick for the next session, or the open session's own loop.
  function paintLoopChip(on) {
    $('btn-loop').classList.toggle('border-accent', on);
    $('btn-loop').classList.toggle('text-accent', on);
    $('btn-loop').textContent = on ? '🔁 Review loop: on' : '🔁 Review loop';
  }

  // The QA chip follows the review chip: its one trigger is the review loop's
  // clean convergence, so it is not offered without that loop.
  function paintQaLoopChip(on, enabled = true) {
    $('btn-qa-loop').classList.toggle('border-accent', on);
    $('btn-qa-loop').classList.toggle('text-accent', on);
    $('btn-qa-loop').disabled = !enabled;
    $('btn-qa-loop').textContent = on ? '🎬 QA loop: on' : '🎬 QA loop';
  }

  // Which sessions the chip is offered on: the ones the loop applies to, and
  // only while they are open, the same rule the server enforces. A review, a
  // QA run, an auto-closing errand and a loop's own review are each one step
  // of somebody's flow, and a local session cannot start reviews at all.
  // 🛠 Implement feedback is offered: it starts with the loop already on.
  function loopable(s, open) {
    return (
      open && !s.local && !s.orchestrator && !s.reviewBranch && !s.qaBranch && !s.autoClose && !s.loopParentId
    );
  }

  function updateHead() {
    const s = currentSession();
    if (!s) return;
    $('chat-title').textContent = s.title || '(untitled)';
    const bits = [`${s.provider} · ${s.model} · ${s.effort}`, sessionState(s)];
    if (s.local) bits.push('local checkout');
    if (s.orchestrator) {
      // With the workers' runtime when the start picked one: the provider
      // label is looked up by row id, the way the session's own is stored.
      const wr = s.workerRuntime;
      const wp = wr && providerById(wr.providerId);
      const kind = s.zeus ? '⚡ zeus' : '🧭 orchestrator';
      const crew = s.zeus ? 'analysts' : 'workers';
      bits.push(
        wr ? `${kind} · ${crew} on ${wp ? wp.label : 'a removed entry'} · ${wr.model} · ${wr.effort}` : kind,
      );
    }
    if (s.toolingFor) bits.push(`🩹 tooling fix for the orchestrator on ${s.toolingFor}`);
    if (s.readOnly)
      bits.push(`🔬 read-only ${s.analystRole ? `${zeusAnalystLabel(s.analystRole)} ` : ''}analyst`);
    if (s.reviewLoop)
      bits.push(
        `🔁 loop${s.reviewLoop.rounds ? ` round ${s.reviewLoop.rounds}` : ''}${
          s.reviewLoop.reviewing
            ? ' (review running)'
            : s.reviewLoop.pendingResult
              ? ' (reading the review’s result)'
              : s.reviewLoop.triage
                ? ' (awaiting the orchestrator’s triage)'
                : s.reviewLoop.fixing
                  ? ' (fix session running)'
                  : s.reviewLoop.stalled
                    ? ' (stalled)'
                    : s.reviewLoop.failure
                      ? ` (round ${s.reviewLoop.failure.round} could not run — 🔁 off and on retries it)`
                      : ''
        }`,
      );
    if (s.qaLoop) {
      const qa = s.qaLoop;
      bits.push(
        `🎬 QA ${
          qa.running
            ? 'running'
            : qa.pendingVerdict
              ? 'reading verdict'
              : qa.verdictError
                ? 'verdict unavailable — check the test sheet'
                : qa.failure
                  ? `${qa.failure.kind || 'failed'} — not running; send a follow-up turn to retry`
                  : qa.done
                    ? 'done'
                    : s.reviewLoop?.done
                      ? 'retry pending — send a follow-up turn'
                      : 'queued'
        }`,
      );
    }
    if (s.branch) bits.push(s.branch);
    if (s.dbPort) bits.push(`mysql ${s.dbHost ? `${s.dbHost}:` : ':'}${s.dbPort}`);
    if (usageChip(s)) bits.push(usageChip(s));
    bits.push(`session ${s.id}`);
    if (s.error) bits.push(`⚠ ${s.error}`);
    let sub = bits.map((b) => esc(b)).join('  ·  ');
    if (s.prStatus) sub += `  ·  ${prBadge(s.prStatus)}`;
    $('chat-sub').innerHTML = sub;
    reflectSession(s);
    const open = ['queued', 'preparing', 'running', 'idle'].includes(s.status);
    // ▶ Run serves a checkout, which an orchestrator does not have.
    $('btn-serve').classList.toggle('hidden', !open || !!s.orchestrator);
    $('btn-cancel-turn').classList.toggle('hidden', s.status !== 'running');
    // Closed, interrupted and failed all mean the same thing here: the session
    // let go of its workspace and can take it back.
    $('btn-reopen').classList.toggle('hidden', open);
    $('btn-close-session').classList.toggle('hidden', !open);
    $('btn-delete-session').classList.toggle('hidden', open);
    $('btn-loop').classList.toggle('hidden', !loopable(s, open));
    $('btn-qa-loop').classList.toggle('hidden', !loopable(s, open) || !s.reviewLoop);
    // An exact manual link is useful precisely when automatic discovery
    // missed one. The server still verifies that the PR's head is this branch.
    $('btn-link-pr').classList.toggle(
      'hidden',
      !!s.orchestrator || !!s.prStatus || (!s.branch && !s.prBranch),
    );
    paintLoopChip(!!s.reviewLoop);
    paintQaLoopChip(!!s.qaLoop);
    setComposerState(s);
    renderQueued(s);
    refreshAskCards();
    renderPrPanel(s);
  }

  // What a session has spent with everything it ordered included: the
  // server's rollup over its workers, reviews, fix sessions and QA runs, live
  // and already deleted alike. Falls back to the record's own figures for a
  // record written before the rollup existed.
  function sessionUsage(s) {
    return s.usage || s;
  }

  // "12.4k tok · $0.83": what the session has consumed so far. Tokens are
  // input + output over every turn; the cost is only there when the provider
  // priced its turns, so a codex session shows tokens alone.
  function usageChip(s) {
    const u = sessionUsage(s);
    const tokens = (u.inputTokens || 0) + (u.outputTokens || 0);
    const bits = [];
    if (tokens) bits.push(`${fmtTokens(tokens)} tok`);
    if (u.costUsd != null) bits.push(`$${u.costUsd.toFixed(2)}`);
    return bits.join(' · ');
  }

  // "🟢 PR #123 open · ✓4 ✗1 ●2" as a link to the PR. State and CI checks
  // come from the server's periodic GitHub sync.
  function prBadge(pr) {
    const icon = pr.state === 'merged' ? '🟣' : pr.state === 'closed' ? '🔴' : '🟢';
    const c = pr.checks;
    const parts = [];
    if (c && c.passed) parts.push(`✓${c.passed}`);
    if (c && c.failed) parts.push(`✗${c.failed}`);
    if (c && c.pending) parts.push(`●${c.pending}`);
    const checks = parts.length ? ` · ${parts.join(' ')}` : '';
    return `<a class="text-accent hover:underline" href="${esc(pr.url)}" target="_blank" rel="noopener" title="${esc(pr.title || '')}">${icon} PR #${pr.number} ${esc(pr.state)}${esc(checks)}</a>`;
  }

  // The right-hand PR overview: state, branches, line changes and every CI
  // check. Fed by the same server-side GitHub sync as the header badge, and
  // refreshed by the sessions poll, including mid-turn, the moment the agent
  // opens a PR.
  // "82.3k tokens" / "1.2M tokens": session context sizes.
  function fmtTokens(n) {
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  function fmtDur(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  // Colors for the context-window bar, keyed on the category names claude's
  // /context report uses. Deferred/buffer rows and unknown categories go gray;
  // free space is the same near-background gray the bar track uses.
  const CTX_COLORS = {
    messages: '#6d9ef7',
    'system prompt': '#e06c75',
    'system tools': '#d98a3f',
    'mcp tools': '#4fae72',
    skills: '#c96f9e',
    'memory files': '#5fae5f',
    'custom agents': '#8f7ee8',
    context: '#6d9ef7',
    'free space': '#3e3e3a',
  };
  function ctxColor(name) {
    const n = String(name).toLowerCase();
    if (n.includes('deferred') || n.includes('autocompact')) return '#55524c';
    return CTX_COLORS[n] || '#8a867c';
  }

  // The session's context usage: how much of the model's window is used: a
  // segmented bar with claude's per-category /context estimate when the server
  // has one, plain used-vs-free otherwise, plus total input/output token
  // consumption, accumulated agent time and cost. Lives in the right panel
  // under the PR overview (or alone before a PR exists).
  function usageSection(s, hasPr) {
    const cu = s.contextUsage || {};
    const used = cu.tokens ?? s.contextTokens;
    const win = cu.window ?? s.contextWindow;
    let ctx = '';
    if (used != null) {
      const headline = win
        ? `${fmtTokens(used)} / ${fmtTokens(win)} (${Math.round((used / win) * 100)}%)`
        : `${fmtTokens(used)} tokens`;
      // Categories come from the claude /context probe; the other providers
      // still get a bar, just an undivided one.
      const cats = (cu.categories || []).filter((c) => c.tokens != null);
      const segs = cats.length
        ? cats
        : win
          ? [
              { name: 'Context', tokens: used, pct: (used / win) * 100 },
              { name: 'Free space', tokens: Math.max(0, win - used), pct: 100 - (used / win) * 100 },
            ]
          : [];
      const bar = segs.length
        ? `<div class="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-sunken">${segs
            .map(
              (c) =>
                `<div style="width:${Math.max(0, Math.min(100, c.pct)).toFixed(2)}%;background:${ctxColor(c.name)}"></div>`,
            )
            .join('')}</div>`
        : '';
      const catRows = cats
        .map(
          (c) =>
            `<div class="flex items-center gap-1.5 text-[12px] text-muted">
           <span class="size-2 shrink-0 rounded-[3px]" style="background:${ctxColor(c.name)}"></span>
           <span class="flex-1 truncate">${esc(c.name)}</span>
           <span>${fmtTokens(c.tokens)}</span>
           <span class="w-11 shrink-0 text-right text-ink">${c.pct.toFixed(1)}%</span>
         </div>`,
        )
        .join('');
      ctx = `<div class="flex items-center justify-between text-[12px] text-muted"><span>Context</span><span class="text-ink">${headline}</span></div>
        ${bar}${catRows ? `<div class="mt-1.5 flex flex-col gap-0.5">${catRows}</div>` : ''}`;
    }
    const rows = [];
    const row = (label, value) =>
      `<div class="flex items-center justify-between text-[12px] text-muted"><span>${label}</span><span class="text-ink">${value}</span></div>`;
    const u = sessionUsage(s);
    if (u.inputTokens != null) rows.push(row('Input tokens', fmtTokens(u.inputTokens)));
    if (u.outputTokens != null) rows.push(row('Output tokens', fmtTokens(u.outputTokens)));
    if (u.durationMs != null) rows.push(row('Agent time', fmtDur(u.durationMs)));
    if (u.costUsd != null) rows.push(row('Cost', `$${u.costUsd.toFixed(2)}`));
    // Say when those numbers are more than this conversation's own: an
    // orchestrator's cover its workers, a task's the reviews its loop ran.
    if (u.sessions)
      rows.push(row('Includes', `${u.sessions} session${u.sessions === 1 ? '' : 's'} it started`));
    if (!ctx && !rows.length) return '';
    return `<div class="${hasPr ? 'border-t border-line pt-2.5' : ''}">
        <div class="mb-1 text-[12px] tracking-wide text-muted">Context usage</div>
        ${ctx}
        <div class="${ctx ? 'mt-1.5 border-t border-line pt-1.5 ' : ''}flex flex-col gap-0.5">${rows.join('')}</div>
      </div>`;
  }

  // The sub-agents the turn has working right now: one row per running Task
  // call, with how long it has been going. The server drops each agent from the
  // list the moment its result comes back, so the section empties itself and
  // disappears when the turn is done.
  function subagentsSection(s) {
    // Gated on the turn actually running: a session restored after a crash can
    // carry the sub-agents its killed turn never got to close.
    const live = (s && s.status === 'running' && s.subagents) || [];
    if (!live.length) return '';
    const rows = live
      .map((a) => {
        const since = a.startedAt ? fmtDur(Math.max(0, Date.now() - new Date(a.startedAt).getTime())) : '';
        return `<div class="flex items-baseline gap-1.5 text-[12px] text-muted">
          <span class="shrink-0 text-ink">${esc(a.name || 'agent')}</span>
          <span class="truncate" title="${esc(a.summary || '')}">${esc(a.summary || '')}</span>
          ${since ? `<span class="ml-auto shrink-0">${esc(since)}</span>` : ''}
        </div>`;
      })
      .join('');
    return `<div>
        <div class="mb-1 text-[12px] tracking-wide text-muted">Sub-agents (${live.length} working)</div>
        <div class="flex flex-col gap-0.5">${rows}</div>
      </div>`;
  }

  // ---------- review findings ----------
  //
  // The findings the PR's reviews declared (each summary comment carries a
  // machine-readable block), with a three-way verdict per finding: Fix (it
  // must land before merge, mirrored onto the PR as the anchored "Required
  // fixes" checklist), Optional, or Dismiss. Fetched separately from the PR
  // sync and cached; a verdict click writes through the server and re-renders
  // from its answer.

  let prFindings = { key: null, at: 0, list: null, fixesUrl: null, error: null };
  // Fetch starts per PR, tracked outside prFindings (which gets replaced on
  // completion): the panel re-renders many times a second during a live turn,
  // and every render asks for the findings, so this is what keeps that to one
  // request, however the renders interleave with the responses.
  const findingsAttempts = new Map(); // key -> when a fetch last started

  async function loadFindings(repo, number) {
    const key = `${repo}#${number}`;
    if (Date.now() - (findingsAttempts.get(key) || 0) < 15000) return;
    findingsAttempts.set(key, Date.now());
    try {
      const data = await api(`/api/pr/findings?repo=${encodeURIComponent(repo)}&pr=${number}`);
      prFindings = { key, at: Date.now(), list: data.findings, fixesUrl: data.fixesUrl, error: null };
    } catch (e) {
      prFindings = { key, at: Date.now(), list: [], fixesUrl: null, error: e.message };
    }
    const s = panelSubject;
    if (s && s.prStatus && `${s.repo}#${s.prStatus.number}` === key) renderPrPanel(s);
  }

  const SEV_CHIP = {
    critical: ['CRIT', 'border-danger text-danger'],
    high: ['HIGH', 'border-danger text-danger'],
    medium: ['MED', 'border-warn text-warn'],
    low: ['LOW', 'border-line text-muted'],
  };

  function findingsSection(s, pr) {
    const key = `${s.repo}#${pr.number}`;
    // Another PR's list must never render as this one's, so load and wait.
    if (prFindings.key !== key || Date.now() - prFindings.at > 60000) loadFindings(s.repo, pr.number);
    if (prFindings.key !== key) return '';
    const list = prFindings.list || [];
    if (!list.length) return '';
    const decBtn = (f, dec, label) => {
      const on = f.decision === dec;
      const activeCls = dec === 'fix' ? 'border-danger text-danger' : 'border-accent text-accent';
      return `<button type="button" class="finding-dec cursor-pointer rounded border bg-transparent px-1.5 py-px text-[11px] ${on ? activeCls : 'border-line text-muted hover:text-ink'}"
        data-key="${esc(f.key)}" data-dec="${dec}" data-on="${on ? '1' : ''}">${label}</button>`;
    };
    const rows = list
      .map((f) => {
        const [sevLabel, sevCls] = SEV_CHIP[f.severity] || SEV_CHIP.medium;
        const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '';
        const fixed =
          f.decision === 'fix' && f.fixed
            ? '<span class="ml-auto shrink-0 text-[11px] text-ok">✓ fixed</span>'
            : '';
        return `<div class="flex flex-col gap-1">
          <div class="flex items-center gap-1.5">
            <span class="shrink-0 rounded-[4px] border px-1 text-[10px] font-semibold ${sevCls}">${sevLabel}</span>
            <span class="truncate text-[12px]" title="${esc(loc ? `${f.title} · ${loc}` : f.title)}">${esc(f.title)}</span>
            ${fixed}
          </div>
          <div class="flex gap-1">${decBtn(f, 'fix', 'Fix')}${decBtn(f, 'optional', 'Optional')}${decBtn(f, 'dismissed', 'Dismiss')}</div>
        </div>`;
      })
      .join('');
    const mustFix = list.filter((f) => f.decision === 'fix');
    const openFixes = mustFix.filter((f) => !f.fixed).length;
    const label = `Findings (${list.length}${mustFix.length ? ` · ${openFixes ? `${openFixes} to fix` : 'all fixed'}` : ''})`;
    return `<details class="border-t border-line pt-2.5" data-fold="findings"${prFolds.findings ? ' open' : ''}>
        <summary class="mb-1 cursor-pointer select-none text-[12px] tracking-wide text-muted">${label}</summary>
        <div class="flex flex-col gap-2">${rows}</div>
        ${prFindings.fixesUrl ? `<div class="mt-1.5 text-[11px]"><a class="text-muted hover:text-ink hover:underline" href="${esc(prFindings.fixesUrl)}" target="_blank" rel="noopener">Required fixes on the PR ↗</a></div>` : ''}
      </details>`;
  }

  $('pr-panel').addEventListener('click', async (e) => {
    const btn = e.target.closest('.finding-dec');
    if (!btn) return;
    const s = panelSubject;
    if (!s || !s.prStatus) return;
    btn.disabled = true;
    try {
      // Clicking the active verdict clears it back to undecided.
      const data = await api('/api/pr/findings/decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: s.repo,
          pr: s.prStatus.number,
          key: btn.dataset.key,
          decision: btn.dataset.on === '1' ? null : btn.dataset.dec,
        }),
      });
      prFindings = { ...prFindings, at: Date.now(), list: data.findings, fixesUrl: data.fixesUrl };
      renderPrPanel(s);
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  });

  // What the right-hand panel is drawing: the open session, or, when the board
  // is drilled into one pull request, a stand-in carrying just the repo and
  // that PR's overview. Everything the panel does asynchronously (loading the
  // findings, writing a verdict back) redraws from this rather than from the
  // open session, since on the board there is none.
  let panelSubject = null;

  function renderPrPanel(s) {
    panelSubject = s;
    const panel = $('pr-panel');
    const pr = s && s.prStatus;
    const agents = subagentsSection(s);
    const usage = s ? usageSection(s, !!pr || !!agents) : '';
    if (!pr) {
      panel.innerHTML = agents + usage;
      panel.classList.toggle('hidden', !agents && !usage);
      syncPrToggle();
      return;
    }
    const stateColor =
      pr.state === 'merged' ? 'text-accent' : pr.state === 'closed' ? 'text-danger' : 'text-ok';
    const stateChip = `<span class="rounded-[5px] border border-line px-1.5 py-0.5 text-[11px] font-semibold ${stateColor}">${esc(pr.state)}${pr.draft ? ' · draft' : ''}</span>`;
    const diffBits = [];
    if (pr.additions != null)
      diffBits.push(
        `<span class="text-ok">+${pr.additions}</span> <span class="text-danger">−${pr.deletions}</span>`,
      );
    if (pr.changedFiles != null) diffBits.push(`${pr.changedFiles} file${pr.changedFiles === 1 ? '' : 's'}`);
    if (pr.commits != null) diffBits.push(`${pr.commits} commit${pr.commits === 1 ? '' : 's'}`);
    const diff = diffBits.length ? `<div class="text-[12px] text-muted">${diffBits.join(' · ')}</div>` : '';
    // The PR's commits, clickable and folded away under the file changes. The
    // count list may lag one sync behind pr.commits; it is fetched separately.
    const commitRows = (pr.commitList || [])
      .map(
        (cm) => `
      <div class="flex items-center gap-1.5 text-[12px] text-muted">
        <span class="shrink-0 font-mono text-[11px]">${esc(String(cm.sha || '').slice(0, 7))}</span>
        <a class="truncate hover:text-ink hover:underline" href="${esc(cm.url)}" target="_blank" rel="noopener" title="${esc(cm.message)}">${esc(cm.message)}</a>
      </div>`,
      )
      .join('');
    const commits = commitRows
      ? `<details class="border-t border-line pt-2.5" data-fold="commits"${prFolds.commits ? ' open' : ''}>
          <summary class="mb-1 cursor-pointer select-none text-[12px] tracking-wide text-muted">Commits (${(pr.commitList || []).length})</summary>
          <div class="flex flex-col gap-0.5">${commitRows}</div>
        </details>`
      : '';
    const c = pr.checks;
    let checksLabel = 'Checks';
    let checksBody = '<div class="text-[12px] text-muted">No checks yet</div>';
    if (c && c.total) {
      // "(3 completed / 1 pending)" rides in the summary so the folded section
      // still says where the checks stand.
      const completed = c.total - (c.pending || 0);
      checksLabel = `Checks (${completed} completed${c.pending ? ` / ${c.pending} pending` : ''})`;
      const summary = [
        c.passed ? `<span class="text-ok">✓${c.passed}</span>` : '',
        c.failed ? `<span class="text-danger">✗${c.failed}</span>` : '',
        c.pending ? `<span class="text-warn">●${c.pending}</span>` : '',
      ]
        .filter(Boolean)
        .join(' ');
      const rows = (c.runs || [])
        .map((r) => {
          const icon =
            r.status !== 'completed'
              ? '<span class="text-warn">●</span>'
              : r.conclusion === 'success'
                ? '<span class="text-ok">✓</span>'
                : ['failure', 'timed_out', 'action_required'].includes(r.conclusion)
                  ? '<span class="text-danger">✗</span>'
                  : '<span class="text-muted">○</span>';
          const name = r.url
            ? `<a class="truncate hover:text-ink hover:underline" href="${esc(r.url)}" target="_blank" rel="noopener" title="${esc(r.name)}">${esc(r.name)}</a>`
            : `<span class="truncate" title="${esc(r.name)}">${esc(r.name)}</span>`;
          return `<div class="flex items-center gap-1.5 text-[12px] text-muted">${icon}${name}</div>`;
        })
        .join('');
      checksBody = `<div class="text-[12px]">${summary}</div><div class="mt-1 flex flex-col gap-0.5">${rows}</div>`;
    }
    const checks = `<details class="border-t border-line pt-2.5" data-fold="checks"${prFolds.checks ? ' open' : ''}>
        <summary class="mb-1 cursor-pointer select-none text-[12px] tracking-wide text-muted">${checksLabel}</summary>
        ${checksBody}
      </details>`;
    // The issues the PR closes: GitHub's "Development" links, mirrored by the
    // same server-side sync. Section is skipped entirely when there are none.
    const issueRows = (pr.issues || [])
      .map((i) => {
        const icon =
          i.state === 'closed' ? '<span class="text-accent">✓</span>' : '<span class="text-ok">◉</span>';
        return `<div class="flex items-center gap-1.5 text-[12px] text-muted">${icon}<a class="truncate hover:text-ink hover:underline" href="${esc(i.url)}" target="_blank" rel="noopener" title="${esc(i.title || '')}">#${i.number} ${esc(i.title || '')}</a></div>`;
      })
      .join('');
    const issues = issueRows
      ? `<div class="border-t border-line pt-2.5">
          <div class="mb-1 text-[12px] tracking-wide text-muted">Linked issue${(pr.issues || []).length === 1 ? '' : 's'}</div>
          <div class="flex flex-col gap-0.5">${issueRows}</div>
        </div>`
      : '';
    // The PR's review verdicts: whether each reviewer (the published code
    // review included) approved the change, asked for changes, or commented.
    // The reviewer's name stays off the panel on purpose: one anonymous row
    // per reviewer, verdict only.
    const reviewRows = (pr.reviews || [])
      .map((r) => {
        const icon =
          r.state === 'approved'
            ? '<span class="text-ok">✓</span>'
            : r.state === 'changes_requested'
              ? '<span class="text-danger">✗</span>'
              : '<span class="text-muted">○</span>';
        const label =
          r.state === 'approved'
            ? '<span class="text-ok">approved</span>'
            : r.state === 'changes_requested'
              ? '<span class="text-danger">changes requested</span>'
              : 'commented';
        return `<div class="flex items-center gap-1.5 text-[12px] text-muted">${icon}<span>${label}</span></div>`;
      })
      .join('');
    const reviews = reviewRows
      ? `<div class="border-t border-line pt-2.5">
          <div class="mb-1 text-[12px] tracking-wide text-muted">Reviews</div>
          <div class="flex flex-col gap-0.5">${reviewRows}</div>
        </div>`
      : '';
    const findings = findingsSection(s, pr);
    panel.innerHTML = `
      <div class="text-[12px] tracking-wide text-muted">Pull request</div>
      <div class="flex flex-col gap-1.5">
        <a class="text-sm font-semibold text-ink hover:text-accent hover:underline" href="${esc(pr.url)}" target="_blank" rel="noopener">${esc(pr.title || `PR #${pr.number}`)}</a>
        <div class="flex items-center gap-1.5 text-[12px] text-muted"><a class="hover:text-ink hover:underline" href="${esc(pr.url)}" target="_blank" rel="noopener">#${pr.number}</a>${stateChip}</div>
        ${diff}
      </div>
      ${agents ? `<div class="border-t border-line pt-2.5">${agents}</div>` : ''}
      ${commits}
      ${issues}
      ${reviews}
      ${findings}
      ${checks}
      ${usage}
      <div class="mt-auto pt-2 text-[11px] text-muted">synced ${timeAgo(pr.syncedAt)}</div>`;
    panel.classList.remove('hidden');
    syncPrToggle();
  }

  // The sessions poll re-renders the panel every few seconds, which would
  // snap an opened fold shut, so remember each fold's state and re-apply it.
  // `toggle` does not bubble, so listen in the capture phase.
  const prFolds = { checks: false, commits: false, findings: true };
  $('pr-panel').addEventListener(
    'toggle',
    (e) => {
      const fold = e.target.dataset ? e.target.dataset.fold : null;
      if (fold) prFolds[fold] = e.target.open;
    },
    true,
  );

  // The composer never refuses a message any more: mid-turn it queues, and on a
  // session that let go of its workspace it reopens one. Only the placeholder
  // and the note say which of the three is about to happen.
  function setComposerState(s) {
    const busy = s && ['queued', 'preparing', 'running'].includes(s.status);
    const down = s && ['closed', 'interrupted', 'failed'].includes(s.status);
    $('btn-send').disabled = false;
    inputEl.placeholder = !s
      ? 'Describe what to build…'
      : busy
        ? `Session is ${s.status}; your message goes in when this turn ends…`
        : down
          ? 'Reply, this reopens the session…'
          : s.awaitingAnswer
            ? 'Answer the question above…'
            : 'Reply…';
    $('composer-note').textContent = down
      ? 'The session has no workspace right now. Reopen, or just send: the next message re-prepares it and resumes.'
      : '';
  }

  // Messages waiting for the running turn to end, straight from the session
  // record: the server holds the queue, this only shows it.
  function renderQueued(s) {
    const queue = (s && s.queued) || [];
    const el = $('queued-list');
    el.classList.toggle('hidden', !queue.length);
    el.classList.toggle('flex', !!queue.length);
    el.innerHTML = queue
      .map((m, n) => {
        const label = m.text || (m.attachments || []).map((a) => a.name).join(', ');
        return `
      <span class="flex items-center gap-1.5 rounded-lg border border-line bg-field px-2 py-1 text-[12px] text-muted">
        <span class="shrink-0">⏳</span>
        <span class="flex-1 truncate" title="${esc(label)}">${esc(label)}</span>
        <span class="shrink-0">queued</span>
        <button class="queued-drop shrink-0 cursor-pointer border-0 bg-transparent px-0.5 text-muted hover:text-danger" data-n="${n}" title="Don't send this">✕</button>
      </span>`;
      })
      .join('');
  }

  $('queued-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('.queued-drop');
    if (!btn || !current) return;
    try {
      await api(`/api/dev/sessions/${current}/queue/${btn.dataset.n}`, { method: 'DELETE' });
      loadSessions();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ---------- questions from the agent ----------
  //
  // An `ask` event is the agent stopping to ask something: claude's own
  // AskUserQuestion call, or the <ask-user> block every provider is briefed on.
  // It renders as a card whose answers are buttons; picking one sends it as the
  // next message. Only the newest question of a session that is still waiting
  // stays clickable, so a reloaded conversation does not offer to re-answer
  // everything it ever asked.

  function renderAsk(div, e) {
    div.className = 'ask-card my-3 rounded-xl border border-accent-dim bg-raise px-3.5 py-3';
    div.dataset.multi = e.multiSelect ? '1' : '';
    const options = (e.options || [])
      .map(
        (o, n) =>
          `<button type="button" class="ask-opt btn" data-n="${n}" data-label="${esc(o.label)}"${o.description ? ` title="${esc(o.description)}"` : ''}>${esc(o.label)}</button>`,
      )
      .join('');
    div.innerHTML = `
      <div class="text-[12px] tracking-wide text-accent">? ${esc(e.header || 'Question')}</div>
      <div class="mt-1 break-words">${inline(e.question || '')}</div>
      ${
        options
          ? `<div class="mt-2.5 flex flex-wrap gap-1.5">${options}${
              e.multiSelect ? '<button type="button" class="ask-send btn btn-primary">Send</button>' : ''
            }</div>`
          : ''
      }
      <div class="mt-2 text-[12px] text-muted">${
        options
          ? e.multiSelect
            ? 'Pick any that apply, or answer in your own words below.'
            : 'Pick one, or answer in your own words below.'
          : 'Answer in the box below.'
      }</div>`;
  }

  // Which card is live: the last one, and only while the session is still
  // waiting on an answer.
  function refreshAskCards() {
    const s = currentSession();
    const cards = [...messagesEl.querySelectorAll('.ask-card')];
    const live = s && s.awaitingAnswer ? cards[cards.length - 1] : null;
    for (const card of cards) {
      const active = card === live;
      card.style.opacity = active ? '' : '0.55';
      card.querySelectorAll('button').forEach((b) => {
        b.disabled = !active;
      });
    }
  }

  function askSelection(card) {
    return [...card.querySelectorAll('.ask-opt')]
      .filter((b) => b.dataset.on === '1')
      .map((b) => b.dataset.label);
  }

  messagesEl.addEventListener('click', (e) => {
    const card = e.target.closest('.ask-card');
    if (!card) return;
    const opt = e.target.closest('.ask-opt');
    if (opt && card.dataset.multi !== '1') return answerAsk(opt.dataset.label);
    if (opt) {
      // Multi-select: the buttons toggle, and the Send button below sends them.
      opt.dataset.on = opt.dataset.on === '1' ? '' : '1';
      opt.classList.toggle('border-accent', opt.dataset.on === '1');
      opt.classList.toggle('text-accent', opt.dataset.on === '1');
      return;
    }
    if (e.target.closest('.ask-send')) {
      const picked = askSelection(card);
      if (!picked.length) return toast('Pick at least one answer first', true);
      answerAsk(picked.join('\n'));
    }
  });

  // An answer is an ordinary message: it goes through the composer so it
  // queues, reopens and reports failures exactly like a typed one would.
  function answerAsk(text) {
    inputEl.value = inputEl.value.trim() ? `${inputEl.value.trim()}\n${text}` : text;
    autoGrow();
    send();
  }

  function showWelcome() {
    zeusDraft = null;
    // Where the app stood when the composer opened: the board on screen, or the
    // project the sidebar is drilled into. closeProjectView() forgets the
    // former, so read it first.
    const inProject = currentProject || sidebarRepo;
    current = null;
    closeProjectView();
    closeStream();
    $('welcome').classList.remove('hidden');
    messagesEl.classList.add('hidden');
    $('chat-head').classList.add('hidden');
    renderPrPanel(null);
    messagesEl.innerHTML = '';
    selWorkspace.disabled =
      selProject.disabled =
      selProvider.disabled =
      selModel.disabled =
      selEffort.disabled =
        false;
    setBranchDisabled(false);
    syncPath();
    // Drop the options reflectSession() injected for values a new session
    // cannot pick, and fall back to real choices where one was selected.
    document.querySelectorAll('#composer-chips option[data-session]').forEach((o) => o.remove());
    if (!selProvider.value) {
      const firstAvailable = providers.find((p) => p.available);
      if (firstAvailable) selProvider.value = firstAvailable.id;
    }
    fillModelControls();
    selectProject(inProject);
    document.querySelector('.wl-repo').textContent = projects.length
      ? projectLabel(selProject.value)
      : 'project (add one in Settings)';
    loadBranches(selProject.value);
    // Back to standing for the next session, not the one just left.
    $('btn-loop').classList.remove('hidden');
    $('btn-loop').disabled = false;
    $('btn-qa-loop').classList.remove('hidden');
    paintLoopChip(reviewLoopOn);
    paintQaLoopChip(qaLoopOn, reviewLoopOn);
    syncWorkspaceModes();
    $('btn-send').disabled = false;
    setComposerState(null);
    renderQueued(null);
    renderSidebar();
    // On a phone, focusing the composer throws the keyboard up over half the
    // screen for anyone who only meant to walk back out of a project, so the
    // caret waits until they tap the box themselves.
    if (!isMobile()) inputEl.focus();
  }

  function closeStream() {
    if (es) {
      es.close();
      es = null;
    }
    lastSeq = 0;
    prepBox = null;
    toolBox = null;
  }

  async function openSession(id) {
    closeDrawersOnMobile();
    if (current === id) return;
    closeProjectView();
    closeStream();
    current = id;
    syncPath();
    // The conversation loads over the network, so show a loader instead of a
    // blank pane while it does, and drop it only if this session is still the
    // one being viewed when the response lands.
    messagesEl.innerHTML =
      '<div class="my-8 animate-pulse text-center text-sm text-muted">Loading session…</div>';
    $('welcome').classList.add('hidden');
    messagesEl.classList.remove('hidden');
    $('chat-head').classList.remove('hidden');
    revealSession(id);
    renderSidebar();
    // The session's provider/model are fixed at creation, and updateHead()
    // reflects them into the chips, which stay locked while it is open.
    selWorkspace.disabled =
      selProject.disabled =
      selProvider.disabled =
      selModel.disabled =
      selEffort.disabled =
        true;
    setBranchDisabled(true);
    // 🔁 is the one chip that stays live on an open session, and updateHead()
    // shows it again for the sessions the loop applies to. Hidden until then,
    // since it would otherwise still read as the composer's pick.
    $('btn-loop').classList.add('hidden');
    $('btn-qa-loop').classList.add('hidden');
    updateHead();
    try {
      const data = await api(`/api/dev/sessions/${id}`);
      if (current !== id) return; // switched again while loading
      messagesEl.innerHTML = '';
      for (const e of data.events) renderEvent(e);
      refreshAskCards();
      scrollBottom(true);
      stream(id);
    } catch (e) {
      if (current !== id) return;
      messagesEl.innerHTML = '';
      toast(e.message, true);
    }
  }

  function stream(id) {
    es = new EventSource(`/api/dev/sessions/${id}/events?since=${lastSeq}`);
    es.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data);
        renderEvent(e);
        scrollBottom();
        if (e.kind === 'status') {
          loadSessions();
        }
      } catch {
        /* keep streaming */
      }
    };
    // The session record, pushed by the server whenever it changes: PR state,
    // checks, reviews, the context probe, the live token counters. The header
    // and the right panel follow it turn by turn instead of lagging up to a
    // poll behind.
    es.addEventListener('session', (m) => {
      try {
        const s = JSON.parse(m.data);
        if (s.id !== current) return;
        const i = sessions.findIndex((x) => x.id === s.id);
        if (i === -1) sessions.unshift(s);
        else sessions[i] = s;
        renderSidebar();
        updateHead();
      } catch {
        /* keep streaming */
      }
    });
  }

  const PREP_KINDS = new Set(['cmd', 'git', 'setup']);

  function renderEvent(e) {
    if (e.seq <= lastSeq) return;
    lastSeq = e.seq;
    if (e.kind === 'status') {
      updateSpinner(e.status);
      return;
    }

    // Workspace prep lines fold into one collapsible block instead of
    // burying the conversation.
    if (PREP_KINDS.has(e.kind) || (e.kind === 'info' && !prepClosed(e))) {
      appendPrep(e);
      return;
    }
    prepBox = null;

    // Same for a run of tool calls: what the agent says is the conversation,
    // how it got there is one collapsed block the reader can open.
    if (e.kind === 'tool' || e.kind === 'tool_error') {
      appendTool(e);
      return;
    }
    toolBox = null;

    const div = document.createElement('div');
    switch (e.kind) {
      case 'user': {
        div.className =
          'group relative mt-[18px] mb-3.5 overflow-hidden rounded-xl border border-line bg-raise px-3.5 py-2.5';
        const body = document.createElement('div');
        body.className = 'break-words whitespace-pre-wrap';
        body.textContent = e.text;
        div.appendChild(body);
        if (e.attachments?.length) {
          const row = document.createElement('div');
          row.className = 'flex flex-wrap gap-1.5' + (e.text ? ' mt-2' : '');
          row.innerHTML = e.attachments
            .map(
              (a) =>
                `<span class="flex max-w-[240px] items-center gap-1.5 rounded-lg border border-line bg-field px-2 py-1 text-[12px]">📎 <span class="truncate" title="${esc(a.name)}">${esc(a.name)}</span></span>`,
            )
            .join('');
          div.appendChild(row);
        }
        if (e.t) div.appendChild(stamp(e.t, ' text-right'));
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.title = 'Copy message';
        btn.textContent = '⧉';
        btn.className =
          'absolute top-1.5 right-1.5 rounded-md border border-line bg-field px-1.5 py-0.5 text-[12px] text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink';
        btn.addEventListener('click', () => {
          navigator.clipboard
            .writeText(e.text || '')
            .then(() => {
              btn.textContent = '✓';
              setTimeout(() => {
                btn.textContent = '⧉';
              }, 1200);
            })
            .catch(() => toast('Could not copy to clipboard', true));
        });
        div.appendChild(btn);
        break;
      }
      case 'text':
        div.className = 'prose-chat';
        div.innerHTML = md(e.text);
        if (e.t) div.appendChild(stamp(e.t, ''));
        break;
      case 'ask':
        renderAsk(div, e);
        break;
      case 'stderr':
        div.className = 'ev-log text-danger';
        div.textContent = e.text;
        break;
      case 'claude':
        div.className = 'ev-log';
        div.textContent = e.text;
        break;
      case 'result': {
        div.className =
          'mt-2.5 mb-1 border-t border-dashed border-line pt-2 text-[12px] ' +
          (e.isError ? 'text-danger' : 'text-muted');
        const bits = [];
        if (e.isError) bits.push('turn failed');
        if (e.costUsd != null) bits.push(`$${e.costUsd.toFixed(4)}`);
        if (e.durationMs != null) bits.push(`${Math.round(e.durationMs / 1000)}s`);
        if (e.numTurns != null) bits.push(`${e.numTurns} turns`);
        if (e.inputTokens != null || e.outputTokens != null)
          bits.push(`${fmtTokens(e.inputTokens || 0)} in / ${fmtTokens(e.outputTokens || 0)} out`);
        if (e.tokens != null) bits.push(`${fmtTokens(e.tokens)} context`);
        div.textContent = bits.length ? `— ${bits.join(' · ')}` : '— turn done';
        break;
      }
      default:
        div.className = 'ev-log';
        div.textContent = e.text || JSON.stringify(e);
    }
    messagesEl.appendChild(div);
    // The session record only learns about a question on the next poll, and a
    // card that arrives disabled is a question nobody can answer, so mirror
    // the state the event itself carries and re-run the pass right away.
    if (e.kind === 'ask' || e.kind === 'user') {
      const s = currentSession();
      if (s) s.awaitingAnswer = e.kind === 'ask';
      refreshAskCards();
    }
  }

  // Info lines that belong to the conversation, not to workspace prep. The
  // worker notices an orchestrator's children push ("Started worker …",
  // "Worker … finished/asked/closed") are what its user watches the chat for,
  // so they must never fold into the prep block.
  function prepClosed(e) {
    return /^(Starting |Started worker |Worker )|session started/i.test(e.text || '');
  }

  function appendPrep(e) {
    if (!prepBox) {
      prepBox = document.createElement('details');
      prepBox.className = 'my-2 text-xs text-muted open:border-l-2 open:border-line open:pl-2.5';
      prepBox.innerHTML = '<summary class="cursor-pointer select-none">Preparing workspace…</summary>';
      messagesEl.appendChild(prepBox);
    }
    const line = document.createElement('div');
    line.className = 'ev-log';
    line.textContent = (e.kind === 'cmd' ? '$ ' : '') + (e.text || '');
    prepBox.appendChild(line);
    prepBox.querySelector('summary').textContent =
      `Preparing workspace… (${prepBox.children.length - 1} steps)`;
  }

  // One collapsed block per run of tool calls. The summary keeps the latest
  // step visible so a running turn still shows what the agent is doing.
  function appendTool(e) {
    if (!toolBox) {
      toolBox = document.createElement('details');
      toolBox.className = 'ev-steps';
      toolBox.innerHTML = '<summary class="cursor-pointer select-none text-xs text-muted"></summary>';
      messagesEl.appendChild(toolBox);
    }
    const line = document.createElement('div');
    if (e.kind === 'tool_error') {
      line.className = 'my-[3px] text-xs text-warn';
      line.textContent = `⚠ ${e.text}`;
    } else {
      line.className = 'my-[3px] flex items-baseline gap-2 text-xs text-muted';
      line.innerHTML =
        `<span class="shrink-0 rounded-[5px] border border-line bg-raise px-1.5 text-[12px] text-ink">${esc(e.name)}</span>` +
        `<span class="truncate font-mono text-[12px]">${esc(e.summary || '')}</span>`;
    }
    toolBox.appendChild(line);
    const n = toolBox.children.length - 1;
    const last = e.kind === 'tool_error' ? 'error' : e.name || '';
    toolBox.querySelector('summary').textContent =
      `${n} step${n === 1 ? '' : 's'}${last ? `  ·  ${last}` : ''}`;
  }

  let spinner = null;
  function updateSpinner(status) {
    if (spinner) {
      spinner.remove();
      spinner = null;
    }
    if (['running', 'preparing', 'queued'].includes(status)) {
      spinner = document.createElement('div');
      spinner.className = 'my-2 inline-block animate-pulse text-accent';
      spinner.textContent = status === 'running' ? 'working…' : `${status}…`;
      messagesEl.appendChild(spinner);
    }
  }

  function scrollBottom(force) {
    const nearBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 160;
    if (force || nearBottom) scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  // ---------- attachments ----------
  //
  // Files ride the next message: picked with 📎, pasted into the box, or
  // dropped onto the composer. Each is uploaded the moment it is attached, so
  // send only has ids to pass and an upload that fails does so while the user
  // is still looking at the chip.

  const attachListEl = $('attach-list');
  const fileInput = $('file-input');
  const composerEl = $('composer');
  let attachments = []; // { id?, name, size, uploading }

  function fmtSize(bytes) {
    return bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function renderAttachments() {
    attachListEl.classList.toggle('hidden', !attachments.length);
    attachListEl.classList.toggle('flex', !!attachments.length);
    attachListEl.innerHTML = attachments
      .map(
        (a, n) => `
      <span class="flex max-w-[240px] items-center gap-1.5 rounded-lg border border-line bg-field px-2 py-1 text-[12px]${a.uploading ? ' animate-pulse' : ''}">
        <span class="shrink-0">📎</span>
        <span class="truncate" title="${esc(a.name)}">${esc(a.name)}</span>
        <span class="shrink-0 text-muted">${a.uploading ? 'uploading…' : esc(fmtSize(a.size))}</span>
        <button class="attach-remove shrink-0 cursor-pointer border-0 bg-transparent px-0.5 text-muted hover:text-danger" data-n="${n}" title="Remove">✕</button>
      </span>`,
      )
      .join('');
  }

  attachListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.attach-remove');
    if (!btn) return;
    attachments.splice(Number(btn.dataset.n), 1);
    renderAttachments();
  });

  async function addFiles(files) {
    for (const file of files) {
      if (attachments.length >= 10) {
        toast('At most 10 files per message', true);
        break;
      }
      const item = { name: file.name || 'file', size: file.size, uploading: true };
      attachments.push(item);
      renderAttachments();
      try {
        // Always octet-stream: the server reads the raw body, and a file whose
        // own type is application/json must not hit the JSON body parser.
        const res = await fetch(`/api/dev/uploads?name=${encodeURIComponent(item.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        Object.assign(item, body.file, { uploading: false });
      } catch (err) {
        attachments = attachments.filter((a) => a !== item);
        toast(`${item.name}: ${err.message}`, true);
      }
      renderAttachments();
    }
  }

  $('btn-attach').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    addFiles([...fileInput.files]);
    fileInput.value = ''; // so picking the same file again fires change
  });

  // Paste: real files (Explorer copy) keep their names; a pasted image comes
  // in as the browser's generic "image.png" and gets a timestamped one.
  inputEl.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    addFiles(
      files.map((f) => {
        if (f.name && f.name !== 'image.png') return f;
        const ext = (f.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
        return new File([f], `pasted-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.${ext}`, {
          type: f.type,
        });
      }),
    );
  });

  composerEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    composerEl.classList.add('border-accent');
  });
  composerEl.addEventListener('dragleave', () => composerEl.classList.remove('border-accent'));
  composerEl.addEventListener('drop', (e) => {
    e.preventDefault();
    composerEl.classList.remove('border-accent');
    if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
  });

  // ---------- actions ----------

  async function createSession(prompt, extra = {}) {
    const { session } = await api('/api/dev/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: selProvider.value,
        model: selModel.value,
        effort: selEffort.value,
        repo: selProject.value || undefined,
        branch: (!isOrchMode() && branchValue) || undefined,
        local: isLocalMode() || undefined,
        orchestrator: (isOrchMode() && !isZeusMode()) || undefined,
        zeus: isZeusMode() || undefined,
        // The 🔁 chip arms the review loop, on the sessions it applies to
        // only: a review or QA session is itself one review, never a loop,
        // and an orchestrator's workers are what gets reviewed, not it.
        reviewLoop:
          (reviewLoopOn && !isLocalMode() && !isOrchMode() && !extra.review && !extra.qa) || undefined,
        // 🎬 queues behind that loop, never on the errands that skip it.
        qaLoop:
          (qaLoopOn && reviewLoopOn && !isLocalMode() && !isOrchMode() && !extra.review && !extra.qa) ||
          undefined,
        prompt,
        ...extra,
      }),
    });
    sessions.unshift(session);
    await openSession(session.id);
  }

  async function send() {
    const text = inputEl.value.trim();
    if ((!text && !attachments.length) || $('btn-send').disabled) return;
    if (attachments.some((a) => a.uploading)) {
      toast('A file is still uploading, one moment', true);
      return;
    }
    const sent = attachments;
    const ids = sent.map((a) => a.id);
    attachments = [];
    renderAttachments();
    inputEl.value = '';
    autoGrow();
    try {
      const extra = ids.length ? { attachments: ids } : {};
      const session = sessions.find((s) => s.id === current);
      if (
        (!current && isZeusMode()) ||
        (session?.zeus && ZEUS_ROLES.some(([role]) => !session.zeusRoles?.[role]))
      ) {
        // Older sessions may predate the model picker. Collect their picks
        // before sending the next brief too.
        const roles =
          !current && zeusDraft?.repo === selProject.value ? zeusDraft.roles : await pickZeusRoles(session);
        if (!roles) {
          // Dismissed: the brief goes back into the composer, no error.
          inputEl.value = text;
          attachments = sent;
          renderAttachments();
          return;
        }
        extra.zeusRoles = roles;
      }
      if (!current) {
        await createSession(text, extra);
        zeusDraft = null;
      } else {
        await api(`/api/dev/sessions/${current}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, ...extra }),
        });
      }
      loadSessions();
    } catch (e) {
      inputEl.value = text; // give the message back
      attachments = sent; // and its files
      renderAttachments();
      toast(e.message, true);
    }
  }

  // Keep stored/API role identifiers compatible with existing sessions: qa and
  // validator are only reachable from sessions started before the fusion
  // dropped to two proposals, and still have to read as themselves.
  function zeusAnalystLabel(role) {
    return (
      { product: 'Model 1', architecture: 'Model 2', qa: 'Model 3', validator: 'Validator' }[role] ||
      role ||
      'analyst'
    );
  }

  // The dialog a ⚡ Zeus start opens: a runtime per analyst role. Defaults to
  // the project's worker runtime when Settings names one, and to the
  // composer's own picks otherwise, which is what a spawn falls back to anyway.
  // Resolves to the two picks, or null when the dialog was dismissed. Both rows
  // read the same on purpose: the slots are indistinguishable, and the only
  // reason they are named is that the runtime is stored under a role.
  const ZEUS_ROLES = [
    ['product', 'Model 1', 'Receives the brief and proposes the complete epic on its own.'],
    ['architecture', 'Model 2', 'Receives exactly the same prompt and proposes the complete epic.'],
  ];

  async function pickZeusRoles(session) {
    const project = projects.find((p) => p.repo === selProject.value);
    const fallback =
      project && project.workerProviderId != null
        ? { providerId: project.workerProviderId, model: project.workerModel, effort: project.workerEffort }
        : { providerId: selProvider.value, model: selModel.value, effort: selEffort.value };
    const answered = openConfirm({
      title: 'Choose the fusion models',
      body: `Both models receive the same complete task, independently. ZEUS then merges their two outputs into one epic, on the session model (${session?.model || selModel.value}) — change the summarizer in the composer's model selector.`,
      confirmLabel: session ? 'Continue Zeus' : 'Use these models',
      icon: '⚡',
      form: ZEUS_ROLES.map(([role, label, hint]) => runtimePickerHtml(`zeus-${role}`, label, hint)).join(''),
    });
    const readers = ZEUS_ROLES.map(([role]) => [
      role,
      mountRuntimePicker(`zeus-${role}`, session?.zeusRoles?.[role] || fallback),
    ]);
    if (!(await answered)) return null;
    const roles = {};
    for (const [role, read] of readers) {
      const pick = read();
      if (!providerById(pick.providerId)) {
        toast('No provider is installed to run the analysts on', true);
        return null;
      }
      roles[role] = pick;
    }
    return roles;
  }

  $('btn-send').addEventListener('click', send);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 220) + 'px';
  }
  inputEl.addEventListener('input', autoGrow);

  // Both ＋ New sessions: the drawer's, and the phone bar's copy of it.
  for (const id of ['btn-new', 'btn-new-mobile']) {
    $(id).addEventListener('click', () => {
      closeDrawersOnMobile();
      showWelcome();
    });
  }

  // The review loop chip: a toggle, not an action, and it toggles whichever
  // session it is standing over. On the welcome pane that is the NEXT session
  // started from the composer; on an open one it arms or disarms the loop
  // there and then, since a task usually turns out to want reviewing only once
  // it is underway. The server runs the loop either way (review every settle
  // with new commits, feed the findings back, round after round until a review
  // finds nothing).
  //
  // The composer's own pick starts armed on every load: most tasks want their
  // work reviewed, and the chip is one tap away for the ones that do not. It
  // is a per-task decision either way, not a sticky preference.
  let reviewLoopOn = true;
  let qaLoopOn = true;
  $('btn-loop').addEventListener('click', async () => {
    const s = currentSession();
    if (!s) {
      reviewLoopOn = !reviewLoopOn;
      if (!reviewLoopOn) qaLoopOn = false;
      paintLoopChip(reviewLoopOn);
      paintQaLoopChip(qaLoopOn, reviewLoopOn);
      return;
    }
    $('btn-loop').disabled = true;
    try {
      await api(`/api/dev/sessions/${s.id}/loop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: !s.reviewLoop }),
      });
      await loadSessions(); // repaints the chip and the header's 🔁 counter
    } catch (e) {
      toast(e.message, true);
    } finally {
      $('btn-loop').disabled = false;
    }
  });

  // The QA chip follows the review chip: turning the review loop off also turns
  // this queued run off, on the welcome pane and over an open session alike.
  $('btn-qa-loop').addEventListener('click', async () => {
    const s = currentSession();
    if (!s) {
      if (!reviewLoopOn) return toast('Turn the review loop on first', true);
      qaLoopOn = !qaLoopOn;
      paintQaLoopChip(qaLoopOn, reviewLoopOn);
      return;
    }
    $('btn-qa-loop').disabled = true;
    try {
      await api(`/api/dev/sessions/${s.id}/qa-loop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: !s.qaLoop }),
      });
      await loadSessions();
    } catch (e) {
      toast(e.message, true);
    } finally {
      $('btn-qa-loop').disabled = false;
    }
  });

  // Open the tab synchronously on the click (popup blockers) and point it at
  // the served app once the server confirms php -S is up.
  $('btn-serve').addEventListener('click', async () => {
    if (!current) return;
    const w = window.open('about:blank', '_blank');
    try {
      const { url } = await api(`/api/dev/sessions/${current}/serve`, { method: 'POST' });
      if (w) w.location = url;
      else window.open(url, '_blank');
    } catch (e) {
      if (w) w.close();
      toast(e.message, true);
    }
  });

  $('btn-cancel-turn').addEventListener('click', async () => {
    if (!current) return;
    try {
      await api(`/api/dev/sessions/${current}/cancel`, { method: 'POST' });
      loadSessions();
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('btn-edit-title').addEventListener('click', async () => {
    const s = currentSession();
    if (!s) return;
    const title = await openPrompt({
      title: 'Edit session title',
      label: 'Title',
      value: s.title || '',
      rows: 2,
      confirmLabel: 'Save title',
    });
    if (title == null) return;
    try {
      const { session } = await api(`/api/dev/sessions/${s.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      const i = sessions.findIndex((x) => x.id === session.id);
      if (i !== -1) sessions[i] = session;
      renderSidebar();
      updateHead();
      toast('Session title updated');
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('btn-link-pr').addEventListener('click', async () => {
    const s = currentSession();
    if (!s) return;
    const pr = await openPrompt({
      title: 'Link a pull request',
      body: `The pull request must be in ${s.repo} and use ${s.prBranch || s.branch} as its head branch.`,
      label: 'Pull request number or URL',
      placeholder: '#70 or https://github.com/owner/repo/pull/70',
      value: s.startedOnPr ? `#${s.startedOnPr}` : '',
      rows: 2,
      confirmLabel: 'Link pull request',
    });
    if (pr == null) return;
    try {
      const { session } = await api(`/api/dev/sessions/${s.id}/link-pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pr }),
      });
      const i = sessions.findIndex((x) => x.id === session.id);
      if (i !== -1) sessions[i] = session;
      renderSidebar();
      updateHead();
      toast(`Linked PR #${session.prStatus.number}`);
    } catch (e) {
      toast(e.message, true);
    }
  });

  // ⟳ Reopen: claim a clone and a database server for this session again
  // without saying anything to the agent. The conversation picks up where it
  // stopped, and ▶ Run works again.
  $('btn-reopen').addEventListener('click', async () => {
    if (!current) return;
    try {
      await api(`/api/dev/sessions/${current}/reopen`, { method: 'POST' });
      loadSessions();
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('btn-close-session').addEventListener('click', async () => {
    if (!current) return;
    const ok = await openConfirm({
      title: 'Close this session?',
      body: 'Its workspace clone and MySQL instance are released, and any queued message is dropped. The conversation stays readable, and ⟳ Reopen brings the session back.',
      confirmLabel: 'Close session',
      icon: '⏻',
    });
    if (!ok) return;
    try {
      await api(`/api/dev/sessions/${current}/close`, { method: 'POST' });
      loadSessions();
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('btn-delete-session').addEventListener('click', async () => {
    if (!current) return;
    const ok = await openConfirm({
      title: 'Delete this conversation?',
      body: 'The conversation and its log are removed for good. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
      icon: '🗑',
    });
    if (!ok) return;
    try {
      await api(`/api/dev/sessions/${current}`, { method: 'DELETE' });
      sessions = sessions.filter((s) => s.id !== current);
      showWelcome();
    } catch (e) {
      toast(e.message, true);
    }
  });

  // ---------- project dashboard ----------
  //
  // A project's open pull requests, opened by clicking the project's name in
  // the sidebar. Each row carries the errands this app can run on a pull
  // request (code review, solve conflicts, fix failing checks, implement
  // feedback, test sheet, QA) with the one its labels ask for highlighted. The
  // highlight is a suggestion only: every errand stays clickable, so a stale
  // label never blocks the work.

  const projView = () => $('project-view');
  // Which of the project view's three panes is showing: the pull-request board,
  // the repo's open issues, or the 📊 Dashboard of this month's spend. The board
  // is the default (it is what a project name in the sidebar has always opened
  // onto) whatever order the tabs are drawn in.
  let boardTab = 'prs';
  let board = null; // the loaded board for currentProject, or null
  let boardError = null;
  let boardTimer = null;
  let boardBusy = null; // `${repo}#${number}:${action}` while it is starting
  // One pull request on its own: the board drilled into a single branch,
  // showing that PR and every session this app has run on it. Set by clicking
  // a branch in the sidebar or a row on the board.
  let boardBranch = null;
  // What the two header pickers are narrowing the list to: one author, one
  // label, either or both empty for "all". A pick belongs to the list it was
  // made on (the pull requests and the issues have their own authors and their
  // own labels) so each tab keeps its own, and stepping over to the other one
  // and back finds the picks where they were left. Switching projects drops
  // both: a name that means something on one repo means nothing on the next.
  let boardFilters = { repo: null, prs: { author: '', label: '' }, issues: { author: '', label: '' } };
  const tabOf = () => (boardTab === 'issues' ? 'issues' : 'prs');
  const boardFilter = () => boardFilters[tabOf()];

  const CHECK_ICON = {
    success: '<span class="text-ok" title="Checks passed">✓ checks</span>',
    failure: '<span class="text-danger" title="Checks failed">✗ checks</span>',
    error: '<span class="text-danger" title="Checks errored">✗ checks</span>',
    pending: '<span class="text-warn" title="Checks running">● checks</span>',
    expected: '<span class="text-warn" title="Checks expected">● checks</span>',
  };

  // A session in one of these is still working, so the board highlights the pull
  // request it is working on rather than leaving it to look like the rest.
  const WORKING_STATES = new Set(['queued', 'preparing', 'running']);

  // The errands a row offers, in the order they are shown.
  const PR_ACTIONS = [
    {
      id: 'review',
      icon: '⌕',
      label: 'Code review',
      why: 'Run the provider’s code review on this pull request and publish it',
    },
    {
      id: 'solve-conflicts',
      icon: '🔀',
      label: 'Solve conflicts',
      why: 'Merge the base branch in, resolve the conflicts and push the result',
    },
    {
      id: 'fix-checks',
      icon: '🧪',
      label: 'Fix failing checks',
      why: 'Read this pull request’s failing CI checks, fix what the branch broke and push the fixes',
    },
    {
      id: 'implement-feedback',
      icon: '🛠',
      label: 'Implement feedback',
      why: 'Address the review findings on this pull request, push the fixes, and have those changes reviewed automatically',
    },
    {
      id: 'custom-feedback',
      icon: '✍',
      label: 'Give feedback',
      why: 'Say in your own words what to change on this pull request, and it is implemented and pushed',
    },
    {
      id: 'test-sheet',
      icon: '📋',
      label: 'Test sheet',
      why: 'Derive the manual QA checklist from this pull request’s diff and post it as one editable comment',
    },
    {
      id: 'qa',
      icon: '🎬',
      label: 'QA',
      why: 'Write the test sheet for this pull request and execute it in a session of its own',
    },
    {
      id: 'pr-body-summary',
      icon: '✎',
      label: 'PR body',
      why: 'Rewrite this pull request’s description from its own diff, following the team template',
    },
    {
      id: 'delete-self-comments',
      icon: '🧹',
      label: 'Delete my comments',
      why: 'Remove every comment and review the configured GitHub account left on this pull request',
    },
  ];

  function boardProject() {
    return projects.find((p) => p.repo === currentProject) || null;
  }

  // Logins and label names are compared folded: GitHub hands the same person
  // back as `TheBot` on one pull request and `thebot` on the project's setting,
  // and two rows would otherwise offer two entries for one author.
  const fold = (v) => String(v || '').toLowerCase();

  // Which repo the picks belong to, and what each tab's author picker opens
  // on: the project's configured PR author, since whose work this dashboard
  // exists to move along has not changed, but only while they actually have
  // something open, so arriving at a board never lands on an empty list. The
  // issues open on every author: an issue's author is whoever reported it, and
  // narrowing to the bot that opens the pull requests would usually hide the lot.
  function startBoardFilter(repo) {
    if (boardFilters.repo === repo) return;
    const author = fold(board.author);
    const mine = author && board.pulls.some((p) => fold(p.author) === author);
    boardFilters = {
      repo,
      prs: { author: mine ? author : '', label: '' },
      issues: { author: '', label: '' },
    };
  }

  // Does this row survive the filters? `skip` leaves one of them out, which is
  // how each picker below counts what it would show without counting itself.
  // A row is a pull request or an issue, and both carry an author and labels, which
  // is all the two pickers ever read.
  function passesFilter(row, skip) {
    const picked = boardFilter();
    if (skip !== 'author' && picked.author && fold(row.author) !== picked.author) return false;
    if (skip !== 'label' && picked.label && !row.labels.some((l) => fold(l.name) === picked.label))
      return false;
    return true;
  }

  // What the open tab lists, before and after the pickers.
  function boardRows() {
    if (!board) return [];
    return (boardTab === 'issues' ? board.issues : board.pulls) || [];
  }

  function visibleRows() {
    return boardRows().filter((row) => passesFilter(row, null));
  }

  const filterOn = () => !!(boardFilter().author || boardFilter().label);

  // Fills both pickers from the open tab's own rows: there is no list of a
  // repo's authors or labels to fetch, and the ones with nothing open are not
  // worth offering anyway. Each option is counted against the *other* filter, so
  // the number beside a label is what picking it would actually leave on screen.
  // A pick the other filter has emptied still lists itself, at (0): a board
  // filtered down to nothing has to stay possible to widen again.
  function fillBoardFilters() {
    for (const kind of ['author', 'label']) {
      const counts = new Map(); // folded value -> { text, n }
      for (const pr of boardRows()) {
        if (!passesFilter(pr, kind)) continue;
        const carried = kind === 'author' ? (pr.author ? [pr.author] : []) : pr.labels.map((l) => l.name);
        for (const text of carried) {
          const seen = counts.get(fold(text)) || { text, n: 0 };
          seen.n += 1;
          counts.set(fold(text), seen);
        }
      }
      const picked = boardFilter()[kind];
      if (picked && !counts.has(picked)) counts.set(picked, { text: picked, n: 0 });
      const opts = [...counts].sort((a, b) => a[1].text.localeCompare(b[1].text));
      const sel = $(`proj-${kind}`);
      const html =
        `<option value="">${kind === 'author' ? 'All authors' : 'All labels'}</option>` +
        opts.map(([value, o]) => `<option value="${esc(value)}">${esc(o.text)} (${o.n})</option>`).join('');
      // The board redraws on a timer. Rewriting a `<select>` that has not
      // changed would shut the dropdown under whoever had just opened it.
      if (sel.innerHTML !== html) sel.innerHTML = html;
      sel.value = picked;
      sel.disabled = !opts.length;
    }
  }

  for (const kind of ['author', 'label']) {
    $(`proj-${kind}`).addEventListener('change', (e) => {
      boardFilters = { ...boardFilters, [tabOf()]: { ...boardFilter(), [kind]: e.target.value } };
      renderBoard();
    });
  }

  // The provider every errand on this board runs as. It starts on the one the
  // project's reviewer was set up with (Settings already answered this
  // question) and falls back to the first installed provider.
  function fillBoardProvider() {
    const project = boardProject();
    const sel = $('proj-provider');
    sel.innerHTML = providers
      .map(
        (p) =>
          `<option value="${p.id}"${p.available ? '' : ' disabled'}>${esc(p.label)}${p.available ? '' : ' (not installed)'}</option>`,
      )
      .join('');
    const preferred = project ? providerById(project.reviewProviderId) : null;
    const provider = preferred && preferred.available ? preferred : providers.find((p) => p.available);
    if (provider) sel.value = provider.id;
    fillBoardModel();
  }

  function fillBoardModel() {
    const project = boardProject();
    const provider = providerById($('proj-provider').value);
    const sel = $('proj-model');
    if (!provider) {
      sel.innerHTML = '';
      return;
    }
    sel.innerHTML = provider.models.map((m) => `<option>${esc(m)}</option>`).join('');
    const wanted =
      project && provider.models.includes(project.reviewModel) ? project.reviewModel : provider.defaultModel;
    if (wanted) sel.value = wanted;
  }

  $('proj-provider').addEventListener('change', fillBoardModel);

  // What every errand on this board runs at. There is no picker for the effort,
  // unlike the provider and the model: the project's reviewer setting answers it
  // whenever the picked provider offers that level, and its own default otherwise.
  function boardEffort(provider) {
    const project = boardProject();
    return project && provider.efforts.includes(project.reviewEffort)
      ? project.reviewEffort
      : provider.defaultEffort;
  }

  // Which label means "a review left findings nobody has answered yet", and so
  // which rows offer 🛠 Implement feedback. It is the name the workflow uses;
  // a repo that names it differently simply gets the errand on no row, which is
  // no loss: ✍ Give feedback is on every row and takes the same work by hand.
  const FEEDBACK_LABEL = 'feedback-given';

  // This month's spend on the project, shown in the board header. Fetched with
  // the board and held per repo; a failure just leaves the header without it.
  // Loads can overlap (a ⟳ over the minute refresh), so only the newest
  // request gets to speak, in success and in failure alike.
  let usage = { repo: null, totals: null };
  let usageSeq = 0;
  async function loadUsage(repo) {
    const seq = ++usageSeq;
    try {
      const data = await api(`/api/dev/usage?repo=${encodeURIComponent(repo)}`);
      if (seq !== usageSeq || currentProject !== repo) return;
      usage = { repo, totals: data };
      renderBoard();
    } catch {
      // The board header simply has no spend line; the dashboard pane says so
      // rather than sitting on a spinner until the minute refresh.
      if (seq === usageSeq && currentProject === repo && boardTab === 'dashboard' && !boardBranch)
        $('proj-list').innerHTML =
          '<div class="my-8 text-center text-sm text-muted">This month’s usage could not be read. ⟳ tries again.</div>';
    }
  }

  function usageLine(repo) {
    if (usage.repo !== repo || !usage.totals) return null;
    const u = usage.totals;
    if (!u.turns) return 'no usage this month';
    const bits = [`${u.sessions} session${u.sessions === 1 ? '' : 's'}`, `${fmtTokens(u.totalTokens)} tok`];
    if (u.durationMs) bits.push(fmtDur(u.durationMs));
    if (u.costUsd != null) bits.push(fmtCost(u));
    return `this month: ${bits.join(' · ')}`;
  }

  async function loadBoard(repo, fresh = false) {
    loadUsage(repo);
    try {
      const data = await api(`/api/dev/pulls?repo=${encodeURIComponent(repo)}${fresh ? '&fresh=1' : ''}`);
      if (currentProject !== repo) return; // switched away while loading
      board = data;
      boardError = null;
    } catch (e) {
      if (currentProject !== repo) return;
      board = null;
      boardError = e.message;
    }
    renderBoard();
  }

  function labelChips(labels) {
    return labels
      .map((l) => {
        // GitHub's own label colour, dimmed onto the dark background: the border
        // and the text carry it, nothing is filled in.
        const color = /^[0-9a-f]{6}$/i.test(l.color || '') ? `#${l.color}` : '';
        const style = color ? ` style="border-color:${color};color:${color}"` : '';
        return `<span class="rounded-full border border-line px-1.5 text-[11px] text-muted"${style}>${esc(l.name)}</span>`;
      })
      .join('');
  }

  // Who the pull request is assigned to. Most of this board's work is one
  // person's, so the usual answer is nobody or one login; a crowd is folded
  // into "+2" rather than pushing the branch name off the line.
  function assigneeChip(pr) {
    const who = pr.assignees || [];
    if (!who.length) return '<span class="text-muted/70" title="Nobody is assigned">unassigned</span>';
    const shown = who
      .slice(0, 2)
      .map((l) => `@${esc(l)}`)
      .join(', ');
    const rest = who.length > 2 ? ` +${who.length - 2}` : '';
    return `<span class="text-ink/80" title="Assigned to ${esc(who.join(', '))}">${shown}${rest}</span>`;
  }

  // Review responsibility belongs beside assignment in the list. The icon is
  // the reviewer's standing verdict; an open circle means their review is
  // still requested. Keep the visible list short and leave the complete answer
  // in the tooltip so a larger team does not crowd out the branch.
  function reviewerChip(pr) {
    const reviewers = pr.reviewers || [];
    if (!reviewers.length) return '';
    const icon = (state) =>
      state === 'approved' ? '✓' : state === 'changes_requested' ? '✗' : state === 'requested' ? '○' : '·';
    const summary = reviewers.map((r) => `${icon(r.state)} @${r.user}`).join(', ');
    const shown = reviewers
      .slice(0, 2)
      .map((r) => `${icon(r.state)} @${esc(r.user)}`)
      .join(', ');
    const rest = reviewers.length > 2 ? ` +${reviewers.length - 2}` : '';
    return `<span class="text-ink/80" title="Reviewers: ${esc(summary)}">${shown}${rest}</span>`;
  }

  // The issue the pull request closes, with the state that decides whether the
  // work on it is worth starting: an issue closed as `not_planned`, or still
  // open with `blocked` on it, is a reason to leave this pull request alone.
  const ISSUE_STATE = {
    open: '<span class="text-ok" title="The issue is still open">● open</span>',
    closed: '<span class="text-muted" title="The issue is closed">✓ closed</span>',
  };

  function issueRows(pr) {
    const issues = pr.issues || [];
    if (!issues.length) return '';
    return `<div class="mt-1.5 flex flex-col gap-1">${issues
      .map((i) => {
        const state =
          i.state === 'closed' && i.stateReason === 'not_planned'
            ? '<span class="text-warn" title="The issue was closed as not planned">✗ not planned</span>'
            : ISSUE_STATE[i.state] || '';
        return `<div class="flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
          <span class="shrink-0 text-muted/70" title="This pull request closes the issue">⧉</span>
          <a class="shrink-0 hover:text-ink hover:underline" href="${esc(i.url)}" target="_blank" rel="noopener">#${i.number}</a>
          <span class="min-w-0 truncate text-ink/80" title="${esc(i.title)}">${esc(i.title)}</span>
          <span class="shrink-0">${state}</span>
          ${i.labels.length ? `<span class="flex shrink-0 gap-1">${labelChips(i.labels)}</span>` : ''}
        </div>`;
      })
      .join('')}</div>`;
  }

  // Which errands a row is worth offering. Most of them always apply: they
  // work from the diff alone, which every pull request has, and a test sheet, a
  // QA run, a rewritten body or feedback in the developer's own words are worth
  // doing before the approval as much as after it. Only the three that answer a
  // state the pull request is actually in (conflicts, red CI, a review waiting)
  // come and go with that state.
  const hasConflicts = (pr) =>
    pr.mergeable === 'conflicting' || pr.labels.some((l) => l.name.toLowerCase() === 'has-conflicts');
  const awaitsFeedback = (pr) => pr.labels.some((l) => l.name.toLowerCase() === FEEDBACK_LABEL);
  // Red CI, and only red: `pending` is a run still going (fixing it would be
  // fixing a guess) and a pull request with no checks at all has nothing to fix.
  const checksFailed = (pr) => pr.checks === 'failure' || pr.checks === 'error';

  function prActions(pr) {
    return PR_ACTIONS.filter((a) => {
      if (a.id === 'solve-conflicts') return hasConflicts(pr);
      if (a.id === 'fix-checks') return checksFailed(pr);
      if (a.id === 'implement-feedback') return awaitsFeedback(pr);
      return true;
    });
  }

  // GitHub marks a stacked pull request in its own list with a layers icon and
  // "2/3": how deep in the stack this one sits and how tall the stack is. The
  // board copies that, and hangs the whole stack off the tooltip so the answer
  // to "what is under me?" does not need a trip to GitHub. The stack travels
  // once on the payload under its id, so every row on it quotes the same total
  // and the tooltip can show side branches at the depth they hang from.
  function stackChip(pr) {
    const stack = pr.stack;
    if (!stack) return '';
    const prs = (board && board.stacks && board.stacks[stack.id]) || [];
    // Drafts are named as such: the row they point at is on the board like any
    // other, but a stack whose bottom is still a draft cannot merge from the
    // bottom up, and that is worth reading off the tooltip.
    const chain = prs
      .map(
        (p) =>
          `${'  '.repeat(Math.max(0, p.depth - 1))}${p.depth}. #${p.number} ${p.title}${
            p.draft ? ' (draft)' : ''
          }${p.number === pr.number ? '  ← this one' : ''}`,
      )
      .join('\n');
    // The board only ever sees one page of open pull requests, and a stack
    // standing on a loop of bases is cut off at the loop. Either way the count
    // is of what is on the board, so the chip reads "2/3+" and says why rather
    // than passing a partial stack off as the whole one.
    const partial = stack.partial ? '\n\nThe rest of this stack is not on the board; it may be longer.' : '';
    const total = `${stack.total}${stack.partial ? '+' : ''}`;
    return `<span class="flex shrink-0 items-center gap-1 text-muted" title="Stacked pull request ${stack.position} of ${total}\n${esc(chain + partial)}">
      <svg viewBox="0 0 16 16" class="h-3 w-3 fill-current" aria-hidden="true"><path d="M8 1.5 1.5 5 8 8.5 14.5 5 8 1.5Zm5.1 5.6L8 9.9 2.9 7.1l-1.4.8L8 11.5l6.5-3.6-1.4-.8Zm0 3L8 12.9l-5.1-2.8-1.4.8L8 14.5l6.5-3.6-1.4-.8Z"/></svg>
      <span class="font-mono text-[11px]">${stack.position}/${total}</span>
    </span>`;
  }

  function prRow(pr) {
    const meta = [
      `<a class="hover:text-ink hover:underline" href="${esc(pr.url)}" target="_blank" rel="noopener">#${pr.number}</a>`,
      pr.draft ? '<span class="text-warn">draft</span>' : '',
      pr.mergeable === 'conflicting'
        ? '<span class="text-danger" title="This branch conflicts with its base">⚠ conflicts</span>'
        : '',
      CHECK_ICON[pr.checks] || '',
      stackChip(pr),
      assigneeChip(pr),
      reviewerChip(pr),
      pr.reviewDecision === 'approved' ? '<span class="text-ok">approved</span>' : '',
      pr.reviewDecision === 'changes_requested' ? '<span class="text-danger">changes requested</span>' : '',
      `<span class="truncate font-mono text-[11px]" title="${esc(pr.branch)} → ${esc(pr.baseBranch)}">${esc(pr.branch)}</span>`,
      `<span class="ml-auto shrink-0">${timeAgo(pr.updatedAt)}</span>`,
    ]
      .filter(Boolean)
      .join('<span class="text-line">·</span>');

    const buttons = prActions(pr)
      .map((a) => {
        const on = pr.recommended === a.id;
        const busy = boardBusy === `${board.repo}#${pr.number}:${a.id}`;
        return `<button type="button" class="pr-act btn ${on ? 'btn-primary' : ''}" data-pr="${pr.number}"
        data-branch="${esc(pr.branch)}" data-act="${a.id}" title="${esc(a.why)}"${boardBusy ? ' disabled' : ''}>${
          busy ? 'Starting…' : `${a.icon} ${esc(a.label)}`
        }</button>`;
      })
      .join('');

    // A pull request with an errand still working on it is the one worth
    // spotting from across the board, so its card carries the accent border
    // and says how many of its runs are live instead of just how many exist.
    const branchRuns = sessionsOnBranch(board.repo, pr.branch);
    const working = branchRuns.filter((s) => WORKING_STATES.has(sessionState(s))).length;

    // The card is clickable itself: anywhere but a link or a button opens the
    // pull request on its own, with its runs under it.
    const runs = boardBranch ? 0 : branchRuns.length;
    const drill = boardBranch ? '' : ' pr-open cursor-pointer hover:border-accent-dim';
    const edge = working ? ' border-accent bg-accent/5' : ' border-line';
    return `<div class="mb-2 rounded-xl border bg-raise px-3 py-2.5${edge}${drill}" data-branch="${esc(pr.branch)}"
         title="${boardBranch ? '' : 'Open this pull request and its runs'}">
        <a class="block truncate text-sm font-semibold text-ink hover:text-accent hover:underline" href="${esc(pr.url)}" target="_blank" rel="noopener">${esc(pr.title)}</a>
        <div class="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-muted">${meta}</div>
        ${pr.labels.length ? `<div class="mt-1.5 flex flex-wrap gap-1">${labelChips(pr.labels)}</div>` : ''}
        ${issueRows(pr)}
        <div class="mt-2 flex flex-wrap items-center gap-1.5">${buttons}
          ${
            working
              ? `<span class="ml-auto flex shrink-0 items-center gap-1.5 text-[12px] text-accent" title="${working} run${working === 1 ? ' is' : 's are'} working on this pull request right now"><span class="dot running"></span>${working} running${runs && !boardBranch ? ` · ${runs} run${runs === 1 ? '' : 's'} ›` : ''}</span>`
              : runs
                ? `<span class="ml-auto shrink-0 text-[12px] text-muted">${runs} run${runs === 1 ? '' : 's'} ›</span>`
                : ''
          }
        </div>
      </div>`;
  }

  // ---------- the issues pane ----------
  //
  // The repo's open issues, off the very same /api/dev/pulls payload the board
  // is drawn from, so opening this tab asks GitHub for nothing. Each row says
  // what is open, who is holding it, and whether a pull request is already
  // answering it, and carries the one errand an issue can offer: ▶ Start, which
  // puts a session on it.
  //
  // Epics are GitHub's own sub-issues, read off the parent/child link the API
  // carries rather than an `epic` label or an `[Epic]` written into a title: a
  // child is drawn nested under its parent, and the parent says how much of
  // itself is finished. What the epic's progress counts is every child GitHub
  // knows about, so it stays honest about the closed ones and the ones past
  // this walk's last page, neither of which is ever a row here.

  // The epics folded shut, keyed `${repo}#${number}` so two projects never
  // share a fold. Everything starts open: an epic is drawn to show what is
  // under it, and a list that opened collapsed would hide the rows the pickers
  // above it were just used to find.
  const collapsedEpics = new Set();
  const epicKey = (issue) => `${board.repo}#${issue.number}`;
  const isEpic = (issue) => !!(issue.subIssues && issue.subIssues.total);

  // The parent this row is nested under, out of the rows actually on screen. An
  // epic in another repository, one already closed, or one the pickers have
  // filtered away is a link on the child rather than a row to sit under, so the
  // child stays visible and still says whose work it is part of.
  function epicParent(issue, visible) {
    const parent = issue.parent;
    if (!parent || parent.number === issue.number) return null;
    if (parent.repo && board && parent.repo.toLowerCase() !== board.repo.toLowerCase()) return null;
    return visible.get(parent.number) || null;
  }

  // How much of an epic is done. GitHub counts this over every sub-issue,
  // including the closed ones and any this board never lists, which is why the
  // total is often larger than the number of rows nested underneath.
  function epicProgress(issue) {
    const { total, completed } = issue.subIssues;
    const pct = Math.round((completed / total) * 100);
    return `<span class="flex shrink-0 items-center gap-1.5" title="${completed} of ${total} sub-issue${
      total === 1 ? '' : 's'
    } closed">
        <span class="inline-block h-1 w-14 overflow-hidden rounded-full bg-sunken"><span class="block h-full rounded-full bg-accent" style="width:${pct}%"></span></span>
        <span>${completed}/${total} done</span>
      </span>`;
  }

  // What a ▶ Start session is sent. It is composed here rather than in
  // lib/prtasks.js because nothing in it belongs to a pull request: there is no
  // branch, no diff and no review thread to read, only a number the agent goes
  // and reads for itself, which is also why the wording is not a settable
  // template. The first line is what names the session in the sidebar (the
  // server titles a from-scratch session off it), so it carries the number.
  function issuePrompt(issue) {
    if (isEpic(issue)) return epicPrompt(issue);
    // A sub-issue names its epic: the parent carries the shape the child is
    // meant to fit, and reading it is usually the difference between a change
    // that lands in the design and one that has to be redone beside it.
    const under = issue.parent
      ? [
          `It is a sub-issue of ${
            issue.parent.repo && issue.parent.repo.toLowerCase() !== board.repo.toLowerCase()
              ? issue.parent.repo
              : board.repo
          }#${issue.parent.number} (${issue.parent.title}). Read that epic too, for the shape this piece has to fit; implement only this issue.`,
          '',
        ]
      : [];
    return [
      `Issue #${issue.number}: ${issue.title}`,
      '',
      `Read ${board.repo} issue #${issue.number} in full before you change anything: \`gh issue view ${issue.number} --repo ${board.repo} --comments\`. Its comments usually carry decisions the description was written before.`,
      '',
      ...under,
      'Then implement it on this session’s own branch, verify the change the way this repository verifies changes, and open a pull request whose body says ' +
        `\`Closes #${issue.number}\`, so merging it closes the issue.`,
      '',
      'If the issue is too ambiguous to implement as written, say what is missing and stop rather than guessing at it.',
    ].join('\n');
  }

  // What ▶ Start on an epic sends: the first message of a 🧭 orchestrator, not
  // of a coding session. An epic is not one task, and one session working all
  // of it on one branch is how the whole of it gets done badly at once. So the
  // orchestrator takes the sub-issues one at a time, a worker each with the
  // review loop armed, and merges each pull request once the loop approves it
  // and its checks are green, so the next worker cuts its branch from a default
  // branch that already carries the pieces before it. The row's counts are of
  // GitHub's whole set, not of what this tab drew, which is why the
  // orchestrator lists the sub-issues itself. The epic closes when the last
  // child does.
  function epicPrompt(issue) {
    const { total, open } = issue.subIssues;
    const repo = board.repo;
    return [
      `Epic #${issue.number}: ${issue.title}`,
      '',
      `You are orchestrating ${repo} epic #${issue.number}, one sub-issue at a time. Read the epic in full first: \`gh issue view ${issue.number} --repo ${repo} --comments\`. Its comments usually carry decisions the description was written before.`,
      '',
      `GitHub tracks ${total} sub-issue${total === 1 ? '' : 's'} under it, ${open} still open. List them with ` +
        `\`gh api repos/${repo}/issues/${issue.number}/sub_issues --jq '.[] | "#\\(.number) \\(.state) \\(.title)"'\` and read every open one (\`gh issue view <n> --repo ${repo} --comments\`). The work is theirs, not the epic's.`,
      '',
      'Work the open sub-issues strictly one at a time, in the order their dependencies allow (number order when nothing forces another). For each one:',
      '',
      `1. Start one worker with spawn_worker and review_loop: true, with a complete brief: read the sub-issue and the epic (for the shape the piece has to fit), implement only that sub-issue on the worker’s own branch, verify the change the way this repository verifies changes, and open a pull request whose body says \`Closes #<n>\`. Do not start the next sub-issue’s worker until this one’s pull request is merged: each piece builds on the last, and the next worker has to cut its branch from a default branch that already contains them.`,
      '',
      '2. Wait for the updates. The review loop reviews every push the worker settles with, and each round’s findings come to you first: triage them with triage_findings (fix, dismissed with a reason, or optional), judging each against the sub-issue and the epic, and only what you mark fix goes to a fix session, round after round. The code is approved when the loop converges: a round declares no findings, or leaves only ones already dismissed or optional. If the loop stalls with findings left, read them on the pull request and judge each yourself: a finding that genuinely does not apply is yours to waive (say why in a comment with `gh pr comment`); the ones that do apply go back to the worker with send_to_worker, and its push resumes the loop.',
      '',
      `3. Merge only when the code is approved AND every check on the pull request has passed (\`gh pr checks <n> --repo ${repo}\`; a failing check goes back to the worker). Merge with \`gh pr merge <n> --repo ${repo} --squash --delete-branch\`. If GitHub refuses the merge (conflicts, branch protection), tell the worker to merge the default branch in and push, or ask the user when it is a rule only they can lift.`,
      '',
      `4. Confirm the merge closed the sub-issue (\`gh issue view <n> --repo ${repo}\`), close the worker with close_worker if it is still open, and report one line: what landed, what is next. Then start the next sub-issue.`,
      '',
      'A sub-issue too ambiguous to brief, or a worker question you cannot answer from the epic, is a question for the user (an ask-user block), not a guess. The epic closes itself when its last sub-issue does; when every open sub-issue is merged, say so and stop.',
    ].join('\n');
  }

  // One issue's card. `nested` is set on a row drawn under its epic: it says so
  // in place of the "part of #75" line, which under the epic itself would be
  // saying twice what the indent already says.
  function openIssueRow(issue, { nested = false } = {}) {
    const meta = [
      `<a class="hover:text-ink hover:underline" href="${esc(issue.url)}" target="_blank" rel="noopener">#${issue.number}</a>`,
      isEpic(issue) ? epicProgress(issue) : '',
      issue.author
        ? `<span class="truncate" title="Reported by @${esc(issue.author)}">@${esc(issue.author)}</span>`
        : '',
      assigneeChip(issue),
      issue.comments
        ? `<span title="${issue.comments} comment${issue.comments === 1 ? '' : 's'}">💬 ${issue.comments}</span>`
        : '',
      issue.milestone
        ? `<span class="truncate" title="Milestone: ${esc(issue.milestone)}">◇ ${esc(issue.milestone)}</span>`
        : '',
      `<span class="ml-auto shrink-0" title="Last updated">${timeAgo(issue.updatedAt)}</span>`,
    ]
      .filter(Boolean)
      .join('<span class="text-line">·</span>');

    // The pull requests that say they close this issue, the mirror image of the
    // linked-issue lines a pull request's own row carries. An issue with one is
    // already being worked on, which is the first thing this tab is asked.
    const answering = (issue.pulls || []).length
      ? `<div class="mt-1.5 flex flex-col gap-1">${issue.pulls
          .map((p) => {
            // A pull request in another repository can close an issue here, and
            // "#4" would read as this repo's #4. Name the repo on those.
            const foreign = p.repo && board && p.repo.toLowerCase() !== board.repo.toLowerCase();
            const label = foreign ? `${p.repo}#${p.number}` : `#${p.number}`;
            return `<div class="flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
          <span class="shrink-0 text-muted/70" title="This pull request closes the issue">⧉</span>
          <a class="shrink-0 hover:text-ink hover:underline" href="${esc(p.url)}" target="_blank" rel="noopener" title="${foreign ? 'A pull request in another repository' : ''}">${esc(label)}</a>
          <span class="min-w-0 truncate text-ink/80" title="${esc(p.title)}">${esc(p.title)}</span>
          ${p.draft ? '<span class="shrink-0 text-warn">draft</span>' : ''}
        </div>`;
          })
          .join('')}</div>`
      : '';

    // The epic this row belongs to, when the epic is not the row above it: one
    // in another repository, one already closed, or one the pickers have
    // hidden. Without this such a child reads as loose work, when it is the
    // middle of somebody's plan.
    const under =
      !nested && issue.parent
        ? (() => {
            const foreign =
              issue.parent.repo && board && issue.parent.repo.toLowerCase() !== board.repo.toLowerCase();
            const label = foreign ? `${issue.parent.repo}#${issue.parent.number}` : `#${issue.parent.number}`;
            return `<div class="mt-1.5 flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
          <span class="shrink-0 text-muted/70" title="This issue is a sub-issue of another">↳</span>
          <a class="shrink-0 hover:text-ink hover:underline" href="${esc(issue.parent.url)}" target="_blank" rel="noopener" title="${foreign ? 'An epic in another repository' : 'The epic this issue is part of'}">${esc(label)}</a>
          <span class="min-w-0 truncate text-ink/80" title="${esc(issue.parent.title)}">${esc(issue.parent.title)}</span>
        </div>`;
          })()
        : '';

    // ▶ Start puts a session on the issue. It is offered on every issue, and
    // highlighted on the ones no pull request is answering yet: an issue that
    // already has one is usually being worked on, and starting a second session
    // on it is a decision rather than the obvious next click. An epic is never
    // the highlighted one either: the obvious next click on a plan is one of
    // the pieces under it, and one session for the whole of it is a decision
    // the same way a second session on an answered issue is.
    const busy = boardBusy === `${board.repo}#${issue.number}:issue`;
    const button = `<button type="button" class="issue-start btn ${
      (issue.pulls || []).length || isEpic(issue) ? '' : 'btn-primary'
    }" data-issue="${issue.number}"
        title="${
          isEpic(issue)
            ? 'Start an orchestrator that works this epic’s open sub-issues one at a time: a worker each with the review loop on, merged once the review approves it and its checks pass'
            : 'Start a session that reads this issue, implements it on a branch of its own and opens a pull request closing it'
        }"${boardBusy ? ' disabled' : ''}>${busy ? 'Starting…' : '▶ Start'}</button>`;

    // The fold sits on the title line of an epic, where the indent under it
    // starts. It is drawn even for an epic with no rows of its own on the
    // board: what it hides then is the counts, and a fold that appeared and
    // vanished as children were closed would be worse than one that folds an
    // epic onto one line.
    const shut = isEpic(issue) && collapsedEpics.has(epicKey(issue));
    const fold = isEpic(issue)
      ? `<button type="button" class="epic-toggle shrink-0 text-muted hover:text-ink" data-epic="${issue.number}"
          title="${shut ? 'Show this epic’s sub-issues' : 'Fold this epic’s sub-issues away'}">${shut ? '▸' : '▾'}</button>`
      : '';

    return `<div class="rounded-xl border ${isEpic(issue) ? 'border-line-strong' : 'border-line'} bg-raise px-3 py-2.5">
        <div class="flex min-w-0 items-center gap-1.5">
          ${fold}
          <a class="min-w-0 flex-1 truncate text-sm font-semibold text-ink hover:text-accent hover:underline" href="${esc(issue.url)}" target="_blank" rel="noopener">${esc(issue.title)}</a>
        </div>
        <div class="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-muted">${meta}</div>
        ${issue.labels.length ? `<div class="mt-1.5 flex flex-wrap gap-1">${labelChips(issue.labels)}</div>` : ''}
        ${under}
        ${answering}
        <div class="mt-2 flex flex-wrap items-center gap-1.5">${button}</div>
      </div>`;
  }

  // An issue and everything nested under it, depth-first. `drawn` is what keeps
  // a row from being drawn twice, and is also the guard on a parent link that
  // leads back into its own subtree: GitHub does not allow that, but a cycle
  // here would be an infinite recursion taking the tab down rather than one
  // odd-looking row, and the rows it leaves out are drawn flat afterwards.
  function issueGroup(issue, childrenOf, drawn, nested = false) {
    drawn.add(issue.number);
    const kids = (childrenOf.get(issue.number) || []).filter((kid) => !drawn.has(kid.number));
    const shut = isEpic(issue) && collapsedEpics.has(epicKey(issue));
    // A folded epic's children are not drawn, but they are still spoken for:
    // leaving them out of `drawn` would redraw every one of them flat below,
    // which is the opposite of folding.
    if (shut) for (const kid of kids) markDrawn(kid, childrenOf, drawn);
    const under = shut ? '' : kids.map((kid) => issueGroup(kid, childrenOf, drawn, true)).join('');
    return `<div>${openIssueRow(issue, { nested })}${
      under ? `<div class="ml-3 mt-1 flex flex-col gap-2 border-l border-line pl-3">${under}</div>` : ''
    }</div>`;
  }

  function markDrawn(issue, childrenOf, drawn) {
    if (drawn.has(issue.number)) return;
    drawn.add(issue.number);
    for (const kid of childrenOf.get(issue.number) || []) markDrawn(kid, childrenOf, drawn);
  }

  function renderIssues() {
    const project = boardProject();
    $('proj-title').textContent = project ? project.label : projectLabel(currentProject);
    const sub = [currentProject];
    if (board) startBoardFilter(currentProject);
    fillBoardFilters();
    const issues = visibleRows();
    if (board && !board.issuesError) {
      const total = (board.issues || []).length;
      sub.push(
        issues.length === total
          ? `${total} open issue${total === 1 ? '' : 's'}`
          : `${issues.length} of ${total} open issues`,
      );
      // How many already have a pull request on them: the rest is the work this
      // board has not started yet, which is what the tab exists to show.
      const answered = issues.filter((i) => (i.pulls || []).length).length;
      if (answered) sub.push(`${answered} with a pull request`);
      // The plans among them, which is how many of the rows below are headings
      // rather than work.
      const epics = issues.filter(isEpic).length;
      if (epics) sub.push(`${epics} epic${epics === 1 ? '' : 's'}`);
      // The repo has more than one board load walks. Saying so beats a count
      // that quietly stands for a longer list than it names.
      if (board.issuesTruncated) sub.push('most recently updated only');
      sub.push(`synced ${timeAgo(board.syncedAt)}`);
    }
    $('proj-sub').textContent = sub.join(' · ');

    const list = $('proj-list');
    if (boardError) {
      list.innerHTML = `<div class="rounded-lg border border-danger px-2.5 py-2 text-xs text-danger">${esc(boardError)}</div>`;
      return;
    }
    if (!board) {
      list.innerHTML = '<div class="my-8 animate-pulse text-center text-sm text-muted">Loading issues…</div>';
      return;
    }
    // The pull requests loaded and the issues did not: a token without the
    // issues permission. Saying so is the whole point: an empty list here
    // would read as a repo with nothing open.
    if (board.issuesError) {
      list.innerHTML = `<div class="my-8 text-center text-sm text-muted">GitHub would not read this repository’s issues with the configured token.
        <div class="mt-2 text-[12px]">A fine-grained token needs <span class="font-mono text-[11px] text-ink">Issues: read</span>; a classic <span class="font-mono text-[11px] text-ink">repo</span> token already has it. The pull requests are unaffected.</div>
        <div class="mt-2 text-[12px] text-danger">${esc(board.issuesError)}</div>
      </div>`;
      return;
    }
    if (!issues.length) {
      const why = [
        boardFilter().author ? `from @${esc(boardFilter().author)}` : '',
        boardFilter().label ? `labelled ${esc(boardFilter().label)}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      list.innerHTML = `<div class="my-8 text-center text-sm text-muted">No open issues${why ? ` ${why}` : ''}.${
        filterOn()
          ? '<div class="pr-unfilter mt-2 cursor-pointer text-accent hover:underline">Clear the filters</div>'
          : ''
      }</div>`;
      return;
    }
    // The rows, nested: a sub-issue is drawn under its epic instead of taking a
    // place of its own in the updated-at order, and an epic keeps the place its
    // own last update earned it. Only what survived the pickers can be a parent
    // here, so filtering to one label never resurrects the epic above a row
    // that label does not sit on; the child says which epic it belongs to
    // instead, and stays where the filter left it.
    const visible = new Map(issues.map((i) => [i.number, i]));
    const childrenOf = new Map();
    for (const issue of issues) {
      const parent = epicParent(issue, visible);
      if (!parent) continue;
      const kids = childrenOf.get(parent.number) || [];
      kids.push(issue);
      childrenOf.set(parent.number, kids);
    }
    // Under one epic, by number: the children of a plan were written in the
    // order they are meant to be done, and re-ordering them by last touch would
    // shuffle the plan every time somebody commented on one of them.
    for (const kids of childrenOf.values()) kids.sort((a, b) => a.number - b.number);

    const drawn = new Set();
    const html = issues
      .filter((issue) => !epicParent(issue, visible))
      .map((issue) => issueGroup(issue, childrenOf, drawn))
      .join('');
    // Anything the walk above could not reach is a ring of parent links, which
    // GitHub does not allow and this tab does not trust: draw those flat rather
    // than dropping them off a list that has just counted them.
    const loose = issues.filter((issue) => !drawn.has(issue.number));
    list.innerHTML = `<div class="flex flex-col gap-2">${html}${loose
      .map((issue) => `<div>${openIssueRow(issue)}</div>`)
      .join('')}</div>`;
  }

  // A provider / model / effort row for a dialog: the three picks the
  // composer's chips make, drawn from the same provider list. `prefix` keys
  // the selects' ids; mountRuntimePicker wires the row once it is in the DOM
  // and hands back a reader of the picks.
  function runtimePickerHtml(prefix, label, hint) {
    return `<div class="mt-3 first:mt-0">
        <div class="text-[13px] font-medium text-ink">${esc(label)}</div>
        <div class="mb-1.5 text-[12px] text-muted">${esc(hint)}</div>
        <div class="flex flex-wrap gap-1.5 [&_select]:max-w-[150px] [&_select]:cursor-pointer [&_select]:rounded-md [&_select]:border [&_select]:border-line [&_select]:bg-field [&_select]:px-1.5 [&_select]:py-1 [&_select]:text-[12px] [&_select]:text-ink">
          <select id="${prefix}-provider" title="Account"></select>
          <select id="${prefix}-model" title="Model"></select>
          <select id="${prefix}-effort" title="Reasoning effort"></select>
        </div>
      </div>`;
  }

  // Fills a runtime picker row with the defaults it was asked for, when the
  // provider offers them, and that provider's own otherwise; a provider that is
  // not installed gives way to the first that is. Changing the account refills
  // the model and effort lists the same way.
  function mountRuntimePicker(prefix, { providerId, model, effort } = {}) {
    const selP = $(`${prefix}-provider`);
    const selM = $(`${prefix}-model`);
    const selE = $(`${prefix}-effort`);
    selP.innerHTML = providers
      .map(
        (p) =>
          `<option value="${p.id}"${p.available ? '' : ' disabled'}>${esc(p.label)}${p.available ? '' : ' (not installed)'}</option>`,
      )
      .join('');
    const fill = () => {
      const p = providerById(selP.value);
      selM.innerHTML = p ? p.models.map((m) => `<option>${esc(m)}</option>`).join('') : '';
      selE.innerHTML = p ? p.efforts.map((e) => `<option>${esc(e)}</option>`).join('') : '';
      if (!p) return;
      selM.value = p.models.includes(model) ? model : p.defaultModel;
      selE.value = p.efforts.includes(effort) ? effort : p.defaultEffort;
    };
    const preferred = providerById(providerId);
    const provider = preferred && preferred.available ? preferred : providers.find((p) => p.available);
    if (provider) selP.value = provider.id;
    fill();
    selP.addEventListener('change', fill);
    return () => ({ providerId: selP.value, model: selM.value, effort: selE.value });
  }

  // ▶ Start: an ordinary from-scratch session on this project, whose first
  // message is the issue. It cuts its own branch (there is none to check out),
  // and it is armed with the 🔁 review loop the composer arms by default, since
  // an issue is implementation work and what it pushes is worth reviewing.
  //
  // The board stays where it is, as it does for the pull-request errands: the
  // point of this tab is starting several issues in a row, and the session is a
  // click away in the sidebar.
  async function startIssue(number) {
    if (boardBusy) return;
    const issue = (board?.issues || []).find((i) => i.number === number);
    if (!issue) return;
    const provider = providerById($('proj-provider').value);
    if (!provider) return toast('No provider is installed to run this on', true);
    // An epic is a plan, not a task: an orchestration of the whole of it is a
    // legitimate thing to want and a large thing to start by accident, when the
    // click that was meant is usually one of the rows nested underneath.
    const epic = isEpic(issue);
    // What the orchestrator and its workers run on: picked in the dialog for
    // an epic, the board's pickers otherwise.
    let runtime = {
      providerId: provider.id,
      model: $('proj-model').value || provider.defaultModel,
      effort: boardEffort(provider),
    };
    let workerRuntime = null;
    if (epic) {
      const { total, open } = issue.subIssues;
      const project = boardProject();
      const answered = openConfirm({
        title: `Start the whole of #${number}?`,
        body: `It is an epic: GitHub tracks ${total} sub-issue${total === 1 ? '' : 's'} under it, ${open} still open. A 🧭 orchestrator would take them one at a time: a worker each with the review loop on, its pull request merged once the review approves it and its checks pass, then the next. Starting a single sub-issue instead is the row under it.`,
        confirmLabel: 'Start the epic',
        icon: '🧭',
        form:
          runtimePickerHtml(
            'epic-orch',
            'Orchestrator',
            'The supervisor: it reads the epic, briefs each worker and judges what comes back, which earns a capable model.',
          ) +
          runtimePickerHtml(
            'epic-worker',
            'Workers',
            'What each sub-issue’s session runs on. Every worker turn is paid for, so routine work suits a cheaper one.',
          ),
      });
      // The orchestrator starts on the board's picks; the workers on the
      // project's worker runtime from Settings when one is set, and on the
      // orchestrator's picks otherwise (what a spawn falls back to anyway).
      const readOrchestrator = mountRuntimePicker('epic-orch', runtime);
      const readWorkers = mountRuntimePicker(
        'epic-worker',
        project && project.workerProviderId != null
          ? { providerId: project.workerProviderId, model: project.workerModel, effort: project.workerEffort }
          : runtime,
      );
      if (!(await answered)) return;
      runtime = readOrchestrator();
      workerRuntime = readWorkers();
      if (!providerById(runtime.providerId) || !providerById(workerRuntime.providerId)) {
        return toast('No provider is installed to run this on', true);
      }
    }
    // A pull request already answering the issue usually means somebody is on
    // it, and a second session would spend a run duplicating that work.
    if ((issue.pulls || []).length) {
      const ok = await openConfirm({
        title: `Start work on #${number} anyway?`,
        body: `${issue.pulls.length === 1 ? 'A pull request is' : `${issue.pulls.length} pull requests are`} already open on this issue. A session started now works from the default branch and knows nothing of what they changed.`,
        confirmLabel: 'Start it',
        icon: '▶',
      });
      if (!ok) return;
    }

    boardBusy = `${board.repo}#${number}:issue`;
    renderBoard();
    try {
      const { session } = await api('/api/dev/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: runtime.providerId,
          model: runtime.model,
          effort: runtime.effort,
          repo: board.repo,
          prompt: issuePrompt(issue),
          // An orchestrator has no pull request of its own to loop on: its
          // workers get the loop, one spawn at a time, as the prompt says.
          orchestrator: epic || undefined,
          workerRuntime: workerRuntime || undefined,
          reviewLoop: epic ? undefined : true,
        }),
      });
      sessions.unshift(session);
      loadSessions();
      toast(
        epic
          ? `Started an orchestrator on epic #${number}; the session is in the sidebar badged 🧭 orchestrator`
          : `Started on #${number}; the session is in the sidebar under “New branch”`,
      );
    } catch (err) {
      toast(err.message, true);
    } finally {
      boardBusy = null;
      if (currentProject) renderBoard();
    }
  }

  // ---------- one pull request ----------

  // The sessions this app has run on a branch, in the same grouping the sidebar
  // folds them under, newest first.
  function sessionsOnBranch(repo, branch) {
    return sessions.filter((s) => s.repo === repo && sessionBranch(s) === branch);
  }

  function runRow(s) {
    const bits = [s.provider, sessionState(s), timeAgo(s.createdAt)];
    const cost = sessionUsage(s).costUsd;
    if (cost != null) bits.push(`$${cost.toFixed(2)}`);
    return `<div class="run-row mb-1.5 flex cursor-pointer items-center gap-2 rounded-xl border border-line bg-raise px-3 py-2 hover:border-accent-dim" data-id="${s.id}"
         title="Open this conversation">
        <span class="dot ${esc(sessionState(s))}"></span>
        <span class="min-w-0 flex-1 truncate text-[13px] text-ink">${esc(s.title || '(untitled)')}</span>
        <span class="shrink-0 text-[12px] text-muted">${esc(bits.join('  ·  '))}</span>
      </div>`;
  }

  // The right-hand panel for a pull request the board is drilled into: the
  // same overview a session shows for its own PR: state, line changes, commits,
  // linked issues, review verdicts, findings and every CI check. The board's
  // row data is too thin for it (its `checks` is one rollup word), so the
  // detail is fetched on its own and cached per pull request.
  let prOverview = { key: null, at: 0, pr: null };
  const overviewAttempts = new Map(); // key -> when a fetch last started

  async function loadPrOverview(repo, number) {
    const key = `${repo}#${number}`;
    // The board re-renders on every sessions poll; one request per PR per
    // half-minute is what keeps that from becoming a request every 7 seconds.
    if (Date.now() - (overviewAttempts.get(key) || 0) < 30000) return;
    overviewAttempts.set(key, Date.now());
    try {
      const data = await api(`/api/dev/pull?repo=${encodeURIComponent(repo)}&pr=${number}`);
      prOverview = { key, at: Date.now(), pr: data.pr };
    } catch {
      // GitHub being unreachable leaves the panel as it is; the board itself
      // already reports its own load failures.
      return;
    }
    if (boardBranch && prOverview.pr && prOverview.pr.headRef === boardBranch) renderBoardPanel();
  }

  // Fills the panel from whichever pull request the board is showing, or empties
  // it when the board is back on the list.
  function renderBoardPanel() {
    const pr = boardBranch && board ? board.pulls.find((p) => p.branch === boardBranch) : null;
    if (!pr) return renderPrPanel(null);
    const key = `${currentProject}#${pr.number}`;
    if (prOverview.key !== key || Date.now() - prOverview.at > 30000)
      loadPrOverview(currentProject, pr.number);
    // Another pull request's overview must never render as this one's: until
    // the fetch lands there is nothing to show but the card itself.
    renderPrPanel(prOverview.key === key ? { repo: currentProject, prStatus: prOverview.pr } : null);
  }

  // The board drilled into one branch: the pull request's own card, and every
  // run under it. A branch with no open pull request (closed, merged, or
  // never opened one) still lists its runs.
  function renderPrView() {
    const branch = boardBranch;
    const pr = board ? board.pulls.find((p) => p.branch === branch) : null;
    const runs = sessionsOnBranch(currentProject, branch);
    $('proj-title').textContent = pr ? `[#${pr.number}] ${pr.title}` : branch;
    $('proj-sub').textContent = [
      projectLabel(currentProject),
      branch,
      `${runs.length} run${runs.length === 1 ? '' : 's'}`,
      board ? `synced ${timeAgo(board.syncedAt)}` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    const back = `<div class="pr-back mb-2 flex cursor-pointer select-none items-center gap-1.5 rounded-lg px-1 py-1 text-[12px] text-muted hover:text-ink"
           title="Back to the pull request list"><span class="text-[13px]">‹</span><span>All pull requests</span></div>`;
    const card = pr
      ? prRow(pr)
      : board
        ? `<div class="mb-2 rounded-xl border border-line bg-raise px-3 py-2.5 text-[12px] text-muted">No open pull request on <span class="font-mono text-[11px]">${esc(branch)}</span>.</div>`
        : '<div class="mb-2 animate-pulse text-[12px] text-muted">Loading the pull request…</div>';
    const list = runs.length
      ? runs.map(runRow).join('')
      : '<div class="text-[12px] text-muted">Nothing has been run on this branch yet.</div>';
    $('proj-list').innerHTML = `${back}${card}
      <div class="mt-3.5 mb-1.5 text-[12px] tracking-wide text-muted">Runs (${runs.length})</div>
      ${list}`;
    renderBoardPanel();
  }

  // ---------- the dashboard pane ----------
  //
  // This month's spend, from the same /api/dev/usage payload the board header
  // quotes one line of: a row of headline tiles, tokens per day as a bar chart,
  // and the per-model breakdown. All of it is the calendar month, the window
  // the ledger endpoint serves.

  function fmtCost(u) {
    if (u.costUsd == null) return null;
    // Two marks, both the board header's: `~` says some of the turns in the
    // total were priced from published list prices rather than by their own
    // CLI, `+` that some carry no price at all. A total can wear both.
    return `${u.estimatedTurns ? '~' : ''}$${u.costUsd.toFixed(2)}${u.unpricedTurns ? '+' : ''}`;
  }

  // What the marks mean, in words: the tooltip on every cost cell and the line
  // under the Cost tile. Said the same way everywhere so `~` and `+` only ever
  // have to be explained once.
  function costNote(u) {
    const bits = [];
    if (u.estimatedTurns)
      bits.push(
        `${u.estimatedTurns} of ${u.turns} turn${u.turns === 1 ? '' : 's'} estimated from list prices`,
      );
    if (u.unpricedTurns)
      bits.push(`${u.unpricedTurns} turn${u.unpricedTurns === 1 ? '' : 's'} could not be priced at all`);
    if (bits.length) return bits.join(' · ');
    return u.costUsd == null ? 'no turn reported a price' : 'as the providers priced it';
  }

  function statTile(label, value, sub) {
    return `<div class="rounded-xl border border-line bg-raise px-3.5 py-3">
        <div class="text-[12px] tracking-wide text-muted">${label}</div>
        <div class="mt-1 text-[22px] font-semibold text-ink">${value}</div>
        <div class="mt-0.5 min-h-4 text-[12px] text-muted">${sub || ''}</div>
      </div>`;
  }

  // A bucket's "YYYY-MM-DD" or "YYYY-MM", formatted for a label. Built from the
  // string's own parts, never by parsing it into a Date from the string:
  // date-only ISO parses as UTC midnight and would shift the calendar day in
  // western zones.
  function fmtBucket(key, unit) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d || 1).toLocaleDateString(
      [],
      unit === 'month' ? { month: 'short', year: 'numeric' } : { month: 'short', day: 'numeric' },
    );
  }

  // Tokens per bucket, one accent-hued column each. Tokens rather than cost:
  // every turn carries tokens, while a month of unpriced turns would chart as
  // empty. Cost still rides along in each column's tooltip.
  //
  // `unit` is what the payload bucketed on (days over a month, months over the
  // whole history) and decides how a key reads and how dense the axis is. One
  // hue throughout: the columns encode magnitude, not identity, so a second
  // colour would only claim a distinction the data does not have.
  function bucketChart(buckets, { unit = 'day', today = '', title = 'Tokens per day' } = {}) {
    const max = Math.max(0, ...buckets.map((b) => b.totalTokens));
    if (!buckets.length || !max) return '';
    // "Has not happened yet" is the server's calendar, the one the buckets are
    // cut on: its `today`, not this browser's clock in whatever zone it is in.
    const ahead = unit === 'month' ? String(today).slice(0, 7) : String(today);
    const future = (b) => ahead && b.date > ahead;
    // A label under every nth column keeps the axis readable without one per
    // bar; the trailing flex-1 runs keep them under their columns.
    const every = unit === 'month' ? (buckets.length > 12 ? 3 : 1) : 7;
    const cols = buckets
      .map((b) => {
        if (future(b)) return '';
        const h = b.totalTokens ? Math.max(3, Math.round((b.totalTokens / max) * 100)) : 0;
        const spent = [
          `${fmtTokens(b.totalTokens)} tok`,
          `${b.turns} turn${b.turns === 1 ? '' : 's'}`,
          // fmtCost carries the `+` for a bucket whose turns were not all priced.
          fmtCost(b) || '',
        ]
          .filter(Boolean)
          .join(' · ');
        const tip = `${fmtBucket(b.date, unit)}: ${b.turns ? spent : 'no usage'}`;
        return `<div class="group flex h-full min-w-0 flex-1 flex-col justify-end" title="${esc(tip)}">
            <div class="rounded-t-[4px] bg-accent/75 group-hover:bg-accent" style="height:${h}%"></div>
          </div>`;
      })
      .join('');
    const labels = buckets
      .map((b, i) => {
        if (future(b)) return '';
        return `<div class="min-w-0 flex-1 overflow-visible whitespace-nowrap">${
          i % every === 0 ? fmtBucket(b.date, unit) : ''
        }</div>`;
      })
      .join('');
    return `<div class="mt-3 rounded-xl border border-line bg-raise px-3.5 py-3">
        <div class="text-[12px] tracking-wide text-muted">${esc(title)}</div>
        <div class="mt-2.5 flex h-28 items-end gap-[2px]">${cols}</div>
        <div class="mt-1 flex gap-[2px] text-[11px] text-muted">${labels}</div>
      </div>`;
  }

  const dailyChart = (u) => bucketChart(u.daily || [], { unit: 'day', today: u.today });

  function modelTable(u) {
    const models = u.models || [];
    if (!models.length) return '';
    const rows = models
      .map((m) => {
        return `<tr class="border-t border-line">
          <td class="max-w-[220px] truncate py-1.5 pr-3 font-mono text-[12px] text-ink" title="${esc(m.model || '')}">${esc(m.model || 'unknown')}</td>
          <td class="py-1.5 pr-3 text-muted">${esc(m.provider || '—')}</td>
          <td class="py-1.5 pr-3 text-right">${m.sessions}</td>
          <td class="py-1.5 pr-3 text-right">${m.turns}</td>
          <td class="py-1.5 pr-3 text-right" title="${m.inputTokens.toLocaleString()} in · ${m.outputTokens.toLocaleString()} out">${fmtTokens(m.inputTokens)} / ${fmtTokens(m.outputTokens)}</td>
          <td class="py-1.5 pr-3 text-right">${m.durationMs ? fmtDur(m.durationMs) : '—'}</td>
          <td class="py-1.5 text-right" title="${esc(costNote(m))}">${fmtCost(m) || '—'}</td>
        </tr>`;
      })
      .join('');
    return `<div class="mt-3 overflow-x-auto rounded-xl border border-line bg-raise px-3.5 py-3">
        <div class="text-[12px] tracking-wide text-muted">By model</div>
        <table class="mt-1.5 w-full border-collapse text-[13px]">
          <thead><tr class="text-[11px] tracking-wide text-muted">
            <th class="py-1 pr-3 text-left font-normal">Model</th>
            <th class="py-1 pr-3 text-left font-normal">Provider</th>
            <th class="py-1 pr-3 text-right font-normal">Sessions</th>
            <th class="py-1 pr-3 text-right font-normal">Turns</th>
            <th class="py-1 pr-3 text-right font-normal">Tokens in / out</th>
            <th class="py-1 pr-3 text-right font-normal">Time</th>
            <th class="py-1 text-right font-normal">Cost</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  // What each ledger activity id is called on screen. The action ids wear the
  // ⚡ Actions menu's own icon and wording so the table reads as the menu the
  // money was spent from; the derived kinds get the mark of the button that
  // starts them. An id this map does not know shows as itself rather than
  // being folded into "other".
  const ACTIVITY_LABELS = {
    chat: '💬 Chat',
    'code-review': '⌕ Code review',
    qa: '🔍 QA',
    orchestrator: '🧭 Orchestrator',
    worker: '👷 Worker',
    zeus: '⚡ Zeus',
    analyst: '🔬 Analyst',
    'pr-body-summary': '✎ PR body summary',
    'test-sheet': '📋 Test sheet',
    'test-run': '🎬 Test run',
    'solve-conflicts': '🔀 Solve conflicts',
    'fix-checks': '🧪 Fix failing checks',
    'implement-feedback': '🛠 Implement feedback',
    'custom-feedback': '✍ Give feedback',
    'delete-self-comments': '🧹 Delete my comments',
  };

  // Where the money went, by the kind of work it bought: biggest spender
  // first, the server's ordering. A null activity is a turn written before the
  // ledger recorded one, said plainly rather than guessed at.
  function activityTable(u) {
    const activities = u.activities || [];
    if (!activities.length) return '';
    const rows = activities
      .map((a) => {
        const name = a.activity
          ? esc(ACTIVITY_LABELS[a.activity] || a.activity)
          : `<span class="text-muted" title="Turns recorded before the ledger tracked what kind of work they were">Unattributed</span>`;
        return `<tr class="border-t border-line">
          <td class="max-w-[220px] truncate py-1.5 pr-3 text-ink">${name}</td>
          <td class="py-1.5 pr-3 text-right">${a.sessions}</td>
          <td class="py-1.5 pr-3 text-right">${a.turns}</td>
          <td class="py-1.5 pr-3 text-right" title="${a.inputTokens.toLocaleString()} in · ${a.outputTokens.toLocaleString()} out">${fmtTokens(a.inputTokens)} / ${fmtTokens(a.outputTokens)}</td>
          <td class="py-1.5 pr-3 text-right">${a.durationMs ? fmtDur(a.durationMs) : '—'}</td>
          <td class="py-1.5 text-right" title="${esc(costNote(a))}">${fmtCost(a) || '—'}</td>
        </tr>`;
      })
      .join('');
    return `<div class="mt-3 overflow-x-auto rounded-xl border border-line bg-raise px-3.5 py-3">
        <div class="text-[12px] tracking-wide text-muted">By activity</div>
        <table class="mt-1.5 w-full border-collapse text-[13px]">
          <thead><tr class="text-[11px] tracking-wide text-muted">
            <th class="py-1 pr-3 text-left font-normal">Activity</th>
            <th class="py-1 pr-3 text-right font-normal">Sessions</th>
            <th class="py-1 pr-3 text-right font-normal">Turns</th>
            <th class="py-1 pr-3 text-right font-normal">Tokens in / out</th>
            <th class="py-1 pr-3 text-right font-normal">Time</th>
            <th class="py-1 text-right font-normal">Cost</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function renderDashboard() {
    const project = boardProject();
    $('proj-title').textContent = project ? project.label : projectLabel(currentProject);
    const u = usage.repo === currentProject ? usage.totals : null;
    // The month named is the server's window; near a month boundary this
    // browser's clock can be on the neighboring month. Until the payload lands
    // the browser's own month stands in, and the line corrects itself then.
    const [my, mm] =
      u && u.today ? u.today.split('-').map(Number) : [new Date().getFullYear(), new Date().getMonth() + 1];
    const monthName = new Date(my, mm - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
    $('proj-sub').textContent = [currentProject, monthName].join(' · ');
    const list = $('proj-list');
    if (!u) {
      list.innerHTML =
        '<div class="my-8 animate-pulse text-center text-sm text-muted">Loading this month’s usage…</div>';
      return;
    }
    if (!u.turns) {
      list.innerHTML = `<div class="my-8 text-center text-sm text-muted">No usage on ${esc(currentProject)} in ${esc(monthName)} yet.</div>`;
      return;
    }
    const tiles = [
      statTile('Cost', fmtCost(u) || '—', costNote(u)),
      statTile(
        'Tokens',
        fmtTokens(u.totalTokens),
        `${fmtTokens(u.inputTokens)} in · ${fmtTokens(u.outputTokens)} out`,
      ),
      statTile('Sessions', String(u.sessions), `${u.turns} turn${u.turns === 1 ? '' : 's'}`),
      statTile('Agent time', u.durationMs ? fmtDur(u.durationMs) : '—', 'summed over every turn'),
    ].join('');
    list.innerHTML = `<div class="grid grid-cols-2 gap-2 lg:grid-cols-4">${tiles}</div>
      ${dailyChart(u)}
      ${activityTable(u)}
      ${modelTable(u)}`;
  }

  function renderBoard() {
    // Drilled into one pull request there is one row and nothing to narrow nor
    // a pane to switch, so the pickers and the tab bar go with the list.
    const dash = boardTab === 'dashboard' && !boardBranch;
    const issues = boardTab === 'issues' && !boardBranch;
    $('proj-tabs').classList.toggle('hidden', !!boardBranch);
    for (const el of document.querySelectorAll('.proj-tab')) {
      const on = el.dataset.tab === boardTab;
      el.classList.toggle('border-accent', on);
      el.classList.toggle('text-ink', on);
      el.classList.toggle('border-transparent', !on);
      el.classList.toggle('text-muted', !on);
    }
    for (const el of document.querySelectorAll('.proj-filter'))
      el.classList.toggle('hidden', !!boardBranch || dash);
    // The provider and model pickers speak for the board's errands, and the
    // issues have one of their own (▶ Start), so they only step aside on the
    // dashboard, which starts nothing.
    $('proj-provider').classList.toggle('hidden', dash);
    $('proj-model').classList.toggle('hidden', dash);
    $('proj-refresh').title = dash
      ? 'Read this month’s usage again'
      : issues
        ? 'Read the issues from GitHub again'
        : 'Read the pull requests from GitHub again';
    if (boardBranch) return renderPrView();
    if (dash) {
      renderPrPanel(null);
      return renderDashboard();
    }
    if (issues) {
      renderPrPanel(null); // the list has no one pull request to overview
      return renderIssues();
    }
    renderPrPanel(null); // the list has no one pull request to overview
    const project = boardProject();
    $('proj-title').textContent = project ? project.label : projectLabel(currentProject);
    const sub = [currentProject];
    if (board) startBoardFilter(currentProject);
    fillBoardFilters();
    // Every open pull request the two pickers leave, drafts included: a draft
    // is still work in flight, and hiding it only left the reader wondering why
    // a branch they had just pushed was nowhere on the list.
    const pulls = visibleRows();
    if (board) {
      const total = board.pulls.length;
      // "12 open pull requests" until something is filtered out, and then how
      // much of the board is being hidden: a count that quietly shrank is how
      // a forgotten filter turns into a pull request nobody looked at.
      sub.push(
        pulls.length === total
          ? `${total} open pull request${total === 1 ? '' : 's'}`
          : `${pulls.length} of ${total} open pull requests`,
      );
      const drafts = pulls.filter((p) => p.draft).length;
      if (drafts) sub.push(`${drafts} draft${drafts === 1 ? '' : 's'}`);
      sub.push(`synced ${timeAgo(board.syncedAt)}`);
    }
    const spend = usageLine(currentProject);
    if (spend) sub.push(spend);
    $('proj-sub').textContent = sub.join(' · ');

    const list = $('proj-list');
    if (boardError) {
      list.innerHTML = `<div class="rounded-lg border border-danger px-2.5 py-2 text-xs text-danger">${esc(boardError)}</div>`;
      return;
    }
    if (!board) {
      list.innerHTML =
        '<div class="my-8 animate-pulse text-center text-sm text-muted">Loading pull requests…</div>';
      return;
    }
    if (!pulls.length) {
      // Which of the pickers emptied it, and a way out that is not hunting for
      // the two "All" entries, since the repo having nothing open at all reads the
      // same otherwise.
      const why = [
        boardFilter().author ? `from @${esc(boardFilter().author)}` : '',
        boardFilter().label ? `labelled ${esc(boardFilter().label)}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      list.innerHTML = `<div class="my-8 text-center text-sm text-muted">No open pull requests${why ? ` ${why}` : ''}.${
        filterOn()
          ? '<div class="pr-unfilter mt-2 cursor-pointer text-accent hover:underline">Clear the filters</div>'
          : ''
      }</div>`;
      return;
    }
    list.innerHTML = pulls.map(prRow).join('');
  }

  $('proj-refresh').addEventListener('click', () => {
    if (!currentProject) return;
    // On the dashboard the button refreshes what the dashboard shows: the
    // ledger, not GitHub.
    if (boardTab === 'dashboard' && !boardBranch) {
      usage = { repo: null, totals: null };
      renderBoard();
      loadUsage(currentProject);
      return;
    }
    board = null;
    renderBoard();
    loadBoard(currentProject, true);
  });

  for (const btn of document.querySelectorAll('.proj-tab')) {
    btn.addEventListener('click', () => {
      if (!currentProject) return;
      if (btn.dataset.tab === 'dashboard') openDashboard(currentProject);
      else if (btn.dataset.tab === 'issues') openIssues(currentProject);
      else openPullRequest(currentProject, null);
    });
  }

  // Start one of the row's errands. Code review and QA are sessions of their
  // own kind on the pull request's branch; the rest are ⚡ Actions the server
  // has the prompt for. Either way
  // the board stays where it is: the run appears under its pull request, so
  // firing off a second errand is another click rather than a trip back out of
  // a conversation nobody asked to read yet.
  $('proj-list').addEventListener('click', async (e) => {
    if (e.target.closest('.pr-back')) {
      openPullRequest(currentProject, null);
      return;
    }
    if (e.target.closest('.pr-unfilter')) {
      boardFilters = { ...boardFilters, repo: currentProject, [tabOf()]: { author: '', label: '' } };
      renderBoard();
      return;
    }
    const run = e.target.closest('.run-row');
    if (run) {
      openSession(run.dataset.id);
      return;
    }
    // Folding an epic is a view state of this tab, not a trip to the server:
    // the rows are already loaded, and the list redraws where it is.
    const fold = e.target.closest('.epic-toggle');
    if (fold) {
      const key = `${board.repo}#${fold.dataset.epic}`;
      if (collapsedEpics.has(key)) collapsedEpics.delete(key);
      else collapsedEpics.add(key);
      renderIssues();
      return;
    }
    const start = e.target.closest('.issue-start');
    if (start) {
      await startIssue(Number(start.dataset.issue));
      return;
    }
    const btn = e.target.closest('.pr-act');
    // Anywhere on a card that is not one of its own controls drills into the
    // pull request, since its runs live there.
    if (!btn) {
      const card = e.target.closest('.pr-open');
      if (card && !e.target.closest('a') && !boardBranch)
        openPullRequest(currentProject, card.dataset.branch);
      return;
    }
    if (boardBusy) return;
    const provider = providerById($('proj-provider').value);
    if (!provider) return toast('No provider is installed to run this on', true);
    const prNumber = Number(btn.dataset.pr);
    const act = btn.dataset.act;

    // An action that asks something (✍ Give feedback) asks it here, before the
    // row goes busy: the answer is the errand, so backing out of the question
    // backs out of the run and leaves the board as it was.
    // The action list carries the question; on a page where it failed to load
    // at boot, ask for it again rather than starting an errand with no answer.
    if (!actions.length) await loadActions().catch(() => {});
    const action = actions.find((a) => a.id === act);
    let input = '';
    if (action && action.input) {
      input = await openPrompt({
        title: `${action.icon || '⚡'} ${action.label} · #${prNumber}`,
        body: `${board.repo}: what you type is sent to the session verbatim. It reads the pull request, makes the change, verifies it and pushes to ${btn.dataset.branch}.`,
        label: action.input.label,
        placeholder: action.input.placeholder || '',
        confirmLabel: 'Start session',
      });
      if (!input) return;
    }
    // 🧹 Delete my comments cannot be undone on GitHub, so the board asks once
    // before spending a session on it.
    if (act === 'delete-self-comments') {
      const ok = await openConfirm({
        title: `Delete your comments on #${prNumber}?`,
        body: 'Every comment and review the configured GitHub account left on this pull request is removed. Nobody else’s is touched, but this cannot be undone.',
        confirmLabel: 'Delete them',
        danger: true,
        icon: '🧹',
      });
      if (!ok) return;
    }

    boardBusy = `${board.repo}#${prNumber}:${act}`;
    renderBoard();
    try {
      const model = $('proj-model').value || provider.defaultModel;
      const effort = boardEffort(provider);
      const { session } =
        act === 'review' || act === 'qa'
          ? await api('/api/dev/sessions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                provider: provider.id,
                model,
                effort,
                repo: board.repo,
                branch: btn.dataset.branch,
                prNumber,
                ...(act === 'qa' ? { qa: true } : { review: true }),
              }),
            })
          : await api('/api/dev/actions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: act,
                repo: board.repo,
                prNumber,
                provider: provider.id,
                model,
                effort,
                input,
              }),
            });
      // Straight into the local list so the card counts the run on this
      // render, without waiting for the poll to bring it back.
      sessions.unshift(session);
      loadSessions();
      const label = PR_ACTIONS.find((a) => a.id === act)?.label || act;
      toast(`${label} started on #${prNumber}; it is under the pull request`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      boardBusy = null;
      if (currentProject) renderBoard();
    }
  });

  // ---------- the main dashboard ----------
  //
  // Every project's spend in one pane, opened by 📊 beside ＋ New session. It
  // reads the same per-turn ledger a project's own 📊 Dashboard does, with no
  // project filter on it, which is why the numbers here outlive both a deleted
  // conversation and a project dropped from Settings: the ledger is written
  // beside the session record rather than under it, and a project nothing
  // claims any more keeps its turns under the repository they name.

  const HOME_PERIOD_KEY = 'dev.usagePeriod';
  let homeOpen = false;
  let homePeriod = localStorage.getItem(HOME_PERIOD_KEY) || 'month';
  let homeUsage = { period: null, data: null };
  let homeError = null;
  let homeSeq = 0;
  let homeTimer = null;
  let homeTicks = 0;

  async function loadHomeUsage() {
    const seq = ++homeSeq;
    const period = homePeriod;
    try {
      const data = await api(`/api/dev/usage/all?period=${encodeURIComponent(period)}`);
      if (seq !== homeSeq) return; // a newer pick is already on its way
      homeUsage = { period, data };
      homeError = null;
    } catch (e) {
      if (seq !== homeSeq) return;
      homeError = e.message;
    }
    if (homeOpen) renderHome();
  }

  // What the window is called. The month comes off the payload as a "YYYY-MM"
  // the server cut on its own calendar; reading `from` back through this
  // browser's getters would land a zone west of the server on the month before,
  // and label August's totals July. Only the wording is done here.
  function homeWindowName(u) {
    if (!u) return '';
    if (!u.month) return 'all time';
    const [y, m] = u.month.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
  }

  // One row per project, biggest token spender first. The bar is a share of the
  // busiest project: magnitude, so one hue, and the number beside it is what
  // is actually being read; the bar only says how the projects rank at a glance.
  function projectTable(u) {
    const rows = u.projects || [];
    if (!rows.length) return '';
    const max = Math.max(1, ...rows.map((p) => p.totalTokens));
    const body = rows
      .map((p) => {
        const width = Math.round((p.totalTokens / max) * 100);
        // A project no longer in Settings still has to add up into the totals
        // above, so it keeps its row and says why it is greyed out.
        const name = p.gone
          ? `<span class="text-muted" title="No project in Settings owns ${esc(p.repo || 'these turns')} any more, and its history is still counted here">${esc(p.label)} <span class="text-[11px]">(removed)</span></span>`
          : `<span class="text-ink" title="${esc(p.repo || '')}">${esc(p.label)}</span>`;
        return `<tr class="border-t border-line${p.turns ? '' : ' text-muted'}">
          <td class="max-w-[200px] truncate py-1.5 pr-3">${name}</td>
          <td class="py-1.5 pr-3 text-right">${p.sessions}</td>
          <td class="py-1.5 pr-3 text-right">${p.turns}</td>
          <td class="py-1.5 pr-3 text-right" title="${p.inputTokens.toLocaleString()} in · ${p.outputTokens.toLocaleString()} out">${fmtTokens(p.inputTokens)} / ${fmtTokens(p.outputTokens)}</td>
          <td class="w-[26%] py-1.5 pr-3">
            <div class="flex items-center gap-2">
              <div class="h-1.5 min-w-0 flex-1 rounded-full bg-sunken">
                <div class="h-full rounded-full bg-accent/75" style="width:${width}%"></div>
              </div>
              <span class="shrink-0 tabular-nums">${fmtTokens(p.totalTokens)}</span>
            </div>
          </td>
          <td class="py-1.5 pr-3 text-right">${p.durationMs ? fmtDur(p.durationMs) : '—'}</td>
          <td class="py-1.5 text-right" title="${esc(costNote(p))}">${fmtCost(p) || '—'}</td>
        </tr>`;
      })
      .join('');
    return `<div class="mt-3 overflow-x-auto rounded-xl border border-line bg-raise px-3.5 py-3">
        <div class="text-[12px] tracking-wide text-muted">By project</div>
        <table class="mt-1.5 w-full border-collapse text-[13px]">
          <thead><tr class="text-[11px] tracking-wide text-muted">
            <th class="py-1 pr-3 text-left font-normal">Project</th>
            <th class="py-1 pr-3 text-right font-normal">Sessions</th>
            <th class="py-1 pr-3 text-right font-normal">Turns</th>
            <th class="py-1 pr-3 text-right font-normal">Tokens in / out</th>
            <th class="py-1 pr-3 text-left font-normal">Total tokens</th>
            <th class="py-1 pr-3 text-right font-normal">Time</th>
            <th class="py-1 text-right font-normal">Cost</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  }

  function renderHome() {
    const u = homeUsage.period === homePeriod ? homeUsage.data : null;
    $('home-period').value = homePeriod;
    const list = $('home-list');
    if (homeError && !u) {
      $('home-sub').textContent = '';
      list.innerHTML = `<div class="rounded-lg border border-danger px-2.5 py-2 text-xs text-danger">${esc(homeError)}</div>`;
      return;
    }
    if (!u) {
      $('home-sub').textContent = '';
      list.innerHTML =
        '<div class="my-8 animate-pulse text-center text-sm text-muted">Loading the usage ledger…</div>';
      return;
    }
    const over = homeWindowName(u);
    // The count is of projects that actually spent something, not of the rows
    // below: every configured project has a row, including the quiet ones.
    const active = (u.projects || []).filter((p) => p.turns).length;
    $('home-sub').textContent = [
      over,
      `${active} project${active === 1 ? '' : 's'} with usage`,
      `${u.turns} turn${u.turns === 1 ? '' : 's'}`,
    ].join(' · ');
    // An empty window still lists the projects, at zero. The tiles and the
    // chart are dropped (a row of dashes over an empty plot says nothing the
    // sentence does not) but "which projects ran nothing?" is the one question
    // left worth answering here, and it is the one projectBreakdown keeps those
    // rows for.
    if (!u.turns) {
      list.innerHTML = `<div class="my-8 text-center text-sm text-muted">No usage recorded in ${esc(over)}.</div>${projectTable(u)}`;
      return;
    }
    const tiles = [
      statTile('Cost', fmtCost(u) || '—', costNote(u)),
      statTile(
        'Tokens',
        fmtTokens(u.totalTokens),
        `${fmtTokens(u.inputTokens)} in · ${fmtTokens(u.outputTokens)} out`,
      ),
      statTile('Sessions', String(u.sessions), `${u.turns} turn${u.turns === 1 ? '' : 's'}`),
      statTile('Agent time', u.durationMs ? fmtDur(u.durationMs) : '—', 'summed over every turn'),
    ].join('');
    list.innerHTML = `<div class="grid grid-cols-2 gap-2 lg:grid-cols-4">${tiles}</div>
      ${bucketChart(u.buckets || [], {
        unit: u.unit,
        today: u.today,
        title: u.unit === 'month' ? 'Tokens per month' : 'Tokens per day',
      })}
      ${projectTable(u)}
      ${activityTable(u)}
      ${modelTable(u)}`;
  }

  $('home-period').addEventListener('change', (e) => {
    homePeriod = e.target.value;
    localStorage.setItem(HOME_PERIOD_KEY, homePeriod);
    renderHome(); // straight to the loader: the pane must not read as the old window's
    loadHomeUsage();
  });

  $('home-refresh').addEventListener('click', () => {
    homeUsage = { period: null, data: null };
    homeError = null;
    renderHome();
    loadHomeUsage();
  });

  $('btn-home').addEventListener('click', () => openHome());

  // The 📊 button is the only thing on screen saying this pane is the one open:
  // the sidebar's rows all belong to the views beside it.
  function paintHomeButton() {
    $('btn-home').classList.toggle('border-accent', homeOpen);
    $('btn-home').classList.toggle('text-accent', homeOpen);
  }

  function closeHomeView() {
    if (!homeOpen) return;
    homeOpen = false;
    paintHomeButton();
    if (homeTimer) {
      clearInterval(homeTimer);
      homeTimer = null;
    }
    $('home-view').classList.add('hidden');
    $('chat-scroll').classList.remove('hidden');
    $('composer-wrap').classList.remove('hidden');
  }

  // The main dashboard in the main pane. Like a project board it takes the pane
  // over from the composer, since there is nothing to type here, and the window
  // picker is the only control it has.
  function openHome() {
    closeDrawersOnMobile();
    if (homeOpen) return;
    showWelcome(); // drops any open session or project board, and unlocks the chips
    homeOpen = true;
    paintHomeButton();
    $('welcome').classList.add('hidden');
    $('chat-scroll').classList.add('hidden');
    $('composer-wrap').classList.add('hidden');
    $('home-view').classList.remove('hidden');
    syncPath();
    renderHome();
    // A window already loaded is shown as it stands and refreshed underneath;
    // reopening the pane should not blank it back to a spinner.
    loadHomeUsage();
    // Every window is re-read on the timer, including the two that look like
    // settled history. Their *data* is settled; which months they mean is not:
    // the server recuts the window on each request, so a tab left open across
    // midnight on the 1st rolls over on a tick rather than sitting on the
    // window it was opened in, wearing a label for the one it is not.
    //
    // The two month windows cost the same whatever the ledger has grown to:
    // they are bounded, and `turn_usage_at` seeks straight to them. All time is
    // the one unbounded read, so it goes at a fifth of the cadence: it moves by
    // a rounding error over a minute, and re-transferring the whole ledger that
    // often is what the index cannot help with.
    homeTicks = 0;
    homeTimer = setInterval(() => {
      homeTicks += 1;
      if (homePeriod !== 'all' || homeTicks % 5 === 0) loadHomeUsage();
    }, 60000);
  }

  // ---------- 🏝 the office ----------
  //
  // A resort over the water: one bungalow on stilts per enabled project, a
  // café deck at the end of the boardwalk, villas for the orchestrators, and
  // one character per open session. Everything a Claude Code hook
  // would have to reconstruct from the outside — which project a session
  // belongs to, whether its turn is running, which sub-agents it has in
  // flight — the server already knows, so this reads its records and nothing
  // has to be installed into ~/.claude to make it move.
  //
  // This side decides what is true: the projects, the crowd, what each
  // session is doing and the line its bubble says. public/island3d.js draws
  // it, in three.js, and is imported the first time the office opens so
  // nobody who never opens it pays for a renderer.

  let officeOpen = false;
  let officeEs = null;
  let office = null; // the scene, once island3d.js has loaded
  let officeLoading = null;
  let officeSound = false;
  const officeCards = new Map(); // session id -> the live card off the office stream

  // The hour the resort is lit for. The reference office this view borrows its
  // lighting from runs a day cycle of its own; here it is the reader's clock,
  // so an office opened at two in the morning does not look like one at noon.
  // Named rather than numeric because the tint is faint on purpose and the
  // header has to be able to say which of them it is.
  function officePhase(hour) {
    if (hour < 6) return 'night';
    if (hour < 8) return 'dawn';
    if (hour < 12) return 'morning';
    if (hour < 17) return 'afternoon';
    if (hour < 20) return 'evening';
    if (hour < 22) return 'dusk';
    return 'night';
  }

  // The sessions at the resort: the open ones, each with whatever the stream has
  // said about it since the last poll laid over the polled record. The poll is
  // what makes a deleted session disappear; the stream is what makes a status
  // change show up in the same second it happened.
  function officeCrowd() {
    return sessions.filter(isOpenSession).map((s) => ({ ...s, ...(officeCards.get(s.id) || {}) }));
  }

  // The colour of a shirt and its bubble. Same vocabulary as the sidebar's
  // dot, so the two views never disagree about what a session is doing. Only
  // the open states are here: a failed session has already handed its
  // workspace back, and the resort is about what is being worked on.
  function officeMood(s) {
    const state = sessionState(s);
    if (state === 'waiting') return 'wait';
    if (state === 'idle') return 'lit';
    return 'busy';
  }

  // The line in the bubble over a character's head: the tool a running turn
  // is on, the question a waiting one asked, the last thing an idle one said.
  // Short, because it floats over a head and forty characters is what fits.
  function officeLine(s) {
    const clip = (t, n = 44) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
    const state = sessionState(s);
    if (state === 'waiting') return `? ${clip(s.lastText || 'waiting for an answer')}`;
    if (state === 'running') {
      return s.lastTool ? `⌨ ${clip(s.lastTool)}` : s.orchestrator ? '📣 giving orders' : '💭 thinking…';
    }
    if (state === 'queued') return '⏳ waiting for a slot';
    if (state === 'preparing') return '📦 cloning the workspace';
    return s.lastText ? `☕ ${clip(s.lastText)}` : '☕ waiting for instructions';
  }

  // The scene, loaded on first use. A failed import (an old server without
  // the vendor route, a browser without WebGL) leaves the panel with a line
  // saying so rather than a blank stage.
  function loadOffice() {
    if (office) return Promise.resolve(office);
    if (officeLoading) return officeLoading;
    officeLoading = import('/island3d.js')
      .then((m) => {
        office = m.createIsland($('office-city'), {
          session: (id) => openSession(id),
          project: (repo) => {
            setSidebarRepo(repo);
            openPullRequest(repo, null);
          },
          tip: (id) => {
            const s = officeCrowd().find((c) => c.id === id);
            if (!s) return '';
            const badge = s.orchestrator ? '🧭 ' : s.review ? '⌕ ' : s.qa ? '🎬 ' : '';
            const crew = s.crew || (s.subagents || []).map((a) => a.name || 'agent');
            return `${badge}${s.title || s.id} · ${sessionState(s)}${crew.length ? ` · ${crew.length} sub-agents` : ''}`;
          },
          asset: () => {
            if (officeOpen) renderOffice();
          },
        });
        $('office-sound').disabled = false;
        return office;
      })
      .catch((err) => {
        officeLoading = null;
        $('office-city').innerHTML =
          `<p class="office-empty">The office could not start: ${esc(err.message || err)}.</p>`;
        throw err;
      });
    return officeLoading;
  }

  function renderOffice() {
    const phase = officePhase(new Date().getHours());
    $('office-phase').textContent = phase;
    const crowd = officeCrowd();
    const busy = crowd.filter((s) => WORKING_STATES.has(s.status)).length;
    const bosses = crowd.filter((s) => s.orchestrator).length;
    $('office-sub').textContent =
      `${projects.length} ${projects.length === 1 ? 'bungalow' : 'bungalows'} on the water · ` +
      `${crowd.length} open ${crowd.length === 1 ? 'session' : 'sessions'}` +
      (busy ? `, ${busy} working` : '') +
      (bosses ? ` · ${bosses} ${bosses === 1 ? 'orchestrator' : 'orchestrators'} at the villa` : '');
    if (!projects.length) {
      // No scene at all: island3d.js would draw an empty boardwalk, and the
      // reader wants to be told what to do, not shown the sea.
      $('office-empty').classList.remove('hidden');
      $('office-city').classList.add('hidden');
      office?.stop();
      return;
    }
    $('office-empty').classList.add('hidden');
    $('office-city').classList.remove('hidden');
    loadOffice()
      .then((scene) => {
        if (!officeOpen) return;
        scene.layout({
          projects,
          phase,
          crowd: crowd.map((s) => ({
            id: s.id,
            repo: s.repo,
            status: s.status,
            mood: officeMood(s),
            crew: s.crew || (s.subagents || []).map((a) => a.name || 'agent'),
            orchestrator: !!s.orchestrator,
            parentId: s.parentId || null,
            note: officeLine(s),
          })),
        });
        scene.resize(); // the panel may have changed shape while the office was shut
        scene.start();
      })
      .catch(() => {});
  }

  // Where to look: the header's four buttons swing the camera, and the resort
  // eases there itself.
  document.querySelectorAll('.office-focus').forEach((b) => {
    b.addEventListener('click', () => office?.focus(b.dataset.focus));
  });

  function paintOfficeSound() {
    const button = $('office-sound');
    button.textContent = officeSound ? '🔊' : '🔇';
    button.classList.toggle('border-accent', officeSound);
    button.classList.toggle('text-accent', officeSound);
    button.classList.toggle('text-muted', !officeSound);
    button.setAttribute('aria-pressed', String(officeSound));
    button.setAttribute('aria-label', `${officeSound ? 'Turn off' : 'Turn on'} beach ambience`);
    button.title = `${officeSound ? 'Turn off' : 'Turn on'} beach ambience`;
  }

  $('office-sound').addEventListener('click', () => {
    officeSound = !officeSound;
    const supported = office?.sound(officeSound);
    if (!supported) {
      officeSound = false;
    }
    paintOfficeSound();
    if (!supported) $('office-sound').title = 'Beach ambience is not supported by this browser';
  });
  paintOfficeSound();

  // ---------- the ticker ----------
  //
  // The resort can only ever say what is true now: a session that finished
  // its turn while you were watching its table just walks to the café, and a
  // session that failed leaves no trace at all, because a failed session is no
  // longer in the crowd. The strip under the stage is where those land — the
  // stream's status changes, in the order they happened.

  const OFFICE_LOG_MAX = 60;
  const officeLog = []; // { text, tone }, oldest first

  // What each state reads as when a session arrives in it. `tone` is the
  // ticker's only emphasis: bright for work starting or a question that wants
  // an answer, dim for the quiet end of things.
  const OFFICE_NEWS = {
    queued: { verb: 'is waiting for a slot', tone: 'dim' },
    preparing: { verb: 'is cloning its workspace', tone: 'dim' },
    running: { verb: 'started a turn', tone: 'bright' },
    waiting: { verb: 'is asking a question', tone: 'bright' },
    idle: { verb: 'finished a turn', tone: '' },
    closed: { verb: 'left the resort', tone: 'dim' },
    interrupted: { verb: 'was interrupted', tone: 'dim' },
    failed: { verb: 'hit a wall', tone: 'bad' },
  };

  // The office card's state, derived the same way sessionState() derives a
  // session's: the two views must never disagree about what waiting means.
  const officeCardState = (c) => (c.awaitingAnswer && c.status === 'idle' ? 'waiting' : c.status);

  const officeClock = () => new Date().toTimeString().slice(0, 5);

  function officeSay(text, tone = '') {
    officeLog.push({ text: `${officeClock()} ${text}`, tone });
    if (officeLog.length > OFFICE_LOG_MAX) officeLog.shift();
    if (officeOpen) renderOfficeTicker();
  }

  // A line per state change, and only for a session the ticker has already
  // seen: the stream opens by replaying every session it knows, and none of
  // those is news.
  function officeNote(before, card) {
    if (!before) return;
    const state = officeCardState(card);
    if (officeCardState(before) === state) return;
    const news = OFFICE_NEWS[state];
    if (!news) return;
    officeSay(`${card.title || card.id} ${news.verb}`, news.tone);
  }

  function renderOfficeTicker() {
    const body = $('office-ticker-body');
    body.innerHTML =
      officeLog.map((l) => `<div class="office-ticker-line ${l.tone}">▸ ${esc(l.text)}</div>`).join('') +
      '<div class="office-ticker-cursor">▌</div>';
    // Newest at the bottom, the way a terminal reads.
    body.scrollTop = body.scrollHeight;
  }

  // The office's own stream: every session's record, not one's. It only carries
  // what a character is drawn from, so a running turn's token counters never
  // reach it and an open tab costs a message per status change.
  function openOfficeStream() {
    if (officeEs) return;
    officeEs = new EventSource('/api/dev/office/events');
    officeEs.onmessage = (m) => {
      try {
        const card = JSON.parse(m.data);
        officeNote(officeCards.get(card.id), card);
        officeCards.set(card.id, card);
        if (officeOpen) renderOffice();
      } catch {
        /* a malformed line is one lost frame, not a broken view */
      }
    };
    // EventSource reconnects on its own; the indicator is only there so a
    // stalled stream is visible rather than looking like a quiet afternoon.
    // A reconnect says so on the ticker too: the gap it leaves is a stretch of
    // the day the strip simply did not see, and it should not read as quiet.
    officeEs.onopen = () => ($('office-live').textContent = '● live');
    officeEs.onerror = () => {
      $('office-live').textContent = '○ reconnecting';
      if (officeLog.at(-1)?.text.endsWith('stream lost, reconnecting')) return;
      officeSay('stream lost, reconnecting', 'dim');
    };
  }

  function closeOfficeStream() {
    if (!officeEs) return;
    officeEs.close();
    officeEs = null;
    $('office-live').textContent = '';
  }

  function paintOfficeButton() {
    $('btn-office').classList.toggle('border-accent', officeOpen);
    $('btn-office').classList.toggle('text-accent', officeOpen);
  }

  function closeOfficeView() {
    if (!officeOpen) return;
    officeOpen = false;
    paintOfficeButton();
    closeOfficeStream();
    office?.stop(); // nothing to draw for while the panel is hidden
    $('office-view').classList.add('hidden');
    $('chat-scroll').classList.remove('hidden');
    $('composer-wrap').classList.remove('hidden');
  }

  function openOffice() {
    closeDrawersOnMobile();
    if (officeOpen) return;
    showWelcome(); // drops any open session or board, the way the dashboard does
    officeOpen = true;
    paintOfficeButton();
    $('welcome').classList.add('hidden');
    $('chat-scroll').classList.add('hidden');
    $('composer-wrap').classList.add('hidden');
    $('office-view').classList.remove('hidden');
    syncPath();
    renderOffice();
    // The log outlives the view: shutting the office closes the stream, so
    // nothing accrues while it is away, but reopening it should not look like
    // the day started over.
    renderOfficeTicker();
    openOfficeStream();
  }

  $('btn-office').addEventListener('click', () => openOffice());

  // The camera is fitted to the panel, so it has to be fitted again when the
  // panel changes size — opening a drawer, rotating a phone, or just dragging
  // the window. Debounced, because a drag fires this by the hundred.
  let officeResize = null;
  addEventListener('resize', () => {
    if (!officeOpen) return;
    clearTimeout(officeResize);
    officeResize = setTimeout(() => office?.resize(), 150);
  });

  // ---------- the address bar ----------
  //
  // Every view the main pane can hold is worth linking to someone else, so it
  // has a path of its own: / for the new-session pane, /sessions/<id> for a
  // conversation, /projects/<owner>/<name>[/branches/<branch>] for a project's
  // pull requests. The page state is the source of truth: the writers below
  // derive the path from it, and a pasted link or a Back is read the other way,
  // by driving the very same open* a click would.

  function pathFor() {
    if (current) return `/sessions/${encodeURIComponent(current)}`;
    if (homeOpen) return '/dashboard';
    if (officeOpen) return '/office';
    if (!currentProject) return '/';
    const base = `/projects/${currentProject}`;
    // Each segment of the branch is escaped on its own: a feature/thing branch
    // keeps its slash as a slash, which is what the route reads back.
    if (boardBranch) return `${base}/branches/${boardBranch.split('/').map(encodeURIComponent).join('/')}`;
    if (boardTab === 'dashboard') return `${base}/dashboard`;
    if (boardTab === 'issues') return `${base}/issues`;
    return base;
  }

  let applyingPath = false;
  let pathPending = false;

  // Deferred by a tick on purpose: one click walks through several views
  // (openProject() starts by dropping whatever session was open), and only where
  // it comes to rest belongs in the history.
  function syncPath() {
    if (applyingPath || pathPending) return;
    pathPending = true;
    Promise.resolve().then(() => {
      pathPending = false;
      const path = pathFor();
      if (path !== location.pathname) history.pushState(null, '', path);
    });
  }

  function applyPath(path) {
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    const repo = parts[0] === 'projects' && parts[2] ? `${parts[1]}/${parts[2]}` : null;
    applyingPath = true;
    try {
      if (parts[0] === 'sessions' && sessions.some((s) => s.id === parts[1])) {
        openSession(parts[1]);
      } else if (parts[0] === 'dashboard') {
        openHome();
      } else if (parts[0] === 'office') {
        openOffice();
      } else if (repo && projects.some((p) => p.repo === repo)) {
        setSidebarRepo(repo);
        if (parts[3] === 'dashboard') openDashboard(repo);
        else if (parts[3] === 'issues') openIssues(repo);
        else openPullRequest(repo, parts[3] === 'branches' ? parts.slice(4).join('/') : null);
      } else {
        showWelcome();
      }
    } finally {
      applyingPath = false;
    }
    // A link to something that is gone (a deleted conversation, a project
    // dropped from Settings) lands on the welcome pane, and the address says
    // so rather than staying on a page that is not being shown.
    const landed = pathFor();
    if (landed !== location.pathname) history.replaceState(null, '', landed);
  }

  addEventListener('popstate', () => applyPath(location.pathname));

  // Everything the main pane can hold that is not the chat. Both panes take the
  // pane over the same way, so they are dropped in the same place: every route
  // out of one of them already goes through here.
  function closeProjectView() {
    closeHomeView();
    closeOfficeView();
    currentProject = null;
    board = null;
    boardBranch = null;
    boardTab = 'prs';
    boardError = null;
    if (boardTimer) {
      clearInterval(boardTimer);
      boardTimer = null;
    }
    projView().classList.add('hidden');
    $('chat-scroll').classList.remove('hidden');
    $('composer-wrap').classList.remove('hidden');
  }

  // One branch's pull request in the main pane, with its runs under it. A null
  // branch is the whole board again: the way back out of a pull request.
  function openPullRequest(repo, branch) {
    if (!repo) return;
    closeDrawersOnMobile();
    // The tab is set after openProject(): switching repos runs through
    // showWelcome(), whose closeProjectView() resets it to the default.
    const switched = currentProject !== repo;
    if (switched) openProject(repo);
    boardTab = 'prs';
    boardBranch = branch || null;
    syncPath();
    renderBoard();
    renderSidebar(); // the branch it opened is the lit row now
    // openProject() already started the load; a second one here would query
    // GitHub twice for the same board.
    if (!switched && !board && !boardError) loadBoard(repo);
  }

  // The project's 📊 Dashboard pane. The board still loads underneath, since the
  // other tab should not open onto a spinner, and its load brings the usage
  // this pane draws anyway.
  function openDashboard(repo) {
    if (!repo) return;
    closeDrawersOnMobile();
    const switched = currentProject !== repo;
    if (switched) openProject(repo);
    boardTab = 'dashboard';
    boardBranch = null;
    syncPath();
    renderBoard();
    renderSidebar();
    if (!switched) {
      if (!board && !boardError) loadBoard(repo);
      else loadUsage(repo);
    }
  }

  // The project's ⊙ Issues pane. It draws from the board payload, so a project
  // whose board is already loaded switches to it without a request; one opened
  // straight onto this tab loads that same payload, which the pull requests then
  // find waiting for them.
  function openIssues(repo) {
    if (!repo) return;
    closeDrawersOnMobile();
    const switched = currentProject !== repo;
    if (switched) openProject(repo);
    boardTab = 'issues';
    boardBranch = null;
    syncPath();
    renderBoard();
    renderSidebar();
    // openProject() already started the load; a second one here would query
    // GitHub twice for the same board.
    if (!switched && !board && !boardError) loadBoard(repo);
  }

  function openProject(repo) {
    closeDrawersOnMobile();
    if (currentProject === repo) {
      boardBranch = null;
      syncPath();
      renderBoard();
      return;
    }
    showWelcome(); // drops any open session and unlocks the composer chips
    currentProject = repo;
    boardBranch = null;
    $('welcome').classList.add('hidden');
    $('chat-scroll').classList.add('hidden');
    $('composer-wrap').classList.add('hidden');
    projView().classList.remove('hidden');
    syncPath();
    fillBoardProvider();
    renderBoard();
    renderSidebar();
    loadBoard(repo);
    // Without `fresh`, so the minute refresh takes the server's cache when
    // another tab (or the sync) has just paid for the same call: a GitHub
    // budget shared with everything else the app does is not worth spending
    // once per open tab.
    boardTimer = setInterval(() => loadBoard(repo), 60000);
  }

  // ---------- boot ----------

  (async () => {
    // Providers load in the background: their auth probes call out to the
    // gateways, and nothing else on the page has to wait for that.
    loadProviders().catch((e) => toast(`Providers: ${e.message}`, true));
    loadActions().catch((e) => toast(`Actions: ${e.message}`, true));
    try {
      await loadProjects();
    } catch (e) {
      toast(`Projects: ${e.message}`, true);
    }
    await loadSessions();
    setInterval(loadSessions, 7000);
    // The address the page was opened on decides what it shows: a shared link
    // to a conversation or a pull request opens straight into it.
    applyPath(location.pathname);
  })();
})();
