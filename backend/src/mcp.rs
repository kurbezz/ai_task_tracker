use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, Content, ServerCapabilities, ServerInfo},
    tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler,
};
use sqlx::SqlitePool;

use crate::{
    error::AppError,
    handlers::{projects, tasks},
    models::{CreateLog, CreateTask, Status},
    AppState,
};

fn json_result<T: serde::Serialize>(value: &T) -> Result<CallToolResult, McpError> {
    let text = serde_json::to_string(value)
        .map_err(|error| McpError::internal_error(error.to_string(), None))?;
    Ok(CallToolResult::success(vec![Content::text(text)]))
}

fn tool_result<T: serde::Serialize>(
    result: Result<T, AppError>,
) -> Result<CallToolResult, McpError> {
    match result {
        Ok(value) => json_result(&value),
        Err(AppError::NotFound) => Ok(CallToolResult::error(vec![Content::text("not found")])),
        Err(AppError::Validation(message) | AppError::InvalidTransition(message)) => {
            Ok(CallToolResult::error(vec![Content::text(message)]))
        }
        Err(AppError::Internal(error)) => {
            eprintln!("internal database error: {error}");
            Err(McpError::internal_error("internal server error", None))
        }
        Err(_) => Err(McpError::internal_error("unexpected error", None)),
    }
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct GetTaskParams {
    task_id: String,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct ListProjectTasksParams {
    project_id: String,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct TransitionTaskStatusParams {
    task_id: String,
    status: Status,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct AddTaskLogParams {
    task_id: String,
    author: String,
    message: String,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct AddTaskTagParams {
    task_id: String,
    name: String,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct RemoveTaskTagParams {
    task_id: String,
    tag_id: String,
}

#[derive(Clone)]
pub struct TaskMcpServer {
    pool: SqlitePool,
    tool_router: ToolRouter<TaskMcpServer>,
}

impl TaskMcpServer {
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            pool,
            tool_router: Self::tool_router(),
        }
    }

    fn state(&self) -> AppState {
        AppState {
            pool: self.pool.clone(),
        }
    }
}

#[tool_router]
impl TaskMcpServer {
    #[tool(description = "Health check for the AI Task Tracker MCP server")]
    async fn ping(&self) -> Result<CallToolResult, McpError> {
        Ok(CallToolResult::success(vec![Content::text("pong")]))
    }

    #[tool(description = "Create a new task in a project. New tasks start in TODO status.")]
    async fn create_task(
        &self,
        Parameters(input): Parameters<CreateTask>,
    ) -> Result<CallToolResult, McpError> {
        let state = self.state();
        tool_result(tasks::create_task_core(&state, input).await)
    }

    #[tool(description = "Get a task by id, including its current status and tags")]
    async fn get_task(
        &self,
        Parameters(GetTaskParams { task_id }): Parameters<GetTaskParams>,
    ) -> Result<CallToolResult, McpError> {
        let state = self.state();
        let result = async {
            let task = tasks::fetch_task(&state, &task_id).await?;
            tasks::task_response(&state, task).await
        }
        .await;
        tool_result(result)
    }

    #[tool(description = "List all projects")]
    async fn list_projects(&self) -> Result<CallToolResult, McpError> {
        let state = self.state();
        tool_result(projects::list_projects_core(&state).await)
    }

    #[tool(description = "List all tasks in a project")]
    async fn list_project_tasks(
        &self,
        Parameters(ListProjectTasksParams { project_id }): Parameters<ListProjectTasksParams>,
    ) -> Result<CallToolResult, McpError> {
        let state = self.state();
        tool_result(tasks::list_project_tasks_core(&state, &project_id).await)
    }

    #[tool(
        description = "Move a task to a new workflow status. Only the next stage or any earlier stage (rework) is allowed."
    )]
    async fn transition_task_status(
        &self,
        Parameters(TransitionTaskStatusParams { task_id, status }): Parameters<
            TransitionTaskStatusParams,
        >,
    ) -> Result<CallToolResult, McpError> {
        let state = self.state();
        tool_result(tasks::transition_task_core(&state, &task_id, status).await)
    }

    #[tool(description = "Append a log entry to a task's timeline")]
    async fn add_task_log(
        &self,
        Parameters(AddTaskLogParams {
            task_id,
            author,
            message,
        }): Parameters<AddTaskLogParams>,
    ) -> Result<CallToolResult, McpError> {
        let state = self.state();
        tool_result(tasks::create_log_core(&state, &task_id, CreateLog { author, message }).await)
    }

    #[tool(
        description = "Attach a tag to a task (e.g. NEEDS_USER_INPUT, BLOCKED, FAILED, or a custom name). Idempotent."
    )]
    async fn add_task_tag(
        &self,
        Parameters(AddTaskTagParams { task_id, name }): Parameters<AddTaskTagParams>,
    ) -> Result<CallToolResult, McpError> {
        let state = self.state();
        tool_result(tasks::attach_tag_core(&state, &task_id, name).await)
    }

    #[tool(description = "Remove a tag from a task")]
    async fn remove_task_tag(
        &self,
        Parameters(RemoveTaskTagParams { task_id, tag_id }): Parameters<RemoveTaskTagParams>,
    ) -> Result<CallToolResult, McpError> {
        let state = self.state();
        match tasks::remove_tag_core(&state, &task_id, &tag_id).await {
            Ok(()) => Ok(CallToolResult::success(vec![Content::text("removed")])),
            Err(error) => tool_result::<()>(Err(error)),
        }
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for TaskMcpServer {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.instructions = Some(
            "Tools for AI agents to self-report progress on AI Task Tracker tasks.".to_owned(),
        );
        info
    }
}
