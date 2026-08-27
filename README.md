# AI Task Tracker

A self-hosted tracker for work executed by AI agents. The Rust service provides the API,
SQLite persistence, API-key authentication, and the production SPA server.

## Run locally

Before running any Cargo command, install the frontend dependencies. The backend build script
builds missing or outdated SPA assets so the Rust binary can embed them.

```bash
npm install --prefix frontend
```

Use two terminals for development:

```bash
# backend development terminal
DATABASE_URL=sqlite:data/tracker.db cargo run --manifest-path backend/Cargo.toml

# frontend development terminal
npm run dev --prefix frontend
```

The backend prints an initial API key once after creating an empty database. Save it when it
is printed: only its hash is stored. Paste it into the SPA's first-run setup screen; it remains
only in that browser's local storage. All `/api` requests require it in the `X-Api-Key` header.

For a production-style single binary, install the frontend dependencies once. The Cargo build
script builds the SPA assets before embedding them:

```bash
npm install --prefix frontend
cargo run --manifest-path backend/Cargo.toml
```

The binary binds to `127.0.0.1:3000`. Set `DATABASE_URL` to choose another SQLite URL; it
defaults to `sqlite:data/tracker.db`.

## Workflow and attention tags

Tasks move through these seven stages:

1. `TODO`
2. `IN_PLANNING`
3. `READY_TO_IMPLEMENT`
4. `IN_WORK`
5. `WAIT_REVIEW`
6. `READY_TO_DEPLOY`
7. `DONE`

The API permits a one-step forward transition or rework to any earlier stage. The system tags
`NEEDS_USER_INPUT`, `BLOCKED`, and `FAILED` identify attention items. Failures use the `FAILED`
tag plus a task log rather than a separate terminal workflow status.
