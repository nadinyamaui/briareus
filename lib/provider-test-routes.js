// @ts-check
import { Router } from 'express';
import { testProviderEndpoint, probeChatEndpoint, codexEndpointDefaultModel } from './providers.js';
import { asList, providerDefaultModel } from './providerstore.js';

// The Test button: probe an endpoint + token exactly as the form holds them
// (no save needed) by listing the endpoint's models. The list comes back so
// the page can drop it into the Models field. A gateway with no model list
// route is probed with a minimal chat call instead, as the model the saved row
// would default to, the one its status banner probes: on codex the one
// codexEndpointDefaultModel resolves, on claude the picker's default, on
// opencode the form's default or first model (its <service>/<model> ref).
export function providerTestRoutes({ getProvider, getConfig }) {
  const router = Router();
  router.post('/api/providers/test', async (req, res) => {
    try {
      const { binary, baseUrl, apiKey } = req.body || {};
      const defaultModel = String(req.body?.defaultModel || '').trim();
      // Parsed as the saved row's list is, so the probe sees what a save keeps.
      const models = asList(req.body?.models);
      try {
        return res.json({ models: await testProviderEndpoint({ binary, baseUrl, apiKey }) });
      } catch (e) {
        if (!e.routeMissing) throw e;
        // Resolved only now: on a list-less codex form it reads the models cache.
        // The cache is the saved row's own, looked up here rather than trusting
        // the posted id with a path; a form not saved yet has none of its own.
        const saved = binary === 'codex' ? getProvider(req.body?.id) : null;
        const model =
          binary === 'codex'
            ? codexEndpointDefaultModel({ id: saved?.id, baseUrl, apiKey, defaultModel, models })
            : binary === 'claude'
              ? providerDefaultModel({ binary, baseUrl, apiKey, defaultModel, models }, getConfig())
              : defaultModel || models[0] || '';
        if (!model) throw e;
        await probeChatEndpoint({ binary, baseUrl, apiKey, model });
        res.json({ models: [], probedModel: model });
      }
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  return router;
}
