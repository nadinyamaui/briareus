# Connect Home Assistant to Briareus

1. In Home Assistant, open your profile's **Security** tab and create a long-lived access token.
2. Set `HOME_ASSISTANT_URL` and `HOME_ASSISTANT_TOKEN` in Briareus's server environment, outside session checkouts.
3. Restart Briareus after deploying the bridge.
4. Call `GET /api/v1/home-assistant` with a Briareus admin token and check for `{"configured":true,"connected":true}`.

For a Briareus process running directly on Spark, use `HOME_ASSISTANT_URL=http://127.0.0.1:8123`.
For a Briareus container, use the host's LAN address, such as `http://192.168.1.47:8123`; loopback inside that container refers to the container itself.
Use the base URL without `/api`. Configure both values or leave both unset to disable the bridge.
The Compose app forwards these variables to the server without writing the token into its checkout.

Clients authenticate with their Briareus admin token. The server adds Home Assistant's token to upstream requests; it never returns it to clients.
Read and manage tokens cannot use the bridge. The bridge operates independently of projects and agent sessions.

An entity is a state or capability, such as `light.kitchen` or `sensor.temperature`.
One physical device can provide several entities. This bridge lists entities, not the physical device or area registries.
Device setup, pairing, and integration configuration remain in Home Assistant.

Use the following calls to find entities and control them:

```sh
# List every entity and its current state.
curl "$BRIAREUS_URL/api/v1/home-assistant/entities" \
  -H "Authorization: Bearer $BRIAREUS_ADMIN_TOKEN"

# Read one entity; replace the example ID with one from the list.
curl "$BRIAREUS_URL/api/v1/home-assistant/entities/light.kitchen" \
  -H "Authorization: Bearer $BRIAREUS_ADMIN_TOKEN"

# Filter entities by domain and discover the actual entity IDs.
curl "$BRIAREUS_URL/api/v1/home-assistant/entities?domain=vacuum" \
  -H "Authorization: Bearer $BRIAREUS_ADMIN_TOKEN"

# Discover actions and their input fields before choosing one.
curl "$BRIAREUS_URL/api/v1/home-assistant/services" \
  -H "Authorization: Bearer $BRIAREUS_ADMIN_TOKEN"

# Replace vacuum.mova with an entity ID returned by the first call.
curl "$BRIAREUS_URL/api/v1/home-assistant/services/vacuum/start" \
  -H "Authorization: Bearer $BRIAREUS_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"entity_id":"vacuum.mova"}'

# Turn on a light with service-specific data.
curl "$BRIAREUS_URL/api/v1/home-assistant/services/light/turn_on" \
  -H "Authorization: Bearer $BRIAREUS_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"entity_id":"light.kitchen","brightness":128}'

# Send an event to an existing Home Assistant automation.
curl "$BRIAREUS_URL/api/v1/home-assistant/events/briareus_command" \
  -H "Authorization: Bearer $BRIAREUS_ADMIN_TOKEN" \
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
