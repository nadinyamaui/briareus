// @ts-check
import { Router } from 'express';
import { testProviderEndpoint, probeChatEndpoint, codexEndpointDefaultModel } from './providers.js';
import { asList, providerDefaultModel } from './providerstore.js';

// The Test button: probe the endpoint and token as the form holds them (no save needed)
// by listing its models, which come back for the Models field. A gateway without a model
// list gets a minimal chat call instead, as the model the saved row would default to
// (codexEndpointDefaultModel on codex, the picker's default on claude, the form's default
// or first <service>/<model> on opencode).
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
        // Resolved only now: a list-less codex form reads the models cache, looked up as
        // the saved row's own rather than trusting a posted id; an unsaved form has none.
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
