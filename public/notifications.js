(() => {
  if (location.pathname !== '/notifications') return;
  const { api, esc, content, title, status } = window.BriareusOperations;
  title('Notifications');
  const supported =
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;
  let busy = false;
  const decode = (key) =>
    Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  async function init() {
    try {
      const state = await api('/api/operations/notifications');
      const { projects } = await api('/api/projects');
      const registration = supported ? await navigator.serviceWorker.register('/push-worker.js') : null;
      if (registration) await navigator.serviceWorker.ready;
      const subscription = registration ? await registration.pushManager.getSubscription() : null;
      const key = 'briareus.notificationProjects';
      let selected = [];
      try {
        selected = JSON.parse(localStorage.getItem(key) || '[]');
      } catch {
        /* all projects */
      }
      content.innerHTML = `<p class="mb-4">Receive grouped alerts for questions, findings and blocked work, even outside this tab. Notifications contain counts, not conversation text or commands.</p>${!state.configured ? '<p class="mb-4">Configure a contact for this installation first; signing keys are generated and kept on the server.</p>' : ''}<form id="notification-config"><label>Installation contact URL or mailto: address<input name="contact" class="my-2 block w-full border border-line bg-canvas p-2" required value="${esc(state.contact)}"></label><button class="btn">Save contact</button></form><fieldset class="my-5"><legend>Projects (none selected means all)</legend>${projects.map((p) => `<label class="block my-2"><input type="checkbox" data-project="${esc(p.repo)}" ${selected.includes(p.repo) ? 'checked' : ''}> ${esc(p.label || p.repo)}</label>`).join('')}</fieldset><button class="btn" id="notifications-enable" ${supported && state.configured ? '' : 'disabled'}>${subscription ? 'Update project selection' : 'Enable on this browser'}</button> <button class="btn" id="notifications-disable" ${subscription ? '' : 'disabled'}>Disable on this browser</button><p class="my-4 text-muted">${!supported ? 'This browser needs HTTPS and Web Push support; on iOS use an installed home-screen web app.' : `Browser permission: ${esc(Notification.permission)}. You can disable this subscription here at any time.`}</p>`;
      content.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        if (busy) return;
        busy = true;
        try {
          await api('/api/operations/notifications/config', { contact: e.target.elements.contact.value });
          await init();
        } catch (e) {
          status(e.message);
        } finally {
          busy = false;
        }
      };
      document.getElementById('notifications-enable').onclick = async (event) => {
        if (busy) return;
        busy = true;
        event.target.disabled = true;
        let sub = subscription;
        try {
          if ((await Notification.requestPermission()) !== 'granted')
            throw new Error('Notifications were not enabled; change browser permissions to try again');
          sub ||= await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: decode(state.publicKey),
          });
          const repos = [...content.querySelectorAll('[data-project]:checked')].map((e) => e.dataset.project);
          await api('/api/operations/notifications/subscribe', { subscription: sub.toJSON(), repos });
          localStorage.setItem(key, JSON.stringify(repos));
          status('Notifications enabled on this browser.');
          await init();
        } catch (e) {
          if (!subscription && sub) await sub.unsubscribe().catch(() => {});
          status(e.message);
        } finally {
          busy = false;
          event.target.disabled = false;
        }
      };
      document.getElementById('notifications-disable').onclick = async (event) => {
        if (busy) return;
        busy = true;
        event.target.disabled = true;
        try {
          await api('/api/operations/notifications/unsubscribe', { endpoint: subscription.endpoint });
          await subscription.unsubscribe();
          status('Notifications disabled on this browser.');
          await init();
        } catch (e) {
          status(e.message);
        } finally {
          busy = false;
          event.target.disabled = false;
        }
      };
    } catch (e) {
      status(e.message);
    }
  }
  void init();
})();
