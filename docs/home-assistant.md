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

## Home Assistant from a session

Projects with `homeAssistantToolsEnabled: true` give their interactive sessions an internal
MCP (`reviewer_home_assistant`), so a chat can start a vacuum or turn on a light when the user asks:

| Tool              | What it does                                                    |
| ----------------- | --------------------------------------------------------------- |
| `ha_status`       | Whether the owner's Home Assistant is connected and answering   |
| `ha_entities`     | Entity ids, names and states, filtered by `domain` and `search` |
| `ha_entity`       | One entity's state, attributes and change times                 |
| `ha_services`     | The actions Home Assistant offers and their fields, by `domain` |
| `ha_call_service` | Run an action, such as `vacuum.start`, with its service data    |
| `ha_fire_event`   | Fire an event for an automation listening for it                |

The setting is off by default for existing and new projects. An admin opts a project in with
`PUT /api/v1/settings/projects/{id}` and `{ "homeAssistantToolsEnabled": true }`, and revokes
it with `false`; it is independent of the mail, WhatsApp and print tools. The tools appear on
the next turn of an eligible session, and revocation takes effect on every call, including
tools loaded earlier.

A session reaches its owner's Home Assistant, the one they connected with
`PUT /api/v1/me/home-assistant`, or the server's own `HOME_ASSISTANT_URL` for the original
operator, resolved on every call. Without one, `ha_status` answers
`{"configured":false}` and actions fail with 503 until the owner connects it from a client;
the token is never handed to the session. Only interactive chats get the tools: never
review, QA or worker sessions, read-only analysts, previews, or turns nobody is watching,
since an action switches a real device.

Without MCP, the same calls are on `/api/agent/home-assistant` with the session's
`REVIEWER_MEMORY_TOKEN`: `GET /`, `GET /entities?domain&search`, `GET /entities/{id}`,
`GET /services?domain`, `POST /services/{domain}/{service}` (`?returnResponse=1`) and
`POST /events/{type}`. Lists and receipts carry each entity's id, name and state only;
read the entity for its attributes.
