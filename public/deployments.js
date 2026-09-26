(() => {
  if (location.pathname !== '/deployments') return;
  const { api, esc, content, title, status } = window.BriareusOperations;
  title('Deployments');
  let repo = new URLSearchParams(location.search).get('repo') || '',
    busy = false;
  const path = (action = '') => `/api/operations/deployments${action}?repo=${encodeURIComponent(repo)}`;
  const link = (url, label) =>
    /^https?:\/\//i.test(url || '')
      ? `<a class="underline" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`
      : '';
  async function refresh() {
    try {
      const { projects } = await api('/api/projects');
      if (!repo) repo = projects[0]?.repo || '';
      content.innerHTML = `<label>Project<select id="deployment-project" class="ml-3 border border-line bg-canvas p-2">${projects.map((p) => `<option ${p.repo === repo ? 'selected' : ''}>${esc(p.repo)}</option>`).join('')}</select></label><div id="deployment-state" class="mt-5"></div>`;
      document.getElementById('deployment-project').onchange = (e) => {
        repo = e.target.value;
        history.replaceState(null, '', '/deployments?repo=' + encodeURIComponent(repo));
        void refresh();
      };
      if (!repo) {
        status('Add a project in Settings first.');
        return;
      }
      const panel = document.getElementById('deployment-state');
      // The settings form stays available even when GitHub cannot be read.
      let state = { ...(await api(path('/config'))), active: [], history: [] };
      let unavailable = false;
      try {
        state = await api(path());
        status(`Checked ${state.checkedAt} · Health: ${state.health.state}`);
      } catch (e) {
        unavailable = true;
        status(e.message);
      }
      const c = state.config || {};
      panel.innerHTML = `<div class="mb-5">${state.active.length ? state.active.map((d) => `<p class="mb-3"><strong>${esc(d.environment)}</strong> · <code class="break-all">${esc(d.sha)}</code> · ${esc(d.updatedAt)} ${link(d.url, 'Open app')}</p>`).join('') : unavailable ? 'Deployment state is unavailable; retry after GitHub recovers.' : 'No successful active deployment found in the latest 20 records.'}</div>${state.attempt ? `<p class="mb-3">Last request: ${esc(state.attempt.state)} · ${esc(state.attempt.sha)} ${link(state.attempt.url, 'Check Actions')}</p>${!state.attempt.acknowledged ? '<button class="btn mb-4" id="deployment-ack">I checked Actions; allow another request</button>' : ''}` : ''}<details class="mb-5 rounded border border-line p-4"><summary>Deployment configuration</summary><p class="my-3">The workflow must accept the SHA input below, check out that exact revision, and publish deployment status for the chosen environment.</p><form id="deployment-config">${[
        ['environment', 'Environment'],
        ['workflow', 'Workflow filename or ID'],
        ['workflowRef', 'Workflow branch/tag'],
        ['sourceRef', 'Source branch/tag'],
        ['revisionInput', 'Workflow input for commit SHA'],
        ['healthUrl', 'Health URL (optional)'],
      ]
        .map(
          ([key, label]) =>
            `<label class="mb-3 block">${label}<input name="${key}" class="block w-full border border-line bg-canvas p-2" value="${esc(c[key] || '')}" ${key === 'healthUrl' ? '' : 'required'}></label>`,
        )
        .join(
          '',
        )}<label class="block mb-3"><input type="checkbox" name="requireChecks" ${c.requireChecks !== false ? 'checked' : ''}> Require green CI</label><button class="btn">Save configuration</button></form></details><button class="btn" id="deployment-plan" ${state.config ? '' : 'disabled'}>Inspect deployment</button><div id="deployment-plan-view" class="my-4"></div><button class="btn" id="deployment-refresh">Refresh status</button><h2 class="my-4 font-semibold">Recent deployment attempts</h2>${state.history.map((d) => `<p class="mb-3 break-words">${esc(d.environment)} · ${esc(d.state)} · ${esc(d.sha)} · ${esc(d.updatedAt)} ${link(d.logUrl, 'Logs')}</p>`).join('')}${state.historyLimited ? '<p>Showing the latest 20 records.</p>' : ''}`;
      panel.querySelector('#deployment-refresh').onclick = () => {
        if (!busy) void refresh();
      };
      panel.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        if (busy) return;
        busy = true;
        try {
          const data = Object.fromEntries(new FormData(e.target));
          data.requireChecks = e.target.elements.requireChecks.checked;
          await api(path('/config'), data);
          await refresh();
        } catch (e) {
          status(e.message);
        } finally {
          busy = false;
        }
      };
      panel.querySelector('#deployment-ack')?.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        try {
          await api(path('/acknowledge'), {});
          await refresh();
        } catch (e) {
          status(e.message);
        } finally {
          busy = false;
        }
      });
      panel.querySelector('#deployment-plan').onclick = async () => {
        if (busy) return;
        busy = true;
        try {
          const plan = await api(path('/plan'), {});
          const view = panel.querySelector('#deployment-plan-view');
          view.innerHTML = `<p class="break-all">Deploy ${esc(plan.sha)} to ${esc(plan.config.environment)} using ${esc(plan.config.workflow)}@${esc(plan.config.workflowRef)}.</p><p>CI: ${plan.checksPassed ? 'green' : 'not green or missing'}</p><button class="btn mt-3" ${plan.config.requireChecks && !plan.checksPassed ? 'disabled' : ''}>Deploy this revision</button>`;
          view.querySelector('button').onclick = async (e) => {
            if (busy) return;
            busy = true;
            e.target.disabled = true;
            try {
              const attempt = await api(path('/dispatch'), { planId: plan.id });
              await refresh();
              status(`Deployment requested (${attempt.sha}); completion is reported by the workflow.`);
            } catch (e) {
              status(e.message);
            } finally {
              busy = false;
            }
          };
        } catch (e) {
          status(e.message);
        } finally {
          busy = false;
        }
      };
    } catch (e) {
      status(e.message);
    }
  }
  void refresh();
})();
