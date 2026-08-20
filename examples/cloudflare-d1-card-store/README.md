# Cloudflare D1 card store

This example provides an authenticated remote replica for DevSpace card snapshots.
DevSpace continues to write its local SQLite database first. When configured with
the environment variables below, it mirrors cards to this service and uses it only
when a local card lookup misses.

The Worker needs:

- a D1 binding named `DB`, initialized with `schema.sql`;
- a Worker secret named `CARD_STORE_TOKEN`;
- a public Worker URL that DevSpace can reach over HTTPS.

Configure DevSpace with:

```text
DEVSPACE_CARD_STORE_URL=https://your-worker.example.workers.dev
DEVSPACE_CARD_STORE_TOKEN=<same secret as the Worker>
DEVSPACE_CARD_STORE_TIMEOUT_MS=5000
```

Only `GET /cards/:id` and `PUT /cards/:id` are exposed, and both require the
Bearer token. Do not make the D1 database or token available to browser clients.
