// The documentation site's shared chrome. Every page is plain HTML holding
// nothing but its own <article class="doc">, and this script builds the shell
// around it (sidebar, mobile bar, "on this page" rail, copy buttons, prev/next
// footer), so adding a page means writing its prose and adding one line to NAV,
// not copying eighty lines of navigation into it.
//
// Vanilla, no build step, no dependencies: GitHub Pages serves docs/ exactly as
// it is committed.

// The order here is the order of the sidebar AND of the prev/next footer, so a
// reader who just keeps clicking "next" reads the manual front to back.
const NAV = [
  {
    group: 'Getting started',
    pages: [
      { href: 'index.html', title: 'Overview' },
      { href: 'install.html', title: 'Installation' },
      { href: 'quickstart.html', title: 'Your first session' },
    ],
  },
  {
    group: 'Configuration',
    pages: [
      { href: 'projects.html', title: 'Projects' },
      { href: 'providers.html', title: 'Providers' },
      { href: 'database.html', title: 'Database pool' },
      { href: 'prompts.html', title: 'Prompts & memory' },
      { href: 'config.html', title: 'Environment reference' },
    ],
  },
  {
    group: 'Working',
    pages: [
      { href: 'sessions.html', title: 'Sessions' },
      { href: 'review.html', title: 'Code review & QA' },
    ],
  },
  {
    group: 'Operations',
    pages: [
      { href: 'operations.html', title: 'Running it for real' },
      { href: 'troubleshooting.html', title: 'Troubleshooting' },
    ],
  },
];

const FLAT = NAV.flatMap((g) => g.pages);

// A GitHub Pages project site lives under /<repo>/, and the index is reachable
// as both "" and "index.html", so fold every spelling to the file name.
function currentFile() {
  const last = location.pathname.split('/').pop();
  return !last || last === '/' ? 'index.html' : last;
}

const here = currentFile();

const REPO = 'https://github.com/nadinyamaui/briareus';

/* ------------------------------------------------------------------ shell */

// The page ships as a bare <article class="doc">; everything around it is put
// here and the article is moved into place. Synchronous and at the end of
// <body>, so the reader never sees the unwrapped article.
function buildShell() {
  const article = document.querySelector('.doc');
  if (!article) return;

  const shell = document.createElement('div');
  shell.innerHTML = `
    <div id="scrim" class="fixed inset-0 z-30 hidden bg-black/60 lg:hidden"></div>
    <div class="mx-auto flex max-w-[1440px]">
      <aside id="sidebar" class="sidebar">
        <a href="index.html" class="mb-6 flex items-center gap-2.5 px-2.5 no-underline">
          <span class="text-[17px] font-semibold text-ink">Briareus</span>
          <span class="pill ml-auto !px-2 !py-0.5 !text-[11px]">docs</span>
        </a>
        <nav id="nav"></nav>
        <div class="mt-8 border-t border-line px-2.5 pt-4">
          <a class="block py-1 text-[13px] text-muted no-underline hover:text-ink" href="${REPO}">↗ Source on GitHub</a>
          <a class="block py-1 text-[13px] text-muted no-underline hover:text-ink" href="${REPO}/issues">↗ Issues</a>
          <a class="block py-1 text-[13px] text-muted no-underline hover:text-ink" href="${REPO}/blob/main/SECURITY.md">↗ Security policy</a>
        </div>
      </aside>
      <div class="flex min-w-0 flex-1 flex-col">
        <header class="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-canvas/95 px-4 py-2.5 backdrop-blur lg:hidden">
          <button id="btn-menu" aria-label="Open the navigation"
            class="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-line bg-raise text-[15px] text-ink">☰</button>
          <span class="text-sm font-semibold">Briareus docs</span>
        </header>
        <div class="flex min-w-0 flex-1 gap-12 px-5 py-10 lg:px-12 lg:py-14">
          <main id="content" class="min-w-0 flex-1">
            <footer id="page-nav" hidden class="mt-14 flex gap-3 border-t border-line pt-8"></footer>
            <p class="mt-8 text-xs text-muted">
              <a class="text-muted no-underline hover:text-ink" href="${REPO}/edit/main/docs/${here}">✎ Edit this page on GitHub</a>
            </p>
          </main>
          <aside id="toc" hidden class="hidden w-[220px] shrink-0 xl:block">
            <div class="sticky top-14">
              <h4 class="mb-2 text-[11px] font-semibold uppercase tracking-[.08em] text-muted">On this page</h4>
              <div id="toc-list"></div>
            </div>
          </aside>
        </div>
      </div>
    </div>`;

  document.body.prepend(...shell.children);
  document.getElementById('content').prepend(article);
}

/* ---------------------------------------------------------------- sidebar */

function buildNav() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  nav.innerHTML = NAV.map(
    (g) => `
      <div class="nav-group">
        <h4>${g.group}</h4>
        ${g.pages
          .map(
            (p) => `<a class="nav-link${p.href === here ? ' active' : ''}" href="${p.href}">${p.title}</a>`,
          )
          .join('')}
      </div>`,
  ).join('');
}

/* --------------------------------------------------- on this page + spy */

// Only h2/h3 with an id make the rail: an unlinkable heading is a heading the
// reader cannot be sent to, so it is not worth a line in the index either.
function buildToc() {
  const toc = document.getElementById('toc-list');
  const article = document.querySelector('.doc');
  if (!toc || !article) return [];

  const heads = [...article.querySelectorAll('h2[id], h3[id]')];
  if (heads.length < 2) {
    const rail = document.getElementById('toc');
    if (rail) rail.remove();
    return [];
  }
  toc.innerHTML = heads
    .map((h) => `<a class="toc-link${h.tagName === 'H3' ? ' sub' : ''}" href="#${h.id}">${h.textContent}</a>`)
    .join('');
  const rail = document.getElementById('toc');
  if (rail) rail.hidden = false;
  return heads;
}

// Highlight the heading the reader is actually under, which is the last one
// whose top has passed the quarter-height mark, not the first one merely
// intersecting, which flips back and forth on a long section.
function spy(heads) {
  const links = new Map(
    [...document.querySelectorAll('.toc-link')].map((a) => [a.getAttribute('href').slice(1), a]),
  );
  if (!links.size) return;

  let active = null;
  const update = () => {
    const mark = window.innerHeight * 0.25;
    let current = heads[0];
    for (const h of heads) {
      if (h.getBoundingClientRect().top <= mark) current = h;
      else break;
    }
    if (current === active) return;
    active = current;
    for (const a of links.values()) a.classList.remove('active');
    links.get(current.id)?.classList.add('active');
  };

  // rAF-throttled: scroll fires far more often than the rail can change.
  let queued = false;
  addEventListener(
    'scroll',
    () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        update();
      });
    },
    { passive: true },
  );
  update();
}

/* ------------------------------------------------------------ code blocks */

function decorateCode() {
  for (const pre of document.querySelectorAll('.doc pre')) {
    const wrap = document.createElement('div');
    wrap.className = 'code-block group';
    pre.replaceWith(wrap);
    wrap.append(pre);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.innerText.replace(/\n$/, ''));
        btn.textContent = 'Copied';
      } catch {
        // No clipboard permission (or an insecure origin), so say so rather than
        // leaving the button looking like it worked.
        btn.textContent = 'Press ⌘/Ctrl+C';
      }
      setTimeout(() => (btn.textContent = 'Copy'), 1600);
    });
    wrap.append(btn);
  }
}

/* ------------------------------------------------- heading anchor links */

function anchorHeadings() {
  for (const h of document.querySelectorAll('.doc h2[id], .doc h3[id]')) {
    const a = document.createElement('a');
    a.href = `#${h.id}`;
    a.className = 'ml-2 text-muted no-underline opacity-0 transition-opacity hover:opacity-100';
    a.setAttribute('aria-label', `Link to ${h.textContent}`);
    a.textContent = '#';
    h.classList.add('group');
    a.classList.add('group-hover:opacity-60');
    h.append(a);
  }
}

/* ------------------------------------------------------------ prev / next */

function buildPageNav() {
  const footer = document.getElementById('page-nav');
  if (!footer) return;
  const i = FLAT.findIndex((p) => p.href === here);
  if (i < 0) return;
  const prev = FLAT[i - 1];
  const next = FLAT[i + 1];
  footer.innerHTML = `
    ${prev ? `<a class="page-nav no-underline" href="${prev.href}"><span>← Previous</span><strong>${prev.title}</strong></a>` : '<div class="flex-1"></div>'}
    ${next ? `<a class="page-nav text-right no-underline" href="${next.href}"><span>Next →</span><strong>${next.title}</strong></a>` : '<div class="flex-1"></div>'}
  `;
  footer.hidden = false;
}

/* ---------------------------------------------------------- mobile drawer */

function wireDrawer() {
  const sidebar = document.getElementById('sidebar');
  const scrim = document.getElementById('scrim');
  const btn = document.getElementById('btn-menu');
  if (!sidebar || !btn) return;

  const close = () => {
    sidebar.classList.remove('open');
    scrim?.classList.add('hidden');
  };
  btn.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    scrim?.classList.toggle('hidden');
  });
  scrim?.addEventListener('click', close);
  sidebar.addEventListener('click', (e) => {
    if (e.target instanceof HTMLAnchorElement) close();
  });
  addEventListener('keydown', (e) => e.key === 'Escape' && close());
}

buildShell();
buildNav();
// The rail is built from the headings' text, so it has to be read before
// anchorHeadings() appends a `#` link inside each of them.
spy(buildToc());
anchorHeadings();
decorateCode();
buildPageNav();
wireDrawer();
