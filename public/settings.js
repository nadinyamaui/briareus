// Settings. Three kinds of rows are edited here: projects (everything the
// runner needs to prepare and run one repository), providers (the picker
// entries, each linking a label to one of the hardcoded binaries plus its own
// login/endpoint/model config) and the database pool (the servers a session
// can claim for itself while it runs).
(() => {
  const $ = (id) => document.getElementById(id);

  // ---------- the entry list, as a drawer ----------
  //
  // Below `lg` the sidebar slides over the form instead of sitting beside it:
  // ☰ opens it, the scrim, Escape and picking an entry close it again. Above
  // `lg` the CSS pins it open and none of this shows.
  const isMobile = () => window.matchMedia('(max-width: 1023px)').matches;

  function setDrawer(open) {
    $('sidebar').classList.toggle('open', open);
    $('scrim').classList.toggle('hidden', !open);
  }

  function closeDrawerOnMobile() {
    if (isMobile()) setDrawer(false);
  }

  // Sign out, shown only when the app has a login configured at all.
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

  $('btn-menu').addEventListener('click', () => setDrawer(!$('sidebar').classList.contains('open')));
  $('scrim').addEventListener('click', () => setDrawer(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setDrawer(false);
  });
  window.addEventListener('resize', () => {
    if (!isMobile()) setDrawer(false);
  });

  // Both entities share one page: TYPES holds everything that differs, so the
  // select/save/delete plumbing below stays written once.
  const TYPES = {
    project: {
      listEl: () => $('project-list'),
      formEl: () => $('form'),
      api: '/api/projects',
      body: 'projects',
      single: 'project',
      prefix: 'f-',
      fields: {
        repo: 'text',
        label: 'text',
        setupCommands: 'list',
        phpBinDir: 'text',
        localDir: 'text',
        dbPoolEnabled: 'bool',
        dbPoolDatabase: 'text',
        dbRestoreSql: 'text',
        dbExtensions: 'list',
        envTemplate: 'text',
        runCommands: 'list',
        reviewPublishInstructions: 'text',
        reviewTestSheet: 'bool',
        reviewTestRun: 'bool',
        qaNotes: 'text',
        feedbackInstructions: 'text',
        testSheetInstructions: 'text',
        reviewAuthor: 'text',
        reviewProviderId: 'number',
        reviewModel: 'text',
        reviewEffort: 'text',
        workerProviderId: 'number',
        workerModel: 'text',
        workerEffort: 'text',
        workerBudgetUsd: 'number',
        isSelf: 'bool',
      },
      title: (p) => p.label,
      sub: (p) => p.repo,
      name: (p) => p.repo,
      newTitle: 'New project',
      deleteBody: 'Sessions already started against it keep their history, but no new one can be.',
      // What a clone must not inherit: the repo is unique, so the copy starts without one.
      cloneReset: { repo: '' },
      cloneFocus: 'f-repo',
    },
    provider: {
      listEl: () => $('provider-list'),
      formEl: () => $('form-provider'),
      api: '/api/providers',
      body: 'providers',
      single: 'provider',
      prefix: 'p-',
      fields: {
        label: 'text',
        binary: 'text',
        baseUrl: 'text',
        apiKey: 'text',
        models: 'list',
        efforts: 'list',
        defaultModel: 'text',
        defaultEffort: 'text',
      },
      title: (p) => p.label,
      sub: (p) => `runs the ${p.binary} CLI`,
      name: (p) => p.label,
      newTitle: 'New provider',
      deleteBody: 'Sessions already run on it keep their history, but no new one can be started on it.',
      cloneReset: { label: '' },
      cloneFocus: 'p-label',
    },
    server: {
      listEl: () => $('dbserver-list'),
      formEl: () => $('form-db'),
      api: '/api/dbservers',
      body: 'servers',
      single: 'server',
      prefix: 'd-',
      fields: {
        label: 'text',
        host: 'text',
        port: 'number',
        username: 'text',
        password: 'text',
        enabled: 'bool',
      },
      title: (s) => s.label,
      sub: (s) => `${s.host}:${s.port} · a session claims this server for itself while it runs`,
      name: (s) => s.label,
      newTitle: 'New database server',
      deleteBody: 'Sessions can no longer claim it. Nothing on the server itself is touched.',
      // host:port is unique in the pool; an empty label re-defaults to host:port on save.
      cloneReset: { label: '', port: null },
      cloneFocus: 'd-port',
    },
    // The prompts every project shares: one row, always id 1. Its fields are
    // not a fixed list (they are built from the catalog the server sends), so
    // `fields` is empty and readForm/writeForm handle it in their own branch,
    // the way the project form handles its step runtimes.
    templates: {
      listEl: () => $('template-list'),
      formEl: () => $('form-templates'),
      api: '/api/templates',
      body: 'templates',
      single: 'templates',
      prefix: 'tpl-',
      fields: {},
      title: () => 'Prompts',
      sub: () => 'What this app sends out: the PR body it writes and the errand behind every action.',
      name: () => 'the prompts',
    },
    // The composer's kickoff library, separate from the review prompts above:
    // plain text with a title, nothing to render or fall back on.
    saved: {
      listEl: () => $('saved-list'),
      formEl: () => $('form-saved'),
      api: '/api/dev/prompts',
      body: 'prompts',
      single: 'prompt',
      prefix: 's-',
      fields: {
        title: 'text',
        repo: 'text',
        sortOrder: 'number',
        body: 'text',
      },
      title: (s) => s.title,
      sub: (s) => (s.repo ? `offered on ${s.repo} only` : 'offered on every project'),
      name: (s) => s.title,
      newTitle: 'New saved prompt',
      deleteBody:
        'It disappears from the composer’s Prompts menu. Sessions started from it are not affected.',
      cloneReset: { title: '' },
      cloneFocus: 's-title',
    },
    // Project memory: what the agents remember about a project between
    // sessions. Written mostly by the memory tool during turns; this page is
    // where the operator reads, corrects and prunes it.
    memory: {
      listEl: () => $('memory-list'),
      formEl: () => $('form-memory'),
      api: '/api/memories',
      body: 'memories',
      single: 'memory',
      prefix: 'm-',
      fields: {
        repo: 'text',
        type: 'text',
        name: 'text',
        description: 'text',
        body: 'text',
      },
      title: (m) => m.name,
      sub: (m) => `${m.type} memory on ${m.repo}${m.jobId ? ', saved by a session' : ''}`,
      name: (m) => m.name,
      newTitle: 'New memory',
      deleteBody: 'Sessions on the project stop being told this. Nothing else changes.',
      cloneReset: { name: '' },
      cloneFocus: 'm-name',
    },
  };

  const items = {
    project: [],
    provider: [],
    server: [],
    templates: [],
    saved: [],
    memory: [],
  };
  // Every editable prompt: its label, its hint, the {{TOKEN}}s it may use and
  // the built-in text an empty field falls back on. Sent by /api/templates, so
  // this page never carries a second copy of a prompt.
  let templateCatalog = [];
  // The provider rows with their model lists resolved: what the project
  // form's reviewer provider/model dropdowns offer.
  let devProviders = [];
  const defaults = {
    project: null,
    provider: null,
    server: null,
    templates: null,
    saved: { title: '', body: '', repo: '', sortOrder: null },
    memory: { repo: '', type: 'project', name: '', description: '', body: '' },
  };
  let currentType = null; // 'project' | 'provider' | 'server' | 'templates'
  let current = null; // the row being edited (null = nothing selected)
  let isNew = false;
  let dirty = false;

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

  // The same await-a-boolean dialog developer.js uses, so neither page falls
  // back to window.confirm.
  let modalResolve = null;
  function openConfirm({ title, body, confirmLabel = 'Confirm', danger = false, icon = '?' }) {
    closeConfirm(false); // a second question supersedes an unanswered one
    const btnOk = $('modal-confirm');
    $('modal-title').textContent = title;
    $('modal-body').textContent = body;
    $('modal-icon').textContent = icon;
    $('modal-icon').className =
      'flex size-9 shrink-0 items-center justify-center rounded-full text-base ' +
      (danger ? 'bg-danger/15 text-danger' : 'bg-accent/15 text-accent');
    btnOk.textContent = confirmLabel;
    btnOk.className =
      'btn px-3 py-1.5 text-[14px] ' +
      (danger ? 'border-danger bg-danger/15 text-danger hover:bg-danger/25' : 'btn-primary');

    // Re-run the entry animation on every open.
    const panel = $('modal-panel');
    panel.classList.remove('animate-modal-in');
    void panel.offsetWidth;
    panel.classList.add('animate-modal-in');

    $('modal').classList.remove('hidden');
    btnOk.focus();
    return new Promise((resolve) => {
      modalResolve = resolve;
    });
  }

  function closeConfirm(answer) {
    $('modal').classList.add('hidden');
    const resolve = modalResolve;
    modalResolve = null;
    if (resolve) resolve(answer);
  }

  $('modal-confirm').addEventListener('click', () => closeConfirm(true));
  $('modal-cancel').addEventListener('click', () => closeConfirm(false));
  $('modal-backdrop').addEventListener('click', () => closeConfirm(false));
  document.addEventListener('keydown', (e) => {
    if (modalResolve && e.key === 'Escape') {
      e.preventDefault();
      closeConfirm(false);
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

  // ---------- form ----------

  function readForm(type) {
    const t = TYPES[type];
    const out = {};
    for (const [key, kind] of Object.entries(t.fields)) {
      const el = $(`${t.prefix}${key}`);
      if (kind === 'bool') out[key] = el.checked;
      else if (kind === 'list')
        out[key] = el.value
          .split('\n')
          .map((v) => v.trim())
          .filter(Boolean);
      else if (kind === 'number') out[key] = el.value === '' ? null : Number(el.value);
      else out[key] = el.value;
    }
    if (type === 'provider') {
      // The hidden mode's fields must not ride along: switching to Login
      // drops the endpoint and its token. opencode has no mode select to
      // switch (its entries are always a key, with an endpoint or without),
      // so the hidden select's leftover value must not decide for it.
      if (out.binary === 'grok' || (out.binary !== 'opencode' && $('p-authMode').value !== 'token')) {
        out.apiKey = '';
        out.baseUrl = '';
      }
    }
    // Not a flat field: three selects per step, and a step left on "same as the
    // code review" is stored as no entry at all rather than as empty strings.
    if (type === 'project') {
      out.stepRuntimes = readStepRuntimes();
      out.promptTemplates = readTemplateFields('f-tpl-');
    }
    // The shared prompts are not a fixed list of fields either; they are
    // whatever the catalog holds.
    if (type === 'templates') out.values = readTemplateFields('tpl-');
    return out;
  }

  function writeForm(type, row) {
    const t = TYPES[type];
    for (const [key, kind] of Object.entries(t.fields)) {
      const el = $(`${t.prefix}${key}`);
      const value = row[key];
      if (kind === 'bool') el.checked = !!value;
      else if (kind === 'list') el.value = (value || []).join('\n');
      else if (kind === 'number') el.value = value == null ? '' : value;
      else el.value = value ?? '';
    }
    if (type === 'project') {
      // Both selects are filled from the live provider list, so their options
      // only exist now: the generic loop above wrote into empty <select>s.
      fillReviewProviders(row.reviewProviderId);
      fillReviewModels(row.reviewModel);
      fillReviewEfforts(row.reviewEffort);
      fillWorkerProviders(row.workerProviderId);
      fillWorkerModels(row.workerModel);
      fillWorkerEfforts(row.workerEffort);
      writeStepRuntimes(row.stepRuntimes || {});
      writeTemplateFields('f-tpl-', row.promptTemplates || {});
      syncDbFields();
      syncStepFields();
    }
    if (type === 'provider') {
      // The mode is not a stored column: a row with a token (or endpoint) is
      // in API token mode, everything else is a login.
      $('p-authMode').value = row.apiKey || row.baseUrl ? 'token' : 'login';
      syncProviderFields();
      loadProviderStatus(row);
    }
    if (type === 'server') {
      // Another entry's verdict must not read as this one's.
      $('d-test-result').textContent = '';
      $('d-test-result').classList.remove('text-danger', 'text-ok');
    }
    if (type === 'templates') writeTemplateFields('tpl-', row.values || {});
    if (type === 'saved' && row.repo && $('s-repo').value !== row.repo) {
      // Bound to a project since deleted from Settings: keep the binding
      // visible rather than let a save silently widen it to every project.
      $('s-repo').insertAdjacentHTML(
        'beforeend',
        `<option value="${esc(row.repo)}">${esc(row.repo)} (no longer a project)</option>`,
      );
      $('s-repo').value = row.repo;
    }
    if (type === 'memory' && row.repo && $('m-repo').value !== row.repo) {
      $('m-repo').insertAdjacentHTML(
        'beforeend',
        `<option value="${esc(row.repo)}">${esc(row.repo)} (no longer a project)</option>`,
      );
      $('m-repo').value = row.repo;
    }
    autoGrow(t.formEl());
  }

  // ---------- provider status ----------

  // The Status section: the entry's connection at a glance. Account, plan,
  // subscription usage, binary. Only a saved row has one to show.
  let statusSeq = 0;
  async function loadProviderStatus(row) {
    const sec = $('p-status-sec');
    sec.classList.toggle('off', !row || !row.id);
    if (!row || !row.id) return;
    const seq = ++statusSeq;
    $('p-status').innerHTML = '<div class="text-[13px] text-muted">Checking the connection…</div>';
    try {
      const { status } = await api(`/api/providers/${row.id}/status`);
      if (seq === statusSeq) $('p-status').innerHTML = renderProviderStatus(status);
    } catch (e) {
      if (seq === statusSeq)
        $('p-status').innerHTML = `<div class="text-[13px] text-danger">${esc(e.message)}</div>`;
    }
  }

  function fmtReset(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const sameDay = d.toDateString() === new Date().toDateString();
    return d.toLocaleString(
      [],
      sameDay
        ? { hour: 'numeric', minute: '2-digit' }
        : { weekday: 'short', hour: 'numeric', minute: '2-digit' },
    );
  }

  function renderProviderStatus(s) {
    const a = s.auth || {};
    const dot = !s.available || a.loggedIn === false ? 'failed' : a.loggedIn ? 'idle' : '';
    const headline = !s.available
      ? 'The CLI is not installed on this machine'
      : a.loggedIn === true
        ? `Connected${a.email ? `: ${a.email}` : ''}`
        : a.loggedIn === false
          ? `Not connected${a.detail ? `: ${a.detail}` : ''}`
          : 'Connection not checked yet';
    const row = (label, value, mono) =>
      value
        ? `
      <span class="text-muted">${label}</span>
      <span class="truncate${mono ? ' font-mono text-[12px] leading-[1.7]' : ''}">${esc(value)}</span>`
        : '';
    const plan = a.plan ? a.plan.charAt(0).toUpperCase() + a.plan.slice(1) : '';
    // esc on the label: a window can be named from the numbers the provider
    // sent back (Z.AI states its period as a count and a unit), so the text is
    // not always this file's own.
    const bar = (label, pct, resetsAt) => `
      <div class="mt-2.5">
        <div class="flex items-baseline justify-between text-[12px] text-muted">
          <span>${esc(label)}</span>
          <span>${pct}% used${resetsAt && fmtReset(resetsAt) ? ` · resets ${fmtReset(resetsAt)}` : ''}</span>
        </div>
        <div class="mt-1 h-[5px] overflow-hidden rounded bg-sunken">
          <div class="h-full rounded ${pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warn' : 'bg-ok'}" style="width:${pct}%"></div>
        </div>
      </div>`;
    // Which windows a plan meters is the provider's call: claude and codex
    // report 5 hours and a week, a Z.AI key 5 hours and a day, grok a billing
    // month, so the bars wear the labels that came with them.
    const bars = (s.usage?.windows || []).map((w) => bar(w.label, w.usedPct, w.resetsAt)).join('');
    return `
      <div class="flex items-center gap-2 text-[14px]"><span class="dot ${dot}"></span>${esc(headline)}</div>
      <div class="mt-2.5 grid grid-cols-[150px_1fr] items-baseline gap-x-3.5 gap-y-[3px] text-[13px]">
        ${row('Account', a.name && a.email ? `${a.email} (${a.name})` : a.email || a.name)}
        ${row('Organization', a.organization)}
        ${row('Plan', plan)}
        ${row('Auth', a.loggedIn == null ? '' : a.detail)}
        ${row('Binary', s.available ? s.binSource : 'not found')}
        ${row('Login dir', s.loginDir, true)}
        ${row('Checked', a.checkedAt ? fmtReset(a.checkedAt) : '')}
      </div>
      ${bars}`;
  }

  // The database fields only mean anything when the project claims a server, so
  // they are hidden entirely while the checkbox is off.
  function syncDbFields() {
    $('db-fields').classList.toggle('off', !$('f-dbPoolEnabled').checked);
  }
  $('f-dbPoolEnabled').addEventListener('change', syncDbFields);

  // What the board starts this project's reviews on, so an errand pressed from
  // a pull request row does not have to ask again. The options come from
  // /api/dev/providers rather than /api/providers: that one resolves each
  // entry's model list (an entry with no list of its own means "the CLI's",
  // which only the server can expand).
  function fillReviewProviders(selectedId) {
    const sel = $('f-reviewProviderId');
    sel.innerHTML = ['<option value="">Pick a provider</option>']
      .concat(devProviders.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`))
      .join('');
    sel.value = selectedId ? String(selectedId) : '';
  }

  function fillReviewModels(selectedModel) {
    const sel = $('f-reviewModel');
    const provider = devProviders.find((p) => String(p.id) === $('f-reviewProviderId').value);
    const models = provider ? provider.models : [];
    sel.innerHTML = models.length
      ? models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('')
      : '<option value="">—</option>';
    // A model the provider no longer offers falls back to its default, which
    // is also what the server would do with a stale name.
    sel.value = models.includes(selectedModel) ? selectedModel : provider ? provider.defaultModel : '';
  }

  function fillReviewEfforts(selectedEffort) {
    const sel = $('f-reviewEffort');
    const provider = devProviders.find((p) => String(p.id) === $('f-reviewProviderId').value);
    const efforts = provider ? provider.efforts : [];
    sel.innerHTML = efforts.length
      ? efforts.map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join('')
      : '<option value="">—</option>';
    // An effort the provider no longer offers falls back to its default, which
    // is also what the server would do with a stale name.
    sel.value = efforts.includes(selectedEffort) ? selectedEffort : provider ? provider.defaultEffort : '';
  }

  // What a 🧭 orchestrator's workers run on when a spawn names nothing. The
  // empty option means the orchestrator's own entry, so the model and effort
  // lists are disabled (and pointless) while it is picked, same as the steps.
  function fillWorkerProviders(selectedId) {
    const sel = $('f-workerProviderId');
    sel.innerHTML = ['<option value="">Same as the orchestrator</option>']
      .concat(devProviders.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`))
      .join('');
    sel.value = selectedId ? String(selectedId) : '';
    // A configured entry the provider list no longer carries (deleted row, or
    // the providers request failed) stays visible instead of collapsing to
    // "Same as the orchestrator", which a save would then silently store.
    if (selectedId && sel.value !== String(selectedId)) {
      sel.insertAdjacentHTML(
        'beforeend',
        `<option value="${Number(selectedId)}">Provider #${Number(selectedId)} (unavailable)</option>`,
      );
      sel.value = String(selectedId);
    }
  }

  function fillWorkerModels(selectedModel) {
    const sel = $('f-workerModel');
    const provider = devProviders.find((p) => String(p.id) === $('f-workerProviderId').value);
    const models = provider ? provider.models : [];
    sel.disabled = !provider;
    sel.innerHTML = models.length
      ? models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('')
      : '<option value="">—</option>';
    sel.value = models.includes(selectedModel) ? selectedModel : provider ? provider.defaultModel : '';
  }

  function fillWorkerEfforts(selectedEffort) {
    const sel = $('f-workerEffort');
    const provider = devProviders.find((p) => String(p.id) === $('f-workerProviderId').value);
    const efforts = provider ? provider.efforts : [];
    sel.disabled = !provider;
    sel.innerHTML = efforts.length
      ? efforts.map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join('')
      : '<option value="">—</option>';
    sel.value = efforts.includes(selectedEffort) ? selectedEffort : provider ? provider.defaultEffort : '';
  }

  // ---------- what each step runs on ----------

  // The steps that pick a runtime of their own, in the same list
  // lib/projects.js keeps, in the same order. Publishing is not among them: it
  // stays in the review's own conversation. `on` is the checkbox that decides
  // whether the step happens at all: no runtime is worth picking for a step
  // that is switched off.
  const STEPS = [
    { key: 'testSheet', on: () => $('f-reviewTestSheet').checked },
    { key: 'testRun', on: () => $('f-reviewTestRun').checked },
  ];

  const stepEl = (key, part) => $(`f-step-${key}-${part}`);

  // "Same as the code review" is the empty option, and the only one a project
  // ever had before this existed: the step then runs on whatever the session
  // itself runs on: the project's reviewer provider for a session the board
  // started, the composer's pick for one started by hand.
  function fillStepProviders(key, selectedId) {
    const sel = stepEl(key, 'providerId');
    sel.innerHTML = ['<option value="">Same as the code review</option>']
      .concat(devProviders.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`))
      .join('');
    sel.value = selectedId ? String(selectedId) : '';
  }

  // The model and effort lists belong to the step's own provider, so they are
  // empty (and pointless) while the step inherits one.
  function fillStepModels(key, selectedModel) {
    const sel = stepEl(key, 'model');
    const provider = devProviders.find((p) => String(p.id) === stepEl(key, 'providerId').value);
    const models = provider ? provider.models : [];
    sel.disabled = !provider;
    sel.innerHTML = models.length
      ? models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('')
      : '<option value="">—</option>';
    sel.value = models.includes(selectedModel) ? selectedModel : provider ? provider.defaultModel : '';
  }

  function fillStepEfforts(key, selectedEffort) {
    const sel = stepEl(key, 'effort');
    const provider = devProviders.find((p) => String(p.id) === stepEl(key, 'providerId').value);
    const efforts = provider ? provider.efforts : [];
    sel.disabled = !provider;
    sel.innerHTML = efforts.length
      ? efforts.map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join('')
      : '<option value="">—</option>';
    sel.value = efforts.includes(selectedEffort) ? selectedEffort : provider ? provider.defaultEffort : '';
  }

  function writeStepRuntimes(runtimes) {
    for (const { key } of STEPS) {
      const entry = runtimes[key] || {};
      fillStepProviders(key, entry.providerId);
      fillStepModels(key, entry.model || '');
      fillStepEfforts(key, entry.effort || '');
    }
  }

  function readStepRuntimes() {
    const out = {};
    for (const { key } of STEPS) {
      const providerId = stepEl(key, 'providerId').value;
      if (!providerId) continue;
      out[key] = {
        providerId: Number(providerId),
        model: stepEl(key, 'model').value,
        effort: stepEl(key, 'effort').value,
      };
    }
    return out;
  }

  // A step that is switched off does not run, so what it would run on is noise.
  function syncStepFields() {
    for (const step of STEPS) $(`step-${step.key}`).classList.toggle('off', !step.on());
  }

  for (const { key } of STEPS) {
    stepEl(key, 'providerId').addEventListener('change', () => {
      fillStepModels(key, '');
      fillStepEfforts(key, '');
    });
  }

  // ---------- prompt templates ----------

  // Two forms edit the same list of prompts: the shared set (prefix `tpl-`) and
  // one project's overrides (`f-tpl-`). Both are built here from the catalog the
  // server sends, so a template added on the server appears in both without a
  // line of HTML, and the prompts themselves stay on the server, where the
  // sessions that send them run.
  function buildTemplateFields(container, prefix, scope) {
    const fallback =
      scope === 'project'
        ? 'Leave empty to use the shared text under Prompts in the sidebar.'
        : 'Leave empty to use the text this app ships with.';
    container.innerHTML = templateCatalog
      .map((t) => {
        const tokens = t.vars.length
          ? ` Tokens: ${t.vars.map((v) => `<code title="${esc(v.hint)}">{{${esc(v.name)}}}</code>`).join(' ')}. Anything else in braces is left exactly as written.`
          : ' No tokens: the text is sent exactly as written.';
        return `
        <label class="field">
          <span>${esc(t.label)}</span>
          <textarea id="${prefix}${t.id}" rows="3" spellcheck="false" placeholder="${esc(fallback)}"></textarea>
          <em>${esc(t.hint)}${tokens}
            <button type="button" data-tpl="${esc(t.id)}"
                    class="cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-[12px] text-accent hover:underline">↧ Load the text it falls back on</button></em>
        </label>`;
      })
      .join('');
    // Editing a long prompt starts from what is being sent today, not from an
    // empty box; otherwise the only way to tweak one line is to retype the
    // whole thing.
    container.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tpl]');
      if (!btn) return;
      const el = $(`${prefix}${btn.dataset.tpl}`);
      el.value = effectiveTemplate(btn.dataset.tpl, scope);
      dirty = true;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight + 2, 420) + 'px';
      el.focus();
    });
  }

  // What this scope would send if its own field stayed empty: the shared text
  // for a project, the built-in one for the shared set itself.
  function effectiveTemplate(id, scope) {
    const entry = templateCatalog.find((t) => t.id === id);
    if (!entry) return '';
    const shared = (items.templates[0] && items.templates[0].values) || {};
    return (scope === 'project' && shared[id]) || entry.builtIn;
  }

  function writeTemplateFields(prefix, values) {
    for (const t of templateCatalog) {
      const el = $(`${prefix}${t.id}`);
      if (el) el.value = (values && values[t.id]) || '';
    }
  }

  function readTemplateFields(prefix) {
    const out = {};
    for (const t of templateCatalog) {
      const el = $(`${prefix}${t.id}`);
      const text = el ? el.value.trim() : '';
      if (text) out[t.id] = text;
    }
    return out;
  }

  // The test run reads the sheet, so switching it on switches the sheet on
  // with it, the same rule the server enforces on save.
  $('f-reviewTestRun').addEventListener('change', () => {
    if ($('f-reviewTestRun').checked) $('f-reviewTestSheet').checked = true;
    syncStepFields();
  });
  // Switching the sheet off switches off the run that reads it, the same rule
  // the server enforces on save, read backwards.
  $('f-reviewTestSheet').addEventListener('change', () => {
    if (!$('f-reviewTestSheet').checked) $('f-reviewTestRun').checked = false;
    syncStepFields();
  });
  $('f-reviewProviderId').addEventListener('change', () => {
    fillReviewModels('');
    fillReviewEfforts('');
  });
  $('f-workerProviderId').addEventListener('change', () => {
    fillWorkerModels('');
    fillWorkerEfforts('');
  });

  // Which extras a provider can carry depends on its binary and its auth
  // mode: a login entry is the CLI's own login in a registered dir of its own,
  // an API token entry is an endpoint + token. Two binaries have only one of
  // the two, so their Mode select is hidden: grok has no token mode, and
  // opencode has nothing else, since it authenticates with an API key per
  // service and offers no login flow at all.
  function syncProviderFields() {
    const binary = $('p-binary').value;
    const keyOnly = binary === 'opencode';
    const token = keyOnly || (binary !== 'grok' && $('p-authMode').value === 'token');
    const endpoint = token;
    const row = currentType === 'provider' && !isNew ? current : null;
    $('p-authMode-label').classList.toggle('off', binary === 'grok' || keyOnly);
    // The login button only exists on a saved entry: the login is registered
    // against the row, so there is nothing to log in until one exists.
    $('p-login-field').classList.toggle('off', token || !row);
    $('p-endpoint-fields').classList.toggle('off', !endpoint);
    $('p-apiKey-field').classList.toggle('off', !token);
    $('p-test-field').classList.toggle('off', !endpoint);
    $('p-test-result').textContent = '';
    $('p-test-result').classList.remove('text-danger');
    $('p-login-code').classList.add('hidden');
    $('p-login-code').value = '';
    $('p-login-finish').classList.add('hidden');
    $('p-baseUrl-hint').innerHTML =
      binary === 'claude'
        ? 'Passed to the claude CLI as <code>ANTHROPIC_BASE_URL</code>, for a proxy or an Anthropic-compatible endpoint. Leave empty for the Anthropic API.'
        : binary === 'opencode'
          ? "The base URL of the service this entry's models name (<code>anthropic</code> for <code>anthropic/claude-sonnet-4-5</code>), for a proxy or a compatible gateway; include the <code>/v1</code> when the service's own URL carries one. Handed to the CLI as an inline config (<code>OPENCODE_CONFIG_CONTENT</code>) alongside the key, so the machine's own opencode config is never touched. Leave empty for the service's own endpoint."
          : "A custom API endpoint driven through the codex CLI (Responses wire format). Sessions run with a server-written <code>CODEX_HOME</code> pointing codex at it, so the machine's own <code>~/.codex</code> login is never touched. Leave empty for the binary's own service.";
    $('p-apiKey-hint').innerHTML =
      binary === 'claude'
        ? 'Passed as <code>ANTHROPIC_API_KEY</code>, used instead of a login. With a base URL it also goes out as <code>ANTHROPIC_AUTH_TOKEN</code>, so gateways that read <code>Authorization</code> instead of <code>x-api-key</code> see it too.'
        : binary === 'opencode'
          ? "The key for the service this entry's models name: <code>anthropic</code> for <code>anthropic/claude-sonnet-4-5</code>. It is handed to the CLI as its whole credential store, so the machine's own opencode credentials stay untouched."
          : 'Authenticates the base URL above.';
  }
  $('p-binary').addEventListener('change', syncProviderFields);
  $('p-authMode').addEventListener('change', syncProviderFields);

  // Every login happens in the browser. For claude the server hands the page
  // the claude.ai authorization URL, the user approves there and pastes the
  // code claude.ai shows back into the page, and the server exchanges it for
  // the entry's tokens. For codex the server runs `codex login` hidden; the
  // CLI opens the browser tab itself and its localhost callback finishes the
  // login, and the page opening the URL too would make a second tab. For grok the
  // server runs `grok login --device-auth` hidden; the CLI only prints the
  // confirm URL, so the page opens it and the CLI polls until it is approved.
  // opencode has no login at all: its entries authenticate with an API key.
  $('p-login-btn').addEventListener('click', async () => {
    if (currentType !== 'provider' || !current || isNew) return;
    const id = current.id;
    if (current.binary !== 'claude') {
      try {
        const { url } = await api(`/api/providers/${id}/login`, { method: 'POST' });
        if (!url) {
          toast('This entry is already logged in.');
        } else if (current.binary === 'grok') {
          // grok's device flow prints the URL and waits, so the page opens it.
          window.open(url, '_blank');
          toast('Confirm the code in the tab; the login is picked up automatically.');
        } else {
          toast('Approve in the tab codex opened; the login is picked up automatically.');
        }
        // The login lands out of band (the CLI's localhost callback), so poll the
        // status a few times so the section catches it without a reselect.
        for (const wait of [10000, 30000, 60000, 120000]) {
          setTimeout(() => {
            if (currentType === 'provider' && current && current.id === id) loadProviderStatus(current);
          }, wait);
        }
      } catch (e) {
        toast(e.message, true);
      }
      return;
    }
    try {
      const { url } = await api(`/api/providers/${id}/login/start`, { method: 'POST' });
      window.open(url, '_blank');
      $('p-login-code').classList.remove('hidden');
      $('p-login-finish').classList.remove('hidden');
      $('p-login-code').focus();
      toast('Approve in the browser, then paste the code it shows here.');
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('p-login-finish').addEventListener('click', async () => {
    if (currentType !== 'provider' || !current || isNew) return;
    const code = $('p-login-code').value.trim();
    if (!code) return toast('Paste the code from the browser first', true);
    try {
      const { provider } = await api(`/api/providers/${current.id}/login/finish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      items.provider = items.provider.map((p) => (p.id === provider.id ? provider : p));
      if (currentType === 'provider' && current && current.id === provider.id) {
        current = provider;
        syncProviderFields();
        loadProviderStatus(current);
      }
      renderList();
      toast(`${provider.label} is logged in`);
    } catch (e) {
      toast(e.message, true);
    }
  });

  // The Test button probes the endpoint + token as the form holds them (no
  // save needed) and drops the endpoint's own model list into the Models
  // field (still unsaved, so a bad list is one Escape away from discarded).
  // The form's model rides along so a gateway with no model list route can
  // still be verified with a minimal chat call.
  $('p-test-btn').addEventListener('click', async () => {
    const out = $('p-test-result');
    $('p-test-btn').disabled = true;
    out.classList.remove('text-danger');
    out.textContent = 'Testing…';
    try {
      const { models, probedModel } = await api('/api/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          binary: $('p-binary').value,
          baseUrl: $('p-baseUrl').value.trim(),
          apiKey: $('p-apiKey').value,
          model:
            $('p-defaultModel').value.trim() ||
            $('p-models')
              .value.split('\n')
              .map((s) => s.trim())
              .filter(Boolean)[0] ||
            '',
        }),
      });
      if (probedModel) {
        out.textContent = `OK: no model list route, but a chat call as ${probedModel} answered`;
        toast('Endpoint OK: verified with a chat call, keep the Models field as it is');
        return;
      }
      out.textContent = `OK: the endpoint offers ${models.length} model${models.length === 1 ? '' : 's'}`;
      if ($('p-models').value.trim() !== models.join('\n')) {
        $('p-models').value = models.join('\n');
        dirty = true;
        autoGrow($('form-provider'));
        toast('Endpoint OK: its models are in the Models field, save to keep them');
      } else {
        toast('Endpoint OK: the Models field already matches its list');
      }
    } catch (e) {
      out.textContent = e.message;
      out.classList.add('text-danger');
    } finally {
      $('p-test-btn').disabled = false;
    }
  });

  // The pool entry's own Test connection: does this host answer with these
  // credentials, and is a session on it right now? Probed on the form's values,
  // so a new entry can be checked before it is saved.
  $('d-test-btn').addEventListener('click', async () => {
    const out = $('d-test-result');
    $('d-test-btn').disabled = true;
    out.classList.remove('text-danger', 'text-ok');
    out.textContent = 'Connecting…';
    try {
      const r = await api('/api/dbservers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...readForm('server'), id: current && !isNew ? current.id : null }),
      });
      out.textContent =
        `Healthy: MySQL ${r.version}, ${r.databases} database${r.databases === 1 ? '' : 's'}` +
        (r.claimedBy ? ` · claimed by session ${r.claimedBy}` : ' · free');
      out.classList.add('text-ok');
    } catch (e) {
      out.textContent = e.message;
      out.classList.add('text-danger');
    } finally {
      $('d-test-btn').disabled = false;
    }
  });

  // The pool size caps the sessions that claim a server (one open session per
  // entry, across every project with its database on) so the section header
  // carries it: adding an entry reads as one more parallel session, removing
  // one as fewer. Projects that claim no server are not capped at all.
  function syncCapacity() {
    const n = items.server.filter((s) => s.enabled).length;
    $('d-capacity').textContent = n ? `· ${n} parallel session${n === 1 ? '' : 's'} with a database` : '';
  }

  function autoGrow(formEl) {
    for (const el of formEl.querySelectorAll('textarea')) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight + 2, 420) + 'px';
    }
  }

  for (const type of Object.keys(TYPES)) {
    const formEl = TYPES[type].formEl();
    formEl.addEventListener('input', (e) => {
      dirty = true;
      if (e.target.tagName === 'TEXTAREA') {
        e.target.style.height = 'auto';
        e.target.style.height = Math.min(e.target.scrollHeight + 2, 420) + 'px';
      }
    });
    formEl.addEventListener('change', () => {
      dirty = true;
    });
  }
  // Ctrl+S is the reflex for a page this long.
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ---------- lists ----------

  const ROW = 'sess flex cursor-pointer flex-col gap-0.5 rounded-lg px-2 py-[7px] hover:bg-raise';
  const BADGE = 'rounded border border-line px-[5px] text-[11px] text-muted';

  function renderList() {
    const selected = (type, row) => currentType === type && current && row.id === current.id && !isNew;
    $('project-list').innerHTML = items.project
      .map(
        (p) => `
      <div class="${ROW}${selected('project', p) ? ' bg-raise' : ''}" data-type="project" data-id="${p.id}">
        <div class="flex items-center gap-[7px] truncate text-[14px]"><span class="dot ${p.enabled ? 'idle' : ''}"></span>${esc(p.label)}</div>
        <div class="flex items-center gap-2 text-[12px] text-muted">
          <span class="truncate">${esc(p.repo)}</span>
          ${p.dbPoolEnabled ? `<span class="${BADGE}">db</span>` : ''}
        </div>
      </div>`,
      )
      .join('');
    $('provider-list').innerHTML =
      items.provider
        .map(
          (p) => `
      <div class="${ROW}${selected('provider', p) ? ' bg-raise' : ''}" data-type="provider" data-id="${p.id}">
        <div class="flex items-center gap-[7px] truncate text-[14px]"><span class="dot idle"></span>${esc(p.label)}</div>
        <div class="flex items-center gap-2 text-[12px] text-muted">
          <span class="${BADGE}">${esc(p.binary)}</span>
          ${p.hasLogin ? `<span class="${BADGE}">own login</span>` : ''}
          ${p.baseUrl ? `<span class="${BADGE}">custom endpoint</span>` : ''}
        </div>
      </div>`,
        )
        .join('') ||
      '<div class="px-2 py-1 text-[12px] text-muted">No providers yet. Add one so sessions can be started.</div>';
    $('dbserver-list').innerHTML =
      items.server
        .map(
          (s) => `
      <div class="${ROW}${selected('server', s) ? ' bg-raise' : ''}" data-type="server" data-id="${s.id}">
        <div class="flex items-center gap-[7px] truncate text-[14px]"><span class="dot ${s.enabled ? 'idle' : ''}"></span>${esc(s.label)}</div>
        <div class="flex items-center gap-2 text-[12px] text-muted">
          <span class="truncate">${esc(`${s.host}:${s.port}`)}</span>
        </div>
      </div>`,
        )
        .join('') ||
      '<div class="px-2 py-1 text-[12px] text-muted">No servers yet. Add one so sessions can claim a database of their own.</div>';
    $('template-list').innerHTML = items.templates
      .map((t) => {
        const n = Object.keys(t.values || {}).length;
        return `
      <div class="${ROW}${selected('templates', t) ? ' bg-raise' : ''}" data-type="templates" data-id="${t.id}">
        <div class="flex items-center gap-[7px] truncate text-[14px]"><span class="dot ${n ? 'idle' : ''}"></span>Prompts</div>
        <div class="flex items-center gap-2 text-[12px] text-muted">
          <span class="truncate">${n ? `${n} of ${templateCatalog.length} written here` : 'all on the built-in text'}</span>
        </div>
      </div>`;
      })
      .join('');
    $('saved-list').innerHTML =
      items.saved
        .map(
          (s) => `
      <div class="${ROW}${selected('saved', s) ? ' bg-raise' : ''}" data-type="saved" data-id="${s.id}">
        <div class="flex items-center gap-[7px] truncate text-[14px]"><span class="dot idle"></span>${esc(s.title)}</div>
        <div class="flex items-center gap-2 text-[12px] text-muted">
          <span class="truncate">${s.repo ? esc(s.repo) : 'all projects'}</span>
        </div>
      </div>`,
        )
        .join('') ||
      '<div class="px-2 py-1 text-[12px] text-muted">None yet. Save one here or from the composer’s Prompts menu.</div>';
    $('memory-list').innerHTML =
      items.memory
        .map(
          (m) => `
      <div class="${ROW}${selected('memory', m) ? ' bg-raise' : ''}" data-type="memory" data-id="${m.id}">
        <div class="flex items-center gap-[7px] truncate text-[14px]"><span class="dot idle"></span>${esc(m.name)}</div>
        <div class="flex items-center gap-2 text-[12px] text-muted">
          <span class="truncate">${esc(m.repo)} · ${esc(m.type)}</span>
        </div>
      </div>`,
        )
        .join('') ||
      '<div class="px-2 py-1 text-[12px] text-muted">Nothing remembered yet. Sessions save memories with their memory tool as they learn.</div>';
    // Not an entry: one fixed row that opens the pool table.
    $('workspace-list').innerHTML = `
      <div class="${ROW}${currentType === 'workspaces' ? ' bg-raise' : ''}" data-type="workspaces" data-id="pool">
        <div class="flex items-center gap-[7px] truncate text-[14px]"><span class="dot idle"></span>Pool health</div>
        <div class="flex items-center gap-2 text-[12px] text-muted"><span class="truncate">clone slots on disk</span></div>
      </div>`;
    if (isNew) {
      const el = document.createElement('div');
      el.className = `${ROW} bg-raise`;
      el.innerHTML = `<div class="flex items-center gap-[7px] truncate text-[14px]"><span class="dot"></span>${TYPES[currentType].newTitle}</div>`;
      TYPES[currentType].listEl().appendChild(el);
    }
    syncCapacity();
  }

  document.getElementById('sidebar').addEventListener('click', (e) => {
    const item = e.target.closest('.sess');
    if (!item || !item.dataset.id) return;
    // Also for the entry that is already open: the tap says "show me this",
    // and showForm's own close never runs when select() finds nothing to do.
    closeDrawerOnMobile();
    if (item.dataset.type === 'workspaces') showWorkspaces();
    else select(item.dataset.type, Number(item.dataset.id));
  });

  // Sidebar sections stay collapsed across visits.
  for (const sec of document.querySelectorAll('#sidebar details')) {
    const key = `settings.sidebar.${sec.id}`;
    if (localStorage.getItem(key) === 'closed') sec.open = false;
    sec.addEventListener('toggle', () => {
      localStorage.setItem(key, sec.open ? 'open' : 'closed');
    });
  }

  function confirmDiscard() {
    if (!dirty) return Promise.resolve(true);
    return openConfirm({
      title: 'Discard changes?',
      body: 'There are unsaved changes here. Leaving now throws them away.',
      confirmLabel: 'Discard',
      danger: true,
      icon: '!',
    });
  }

  // ---------- workspace pool ----------
  //
  // Read from disk each time it opens (git status and du are not worth
  // caching on this side); the two actions ask first, since both make the next
  // session on that slot pay for an install again.
  async function showWorkspaces() {
    if (currentType !== 'workspaces' && !(await confirmDiscard())) return;
    closeDrawerOnMobile();
    currentType = 'workspaces';
    current = null;
    isNew = false;
    dirty = false;
    $('form-title').textContent = 'Workspaces';
    $('form-sub').textContent = 'The clone slots sessions run in, and what each one holds right now.';
    for (const t of Object.values(TYPES)) t.formEl().classList.add('hidden');
    $('empty').classList.add('hidden');
    for (const id of ['btn-save', 'btn-clone', 'btn-delete']) $(id).classList.add('hidden');
    $('form-workspaces').classList.remove('hidden');
    renderList();
    syncPath();
    await loadWorkspaces();
  }

  async function loadWorkspaces() {
    const table = $('ws-table');
    table.innerHTML = '<div class="px-3 py-2 text-[12px] text-muted">Reading the pool…</div>';
    try {
      const { workspaces } = await api('/api/workspaces');
      renderWorkspaces(workspaces);
    } catch (e) {
      table.innerHTML = `<div class="px-3 py-2 text-[12px] text-danger">${esc(e.message)}</div>`;
    }
  }

  function fmtSize(kb) {
    if (kb == null) return '—';
    if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
    if (kb >= 1024) return `${Math.round(kb / 1024)} MB`;
    return `${kb} KB`;
  }

  function fmtAgo(ms) {
    const min = Math.round((Date.now() - ms) / 60000);
    if (min < 60) return `${min} min ago`;
    if (min < 60 * 48) return `${Math.round(min / 60)} h ago`;
    return `${Math.round(min / 1440)} d ago`;
  }

  function renderWorkspaces(rows) {
    const TH =
      'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted whitespace-nowrap';
    if (!rows.length) {
      $('ws-table').innerHTML =
        '<div class="px-3 py-2 text-[12px] text-muted">No clone slots yet. The first session creates one.</div>';
      return;
    }
    $('ws-table').innerHTML = `
      <table class="w-full border-collapse text-[13px]">
        <thead class="border-b border-line bg-sunken">
          <tr>
            <th class="${TH}">Slot</th><th class="${TH}">State</th><th class="${TH}">Branch</th>
            <th class="${TH}">HEAD</th><th class="${TH}">Tree</th><th class="${TH}">Size</th>
            <th class="${TH}">vendor</th><th class="${TH}">node_modules</th><th class="${TH}">Setup memory</th>
            <th class="${TH}"></th>
          </tr>
        </thead>
        <tbody>${rows.map(workspaceRow).join('')}</tbody>
      </table>`;
  }

  function workspaceRow(w) {
    const TD = 'px-3 py-2 align-top text-[13px] whitespace-nowrap';
    const yes = (b) => (b ? '<span class="text-ok">✓</span>' : '<span class="text-muted">—</span>');
    const claimed = !!w.claimedBy;
    const state = claimed
      ? `<span class="${BADGE} border-warn text-warn" title="${esc(w.claimedBy.title)}">claimed · <a class="underline" href="/sessions/${esc(w.claimedBy.id)}">${esc(w.claimedBy.id)}</a></span>`
      : `<span class="${BADGE} border-ok text-ok">idle</span>`;
    const tree =
      w.dirty == null
        ? '<span class="text-muted">?</span>'
        : w.dirty
          ? '<span class="text-warn">dirty</span>'
          : '<span class="text-muted">clean</span>';
    const setup = w.setup
      ? `${w.setup.steps} install${w.setup.steps === 1 ? '' : 's'} · ${fmtAgo(w.setup.at)}`
      : '<span class="text-muted">none</span>';
    const btn = (action, label, title) =>
      `<button class="btn px-2 py-0.5 text-[12px]" data-ws="${esc(w.slot)}" data-action="${action}" title="${title}" ${claimed ? 'disabled' : ''}>${label}</button>`;
    return `
      <tr class="border-b border-line last:border-0">
        <td class="${TD}"><div class="font-medium">${esc(w.repo)}</div><div class="text-[11px] text-muted">slot ${w.index} · ${esc(w.slot)}</div></td>
        <td class="${TD}">${state}</td>
        <td class="${TD}">${w.branch ? esc(w.branch) : '<span class="text-muted">—</span>'}</td>
        <td class="${TD} font-mono text-[12px]">${w.head ? esc(w.head) : '—'}</td>
        <td class="${TD}">${tree}${w.error ? `<div class="max-w-[260px] truncate text-[11px] text-danger" title="${esc(w.error)}">${esc(w.error)}</div>` : ''}</td>
        <td class="${TD}">${fmtSize(w.sizeKb)}</td>
        <td class="${TD}">${yes(w.vendor)}</td>
        <td class="${TD}">${yes(w.nodeModules)}</td>
        <td class="${TD}">${setup}</td>
        <td class="${TD}"><div class="flex gap-1.5">${btn('reset-setup', 'Reset setup', 'Forget which installs already ran here')}${btn('clean', 'Clean', 'Remove vendor/ and node_modules/')}</div></td>
      </tr>`;
  }

  $('ws-table').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-ws]');
    if (!btn || btn.disabled) return;
    const { ws, action } = btn.dataset;
    const clean = action === 'clean';
    const ok = await openConfirm({
      title: clean ? `Clean ${ws}?` : `Reset setup memory of ${ws}?`,
      body: clean
        ? 'Removes vendor/ and node_modules/ and the install fingerprints. The next session on this slot installs everything from scratch. The checkout itself is untouched.'
        : 'Forgets which install steps already ran here, so the next session runs them all again. Nothing on disk besides that memory is removed.',
      confirmLabel: clean ? 'Clean' : 'Reset',
      danger: clean,
      icon: clean ? '🗑' : '↺',
    });
    if (!ok) return;
    try {
      await api(`/api/workspaces/${encodeURIComponent(ws)}/${action}`, { method: 'POST' });
      toast(clean ? `Cleaned ${ws}` : `Setup memory of ${ws} reset`);
    } catch (err) {
      toast(err.message, true);
    }
    await loadWorkspaces();
  });

  // ---------- the address bar ----------
  //
  // Every entry is linkable: /settings/<section>[/<id>], the sections named
  // after the sidebar rather than after the internal type. server.js serves
  // this page for all of them, so a pasted link opens on what it names, and
  // the page state stays the source of truth, with the path derived from it.
  const SECTIONS = {
    project: 'projects',
    provider: 'providers',
    server: 'servers',
    templates: 'prompts',
    saved: 'saved-prompts',
    memory: 'memory',
    workspaces: 'workspaces',
  };
  const TYPE_OF = Object.fromEntries(Object.entries(SECTIONS).map(([type, name]) => [name, type]));

  function pathFor() {
    if (!currentType) return '/settings/projects';
    const base = `/settings/${SECTIONS[currentType]}`;
    // The prompts are one shared row, so the section is the whole address.
    if (currentType === 'templates' || currentType === 'workspaces') return base;
    if (isNew) return `${base}/new`;
    return current ? `${base}/${current.id}` : base;
  }

  let applyingPath = false;

  function syncPath(replace = false) {
    if (applyingPath) return;
    const path = pathFor();
    if (path !== location.pathname) history[replace ? 'replaceState' : 'pushState'](null, '', path);
  }

  // Read the other way: drive the same select()/startNew() a click would, so
  // the two ways into an entry, including its unsaved-changes guard, cannot
  // drift apart. An address naming something that is gone falls back to the
  // first project, the way the page opens anyway.
  async function applyPath(path) {
    const [section, id] = path.split('/').filter(Boolean).slice(1);
    const type = TYPE_OF[section];
    applyingPath = true;
    try {
      if (type === 'workspaces') {
        await showWorkspaces();
      } else if (type === 'templates') {
        if (items.templates.length) await select('templates', items.templates[0].id);
        else showEmpty();
      } else if (type && id === 'new') {
        await startNew(type);
      } else if (type && items[type].some((r) => r.id === Number(id))) {
        await select(type, Number(id));
      } else if (items.project.length) {
        await select('project', items.project[0].id);
      } else {
        showEmpty();
      }
    } finally {
      applyingPath = false;
    }
  }

  addEventListener('popstate', async () => {
    await applyPath(location.pathname);
    // Whatever it actually landed on (a discard the reader refused, an entry
    // deleted since the link was made) is what the address must say.
    syncPath(true);
  });

  async function select(type, id) {
    const row = items[type].find((r) => r.id === id);
    if (!row || (currentType === type && current && current.id === id && !isNew)) return;
    if (!(await confirmDiscard())) return;
    currentType = type;
    current = row;
    isNew = false;
    dirty = false;
    showForm(TYPES[type].title(row), TYPES[type].sub(row));
    writeForm(type, row);
    renderList();
    syncPath();
  }

  async function startNew(type) {
    if (!(await confirmDiscard())) return;
    currentType = type;
    current = null;
    isNew = true;
    dirty = false;
    showForm(TYPES[type].newTitle, 'Nothing is created until you save.');
    writeForm(type, defaults[type]);
    TYPES[type].listEl().closest('details').open = true;
    renderList();
    syncPath();
    $(
      { project: 'f-repo', provider: 'p-label', server: 'd-host', saved: 's-title', memory: 'm-name' }[type],
    ).focus();
  }

  function showForm(title, sub) {
    // Picking an entry on a phone is a request to edit it, so the drawer the
    // pick came from gets out of the way. Both ways in, the list and ＋ New,
    // land here.
    closeDrawerOnMobile();
    $('form-title').textContent = title;
    $('form-sub').textContent = sub;
    for (const [type, t] of Object.entries(TYPES)) {
      t.formEl().classList.toggle('hidden', type !== currentType);
    }
    $('form-workspaces').classList.add('hidden');
    $('empty').classList.add('hidden');
    $('btn-save').classList.remove('hidden');
    // The singleton, the shared prompts, cannot be cloned or deleted, only
    // edited.
    const singleton = currentType === 'templates';
    $('btn-clone').classList.toggle('hidden', isNew || singleton);
    $('btn-delete').classList.toggle('hidden', isNew || singleton);
  }

  function showEmpty() {
    currentType = null;
    current = null;
    isNew = false;
    dirty = false;
    $('form-title').textContent = 'Projects';
    $('form-sub').textContent = 'A project is a repository a session can be started against.';
    for (const t of Object.values(TYPES)) t.formEl().classList.add('hidden');
    $('form-workspaces').classList.add('hidden');
    $('empty').classList.remove('hidden');
    $('btn-save').classList.add('hidden');
    $('btn-clone').classList.add('hidden');
    $('btn-delete').classList.add('hidden');
    renderList();
    syncPath();
  }

  // ---------- actions ----------

  async function save() {
    if (!currentType || (!current && !isNew)) return;
    const type = currentType;
    const t = TYPES[type];
    const body = readForm(type);
    $('btn-save').disabled = true;
    try {
      const saved = (
        isNew
          ? await api(t.api, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            })
          : await api(`${t.api}/${current.id}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            })
      )[t.single];
      dirty = false;
      await load();
      current = items[type].find((r) => r.id === saved.id) || saved;
      isNew = false;
      showForm(t.title(current), t.sub(current));
      writeForm(type, current);
      renderList();
      // Replaced, not pushed: the entry that was just created stands where its
      // blank form was, so Back leaves Settings instead of reopening it.
      syncPath(true);
      toast(`Saved ${t.name(saved)}`);
    } catch (e) {
      toast(e.message, true);
    } finally {
      $('btn-save').disabled = false;
    }
  }

  $('btn-save').addEventListener('click', save);
  // The ＋ New buttons live inside a <summary>; preventDefault keeps the click
  // from also toggling the section.
  $('btn-new').addEventListener('click', (e) => {
    e.preventDefault();
    startNew('project');
  });
  $('btn-new-provider').addEventListener('click', (e) => {
    e.preventDefault();
    startNew('provider');
  });
  $('btn-new-db').addEventListener('click', (e) => {
    e.preventDefault();
    startNew('server');
  });
  $('btn-new-saved').addEventListener('click', (e) => {
    e.preventDefault();
    startNew('saved');
  });
  $('btn-new-memory').addEventListener('click', (e) => {
    e.preventDefault();
    startNew('memory');
  });

  // Clone the form as it stands, unsaved edits included, into a new entry.
  // The uniqueness field (repo, port) is cleared so saving cannot clash with
  // the source row, and focused, since it is the one thing a clone must state.
  $('btn-clone').addEventListener('click', () => {
    if (!currentType || !current || isNew) return;
    const t = TYPES[currentType];
    const copy = { ...readForm(currentType), ...t.cloneReset };
    const source = t.name(current);
    current = null;
    isNew = true;
    dirty = true;
    showForm(t.newTitle, `A copy of ${source}. Nothing is created until you save.`);
    writeForm(currentType, copy);
    renderList();
    syncPath();
    $(t.cloneFocus).focus();
  });

  $('btn-delete').addEventListener('click', async () => {
    if (!current || !currentType) return;
    const type = currentType;
    const t = TYPES[type];
    const ok = await openConfirm({
      title: `Delete ${t.name(current)}?`,
      body: t.deleteBody,
      confirmLabel: 'Delete',
      danger: true,
      icon: '🗑',
    });
    if (!ok) return;
    try {
      await api(`${t.api}/${current.id}`, { method: 'DELETE' });
      dirty = false;
      await load();
      if (items[type].length) select(type, items[type][0].id);
      else if (items.project.length) select('project', items.project[0].id);
      else showEmpty();
    } catch (e) {
      toast(e.message, true);
    }
  });

  async function load() {
    const [proj, prov, db, dev, tpl, saved, mem] = await Promise.all([
      api('/api/projects'),
      api('/api/providers'),
      api('/api/dbservers'),
      // Best effort: a provider whose login probe is down should not stop the
      // page from loading, it just leaves the reviewer dropdowns empty.
      api('/api/dev/providers').catch(() => ({ providers: [] })),
      api('/api/templates').catch(() => ({ templates: [], defaults: null, catalog: [] })),
      api('/api/dev/prompts').catch(() => ({ prompts: [] })),
      api('/api/memories').catch(() => ({ memories: [] })),
    ]);
    items.saved = saved.prompts;
    items.memory = mem.memories;
    // A memory always belongs to a project, so this select has no "all" row
    // and a new one defaults to the first project.
    const memRepo = $('m-repo');
    const keepMem = memRepo.value;
    memRepo.innerHTML = proj.projects
      .map((p) => `<option value="${esc(p.repo)}">${esc(p.label || p.repo)}</option>`)
      .join('');
    memRepo.value = keepMem;
    defaults.memory.repo = proj.projects.length ? proj.projects[0].repo : '';
    const repoSel = $('s-repo');
    const keep = repoSel.value;
    repoSel.innerHTML =
      '<option value="">All projects</option>' +
      proj.projects.map((p) => `<option value="${esc(p.repo)}">${esc(p.label || p.repo)}</option>`).join('');
    repoSel.value = keep;
    items.project = proj.projects;
    defaults.project = proj.defaults;
    items.provider = prov.providers;
    defaults.provider = prov.defaults;
    items.server = db.servers;
    defaults.server = db.defaults;
    devProviders = dev.providers;
    items.templates = tpl.templates;
    defaults.templates = tpl.defaults;
    // The fields are the catalog, so they are built the first time it arrives
    // and only then: a reload after a save must not throw away the textareas
    // the user is looking at.
    if (tpl.catalog.length && !templateCatalog.length) {
      templateCatalog = tpl.catalog;
      buildTemplateFields($('tpl-global-fields'), 'tpl-', 'global');
      buildTemplateFields($('tpl-project-fields'), 'f-tpl-', 'project');
    }
  }

  // ---------- boot ----------

  (async () => {
    try {
      await load();
    } catch (e) {
      toast(e.message, true);
      showEmpty();
      return;
    }
    // The address decides what opens: /settings/projects is only the default
    // one, and a link to any other entry lands on it directly.
    await applyPath(location.pathname);
    syncPath(true);
  })();
})();
