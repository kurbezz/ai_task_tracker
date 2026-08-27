use rmcp::{
    handler::server::router::tool::ToolRouter,
    model::{CallToolResult, Content, ServerCapabilities, ServerInfo},
    tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler,
};
use sqlx::SqlitePool;

#[derive(Clone)]
pub struct TaskMcpServer {
    _pool: SqlitePool,
    tool_router: ToolRouter<TaskMcpServer>,
}

impl TaskMcpServer {
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            _pool: pool,
            tool_router: Self::tool_router(),
        }
    }
}

#[tool_router]
impl TaskMcpServer {
    #[tool(description = "Health check for the AI Task Tracker MCP server")]
    async fn ping(&self) -> Result<CallToolResult, McpError> {
        Ok(CallToolResult::success(vec![Content::text("pong")]))
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
