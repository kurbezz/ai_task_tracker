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

## MCP server for AI agents

Agents can self-report their own progress (create tasks, move status, add logs, set tags,
update agent/result) by connecting to the built-in MCP server instead of calling the REST API
directly. The authenticated endpoint is mounted at `/mcp` on the same binary and port as the REST
API; supply the same `X-Api-Key` used for `/api` requests.

Example client configuration (Claude Code / opencode style):

```json
{
  "mcpServers": {
    "ai-task-tracker": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "X-Api-Key": "replace-with-your-key"
      }
    }
  }
}
```

Available tools: `create_task`, `get_task`, `list_projects`, `list_project_tasks`,
`transition_task_status`, `add_task_log`, `add_task_tag`, `remove_task_tag`, `update_task`.
Each tool shares the REST API's validation, persistence, and workflow-transition rules.
