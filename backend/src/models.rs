use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub created_at: String,
}

#[derive(Deserialize)]
pub struct CreateProject {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateProject {
    pub name: Option<String>,
    #[serde(default)]
    pub description: PatchField<String>,
}

#[derive(Default)]
pub enum PatchField<T> {
    #[default]
    Omitted,
    Value(Option<T>),
}

impl<'de, T> Deserialize<'de> for PatchField<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(Self::Value(Option::<T>::deserialize(deserializer)?))
    }
}

impl<T> PatchField<T> {
    pub fn resolve(self, current: Option<T>) -> Option<T> {
        match self {
            Self::Omitted => current,
            Self::Value(value) => value,
        }
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Task {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub agent: Option<String>,
    pub result_summary: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskResponse {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description: Option<String>,
    pub status: Status,
    pub agent: Option<String>,
    pub result_summary: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Vec<Tag>,
}

impl TaskResponse {
    pub fn new(task: Task, tags: Vec<Tag>) -> Self {
        Self {
            id: task.id,
            project_id: task.project_id,
            title: task.title,
            description: task.description,
            status: task
                .status
                .parse()
                .expect("database task statuses must be valid"),
            agent: task.agent,
            result_summary: task.result_summary,
            created_at: task.created_at,
            updated_at: task.updated_at,
            tags,
        }
    }
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct CreateTask {
    pub project_id: String,
    pub title: String,
    pub description: Option<String>,
    pub agent: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateTask {
    pub title: Option<String>,
    #[serde(default)]
    pub description: PatchField<String>,
    #[serde(default)]
    pub agent: PatchField<String>,
    #[serde(default)]
    pub result_summary: PatchField<String>,
}

#[derive(Deserialize)]
pub struct TransitionRequest {
    pub status: Status,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub is_system: bool,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct TaskLog {
    pub id: String,
    pub task_id: String,
    pub author: String,
    pub message: String,
    pub created_at: String,
}

#[derive(Deserialize)]
pub struct CreateLog {
    pub author: String,
    pub message: String,
}

#[derive(Deserialize)]
pub struct AttachTag {
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AttentionItem {
    #[serde(flatten)]
    pub task: TaskResponse,
    pub project_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Status {
    ToDo,
    ToAgent,
    ToReview,
    ToDeploy,
    Done,
}

impl Status {
    pub const ORDER: [Self; 5] = [
        Self::ToDo,
        Self::ToAgent,
        Self::ToReview,
        Self::ToDeploy,
        Self::Done,
    ];

    pub fn can_transition_to(self, target: Self) -> bool {
        let from = Self::ORDER
            .iter()
            .position(|status| *status == self)
            .unwrap();
        let to = Self::ORDER
            .iter()
            .position(|status| *status == target)
            .unwrap();
        to < from || to == from + 1
    }
}

impl std::fmt::Display for Status {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}",
            serde_json::to_string(self).unwrap().trim_matches('"')
        )
    }
}

impl std::str::FromStr for Status {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        serde_json::from_value(serde_json::Value::String(value.to_owned()))
            .map_err(|_| format!("unknown status: {value}"))
    }
}
