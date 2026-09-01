# MCP Session Recovery and rmcp Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the tracker to `rmcp 3.2.0` so stale Streamable HTTP MCP sessions return `404` and clients can initialize a replacement session, while hardening container recovery.

**Architecture:** The backend remains an Axum application with an embedded `rmcp` Streamable HTTP service and a local in-memory session manager. The dependency migration replaces the incorrect `401` stale-session behavior in rmcp 0.10.0 with its standards-compliant `404`; no custom response-rewriting middleware is introduced. Docker Compose extends the idle session lifetime and detects/restarts a terminated application process.

**Tech Stack:** Rust 2021, Rust 1.96 Docker builder (declared MSRV 1.88), Axum 0.8, rmcp 3.2.0, Tokio, Reqwest, Docker Compose.

---

## File Structure

- `backend/Cargo.toml` — records the Rust MSRV and direct dependency constraints.
- `backend/Cargo.lock` — resolves the rmcp/Axum upgrade and compatible patch releases.
- `backend/src/lib.rs` — owns Streamable HTTP router construction, session lifetime and Host-allowlist configuration, and raw HTTP transport regression tests.
- `backend/src/mcp.rs` — retains MCP tool handlers; only adjusted when rmcp 3.2.0 compilation identifies an API incompatibility.
- `backend/tests/mcp.rs` — verifies authenticated tool round trips still work through the upgraded transport.
- `docker-compose.yml` — defines production idle lifetime, healthcheck, and restart behavior.
- `README.md` — documents session recovery expectations and operational values if its MCP configuration section needs updating.

### Task 2.1: Allow the production reverse-proxy authority

**Files:**
- Modify: `backend/src/lib.rs`
- Modify: `docker-compose.yml`
- Modify: `README.md`

- [ ] Configure `StreamableHttpServerConfig::with_allowed_hosts` from a comma-separated
  `MCP_ALLOWED_HOSTS` environment variable. The default list must retain rmcp's loopback
  authorities (`localhost`, `127.0.0.1`, and `::1`); a configured value replaces that default
  list.
- [ ] Add a raw HTTP `initialize` regression test using `Host: tracker.home.kurbezz.me` and
  assert success plus `mcp-session-id`. Keep arbitrary hosts rejected by the transport with 403.
- [ ] Set `MCP_ALLOWED_HOSTS: "tracker.home.kurbezz.me"` in Compose and document that this
  restrictive allowlist prevents DNS rebinding while permitting the production reverse proxy.

### Task 1: Establish the stale-session contract

**Files:**
- Modify: `backend/src/lib.rs:205-260`
- Test: `backend/src/lib.rs:205-260`

- [ ] **Step 1: Change the existing expiry assertion into the desired transport contract**

Rename `mcp_session_expires_after_inactivity` to `mcp_session_expiry_returns_not_found_and_allows_reinitialization`. Change the stale-session assertion and append a second initialization request:

```rust
assert_eq!(resumed.status(), reqwest::StatusCode::NOT_FOUND);

let reinitialized = client
    .post(&url)
    .header("x-api-key", "test-key")
    .header("accept", "application/json, text/event-stream")
    .json(&serde_json::json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "initialize",
        "params": ClientInfo::default(),
    }))
    .send()
    .await
    .expect("replacement initialize request should complete");

assert!(reinitialized.status().is_success());
assert!(reinitialized.headers().contains_key("mcp-session-id"));
```

- [ ] **Step 2: Run the focused test and verify the expected RED failure**

Run:

```bash
cargo test --manifest-path backend/Cargo.toml mcp_session_expiry_returns_not_found_and_allows_reinitialization -- --exact
```

Expected: the test fails because rmcp 0.10.0 returns `401 Unauthorized` to the request containing the expired session ID.

### Task 2: Upgrade the HTTP/MCP dependency boundary

**Files:**
- Modify: `backend/Cargo.toml:1-37`
- Modify: `backend/Cargo.lock`
- Modify: `backend/src/lib.rs:1-145`
- Modify: `backend/src/mcp.rs:1-253` (only if the compiler requires API adaptation)
- Test: `backend/src/lib.rs:205-280`
- Test: `backend/tests/mcp.rs:1-730`

- [ ] **Step 1: Declare the supported compiler and target dependencies**

In `[package]`, retain edition 2021 and add:

```toml
rust-version = "1.88"
```

Replace the Axum and rmcp declarations with exact migration targets:

```toml
axum = { version = "=0.8.9", features = ["ws"] }
rmcp = { version = "=3.2.0", features = [
  "server",
  "transport-streamable-http-server",
  "client",
  "transport-streamable-http-client-reqwest",
] }
```

Leave unrelated direct major lines unchanged, including `rand = "0.8"`, `sqlx = "0.8"`, and `reqwest = "0.12"`.

- [ ] **Step 2: Refresh only the declared dependency graph**

Run:

```bash
cargo update --manifest-path backend/Cargo.toml
```

Expected: `backend/Cargo.lock` records rmcp 3.2.0, Axum 0.8.9, and compatible transitive releases without changing unrelated source files.

- [ ] **Step 3: Compile and resolve rmcp/Axum API breakage minimally**

Run:

```bash
cargo check --manifest-path backend/Cargo.toml
```

Expected: either a clean build or compiler diagnostics limited to the MCP transport/tool imports and Axum service integration.

If the compiler reports changed model/result APIs in `backend/src/mcp.rs`, preserve each existing tool's public name, parameter type, success content, and tool-level error text while adapting only the reported rmcp types. Keep the existing server construction shape unless the compiler requires a new rmcp 3.2.0 type:

```rust
StreamableHttpService::new(
    move || {
        Ok(mcp::TaskMcpServer::new(
            mcp_pool.clone(),
            mcp_events.clone(),
            mcp_clockify.clone(),
        ))
    },
    LocalSessionManager {
        session_config,
        ..Default::default()
    }
    .into(),
    StreamableHttpServerConfig::default(),
)
```

Do not add a middleware that rewrites all `401` responses: authentication failures must stay `401`, while the upgraded transport itself produces `404` for stale sessions.

- [ ] **Step 4: Verify GREEN for the stale-session contract**

Run:

```bash
cargo test --manifest-path backend/Cargo.toml mcp_session_expiry_returns_not_found_and_allows_reinitialization -- --exact
```

Expected: PASS. The expired-session request is `404`; the subsequent initialize request succeeds and returns a new `mcp-session-id`.

- [ ] **Step 5: Verify existing authentication and tool contracts**

Run:

```bash
cargo test --manifest-path backend/Cargo.toml --test mcp mcp_route_rejects_missing_api_key -- --exact
cargo test --manifest-path backend/Cargo.toml --test mcp mcp_route_rejects_invalid_api_key -- --exact
cargo test --manifest-path backend/Cargo.toml --test mcp ping_tool_round_trips_over_authenticated_mcp_session -- --exact
```

Expected: all pass; invalid and absent API keys remain `401`, and an authenticated client can initialize, list tools, call `ping`, and cancel cleanly.

### Task 3: Make session lifetime and process recovery operationally explicit

**Files:**
- Modify: `docker-compose.yml:1-14`
- Modify: `README.md` (only in the existing MCP/deployment configuration section)

- [ ] **Step 1: Add the production Compose resilience settings**

Update the `app` service to use a 24-hour session lifetime, restart after process exit, and probe the existing health endpoint:

```yaml
services:
  app:
    build: .
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: sqlite:data/tracker.db
      BIND_ADDR: 0.0.0.0:3000
      MCP_SESSION_KEEP_ALIVE_SECS: "86400"
    volumes:
      - tracker-data:/app/data
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:3000/health | grep -qx ok"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

Install `wget` in the final `debian:bookworm-slim` image if it is not present, before creating the non-root user:

```dockerfile
RUN apt-get update \
    && apt-get install --yes --no-install-recommends wget \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system app \
    && useradd --system --gid app --create-home app
```

- [ ] **Step 2: Document the lifecycle contract**

In README's MCP configuration section, add text equivalent to:

```markdown
MCP sessions are in-memory. After an idle timeout or server restart, a request
using the old `Mcp-Session-Id` receives HTTP 404. MCP clients must create a new
session by sending `initialize` without that header. The Compose deployment uses
a 24-hour idle timeout and restarts the container when its process exits.
```

- [ ] **Step 3: Validate the configuration and image build**

Run:

```bash
docker compose config
docker build -t ai-task-tracker:mcp-session-recovery .
```

Expected: Compose renders a valid `healthcheck` and `restart: unless-stopped`; the image build succeeds and includes `wget` for the healthcheck command.

### Task 4: Run the release verification suite

**Files:**
- Verify only: `backend/`, `docker-compose.yml`, `Dockerfile`, `README.md`

- [ ] **Step 1: Format the Rust migration**

Run:

```bash
cargo fmt --manifest-path backend/Cargo.toml --check
```

Expected: no formatting differences.

- [ ] **Step 2: Run all backend tests**

Run:

```bash
cargo test --manifest-path backend/Cargo.toml
```

Expected: all unit and integration tests pass, including stale-session `404`, authentication `401`, and existing tool behavior.

- [ ] **Step 3: Run the linter**

Run:

```bash
cargo clippy --manifest-path backend/Cargo.toml --all-targets -- -D warnings
```

Expected: no warnings or errors.

- [ ] **Step 4: Review the staged implementation scope**

Run:

```bash
git diff -- backend/Cargo.toml backend/Cargo.lock backend/src/lib.rs backend/src/mcp.rs backend/tests/mcp.rs Dockerfile docker-compose.yml README.md docs/superpowers/specs/2026-09-01-mcp-session-recovery-and-rmcp-upgrade-design.md docs/superpowers/plans/2026-09-01-mcp-session-recovery-rmcp-upgrade.md
```

Expected: only the MCP session-recovery migration, container resilience, and its documentation are present; unrelated pre-existing edits remain untouched.

## Plan Self-Review

- Spec coverage: Tasks 1–2 cover standards-compliant stale-session recovery and retain `401` authentication handling; Task 3 covers the configured lifetime, healthcheck, and restart policy; Task 4 validates compile, behavior, quality, image, and diff scope.
- Placeholder scan: no deferred implementation or unspecified test behavior remains; compiler-guided API adaptation is constrained to preserving existing public tool behavior.
- Type consistency: the plan consistently uses `Mcp-Session-Id`, `initialize`, `404 Not Found`, `401 Unauthorized`, `StreamableHttpService`, `LocalSessionManager`, Axum 0.8.9, and rmcp 3.2.0.
