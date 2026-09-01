# MCP Session Recovery and rmcp Upgrade Design

**Goal:** Make the remote AI Task Tracker MCP endpoint recover correctly after an expired or invalidated session, while migrating the Rust MCP stack to current `rmcp` and refreshing compatible dependencies.

**Non-goals:** Persist MCP sessions across process restarts, change task-tracker business tools, or modify OpenCode itself. A server restart still requires the client to initialize a new MCP session.

## Problem

The backend currently uses `rmcp = 0.10.0` with `LocalSessionManager` and a 30-minute inactivity timeout. That release responds with HTTP `401 Unauthorized` when a request supplies an expired `Mcp-Session-Id`. The Streamable HTTP MCP specification requires HTTP `404 Not Found` for a terminated or unknown session; clients use that response to discard the old session ID and send a new `initialize` request.

The tracker therefore works when a fresh MCP connection is created, but an existing OpenCode process can repeatedly fail to parse the stale-session response instead of recovering.

## Architecture

### Current MCP SDK migration

Migrate `rmcp` from the exact `0.10.0` pin to exact `3.2.0`, which requires Rust 1.88 and has a Streamable HTTP implementation aligned with the current MCP session-management requirement. Adapt the router mounting and server implementation to the current `rmcp` API instead of maintaining a custom response-status shim.

Keep the MCP endpoint embedded in the existing Axum backend. It will continue to share the SQLite pool, event broadcaster, Clockify configuration, and `X-Api-Key` authentication middleware with the REST API.

### Host allowlist

rmcp validates the `Host` authority on Streamable HTTP requests to mitigate DNS-rebinding
attacks. Configure `StreamableHttpServerConfig::with_allowed_hosts` from the comma-separated
`MCP_ALLOWED_HOSTS` environment variable. Its default allowlist is `localhost`, `127.0.0.1`,
and `::1`; a configured value replaces that list. Compose sets the production authority
explicitly so reverse-proxied MCP initialization succeeds, while arbitrary hosts remain HTTP
`403 Forbidden`.

### Session lifecycle

- Continue using a local, in-memory session manager; unknown sessions after a process restart are expected.
- Set the configured inactivity lifetime to 24 hours (`86400` seconds) to avoid unnecessary expiration during a normal working day.
- For an expired, closed, or unknown session ID, the endpoint must respond with HTTP `404`. A conforming client then creates a new session by sending `initialize` without `Mcp-Session-Id`.
- Invalid or missing API keys remain HTTP `401`; they must never be conflated with expired MCP sessions.

### Dependency updates

- Upgrade `rmcp` to exact `3.2.0` and use its current Streamable HTTP server/client feature names and APIs.
- Upgrade Axum from `0.7` to `0.8` only when required by the rmcp integration, adapting middleware and router types as needed.
- Refresh the lockfile for compatible direct dependency lines (`tokio`, `sqlx`, `reqwest`, `serde`, and related crates). Do not make independent major upgrades such as `rand 0.9` in this change.
- Declare the minimum supported Rust version in `Cargo.toml`, matching the MCP SDK requirement and the existing Rust 1.96 Docker image.

### Container resilience

Add a Docker Compose healthcheck for `GET /health` and `restart: unless-stopped` so Docker restarts the process after an exit. The healthcheck is an observability signal; it does not preserve sessions or restart a process that remains running but unhealthy.

## Error Handling

- Authentication middleware remains the only source of API-key `401` responses.
- The MCP transport owns session-state responses and must emit `404` for an unrecognized session ID.
- The MCP transport rejects `Host` authorities outside the configured allowlist with `403` before processing MCP requests.
- A restart, deploy, or idle expiration is safe: the next compliant client request reinitializes instead of repeatedly retrying a stale session.
- The service should log enough transport context to distinguish authentication rejection, unknown session, and internal failure without recording API keys or full request payloads.

## Testing and Verification

1. Add an integration test that initializes an MCP session, lets it expire under a short test-only timeout, resumes with its prior session ID, and expects `404 Not Found`.
2. Retain or add a test that a missing or invalid `X-Api-Key` receives `401 Unauthorized`.
3. Add a round-trip test proving that a new `initialize` request after expiration succeeds and yields a usable new session ID.
4. Add a raw MCP initialize test for the production Host authority and retain rejection of arbitrary hosts.
5. Run focused MCP tests, then the full backend test suite and formatting/lint checks.
6. Build the Docker image and validate the Compose healthcheck configuration.

## File-Level Scope

- `backend/Cargo.toml` — current SDK, framework, and MSRV declarations.
- `backend/Cargo.lock` — refreshed resolved dependency graph.
- `backend/src/lib.rs` — current rmcp router/session integration and session-expiry tests.
- `backend/src/mcp.rs` — only if required by current rmcp server API changes.
- `Dockerfile` — only if the declared MSRV and image need alignment.
- `docker-compose.yml` — session timeout, MCP Host allowlist, healthcheck, and restart policy.
- `README.md` — document client recovery expectations and deployment settings if the existing MCP section covers transport configuration.
