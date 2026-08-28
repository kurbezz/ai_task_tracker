use crate::models::{TaskLog, TaskResponse};

#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TaskEvent {
    TaskCreated { task: TaskResponse },
    TaskUpdated { task: TaskResponse },
    TaskDeleted { task_id: String, project_id: String },
    LogAdded { task_id: String, log: TaskLog },
}
