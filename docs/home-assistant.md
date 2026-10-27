# Connect Home Assistant to Briareus

Each Briareus user connects their own Home Assistant; nobody reaches anyone else's.

1. In Home Assistant, open your profile's **Security** tab and create a long-lived access token.
2. Connect it with your own Briareus token: `PUT /api/v1/me/home-assistant` with
   `{"url":"http://homeassistant.local:8123","token":"…"}`. It is saved only once Home
   Assistant answers, stored encrypted (`CREDENTIALS_KEY`), and never returned;
   `GET /api/v1/me/home-assistant` shows the address, `DELETE` disconnects it.
3. Call `GET /api/v1/home-assistant` and check for `{"configured":true,"connected":true}`.

The server's own `HOME_ASSISTANT_URL` and `HOME_ASSISTANT_TOKEN`, set in its environment
outside session checkouts (restart after setting them), still work: they are the original
operator's Home Assistant (the first user, whatever their role now), from when the server had
one operator, until that user connects one of their own.

For a Briareus process running directly on the host, use `HOME_ASSISTANT_URL=http://127.0.0.1:8123`.
For a Briareus container, use the host's LAN address, such as `http://192.0.2.10:8123`; loopback inside that container refers to the container itself.
Use the base URL without `/api`. Configure both values or leave both unset. Unset, they do not turn the bridge off:
users still connect their own Home Assistant, and only the original operator's fallback is gone.
The Compose app forwards these variables to the server without writing the token into its checkout.

Clients authenticate with their own Briareus token. The server adds the user's Home Assistant token to upstream requests; it never returns it to clients.
A `read` token reads entities and services; calling services and firing events needs `manage`. The bridge operates independently of projects and agent sessions.

An entity is a state or capability, such as `light.kitchen` or `sensor.temperature`.
One physical device can provide several entities. This bridge lists entities, not the physical device or area registries.
Device setup, pairing, and integration configuration remain in Home Assistant.

Use the following calls to find entities and control them:

```sh
# List every entity and its current state.
curl "$BRIAREUS_URL/api/v1/home-assistant/entities" \
  -H "Authorization: Bearer $BRIAREUS_TOKEN"

# Read one entity; replace the example ID with one from the list.
curl "$BRIAREUS_URL/api/v1/home-assistant/entities/light.kitchen" \
  -H "Authorization: Bearer $BRIAREUS_TOKEN"

# Filter entities by domain and discover the actual entity IDs.
curl "$BRIAREUS_URL/api/v1/home-assistant/entities?domain=vacuum" \
  -H "Authorization: Bearer $BRIAREUS_TOKEN"

# Discover actions and their input fields before choosing one.
curl "$BRIAREUS_URL/api/v1/home-assistant/services" \
  -H "Authorization: Bearer $BRIAREUS_TOKEN"

# Replace vacuum.mova with an entity ID returned by the first call.
curl "$BRIAREUS_URL/api/v1/home-assistant/services/vacuum/start" \
  -H "Authorization: Bearer $BRIAREUS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"entity_id":"vacuum.mova"}'

# Turn on a light with service-specific data.
curl "$BRIAREUS_URL/api/v1/home-assistant/services/light/turn_on" \
  -H "Authorization: Bearer $BRIAREUS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"entity_id":"light.kitchen","brightness":128}'

# Send an event to an existing Home Assistant automation.
curl "$BRIAREUS_URL/api/v1/home-assistant/events/briareus_command" \
  -H "Authorization: Bearer $BRIAREUS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"source":"briareus","command":"arriving_home"}'
```

Only integrations and entities already configured in Home Assistant appear here.
Complete MOVA's cloud login and any device pairing in Home Assistant before controlling those devices through Briareus.

Poll `/entities` or `/entities/{id}` while a client screen is visible to refresh state.
There is no event subscription in this bridge; `/events/{type}` sends events to Home Assistant.
Calls use Home Assistant's [REST API](https://developers.home-assistant.io/docs/api/rest/).
Use `?returnResponse=1` on a service call when that service requires response data.

After an action times out or returns an invalid receipt, read the entity state before retrying.
The bridge never retries an action automatically. Changed states do not prove a physical device finished its action.
An upstream authentication failure returns 502, so clients do not interpret it as a rejected Briareus login.

See the [API reference](api-v1-reference.md#home-assistant) for response shapes and endpoints.
