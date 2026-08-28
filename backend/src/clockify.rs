use chrono::{DateTime, Duration, NaiveDate, SecondsFormat, TimeZone, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone)]
pub struct ClockifyConfig {
    pub api_key: String,
    pub workspace_id: String,
    pub project_id: Option<String>,
    pub base_url: String,
}

impl ClockifyConfig {
    pub fn from_env() -> Option<Self> {
        let api_key = std::env::var("CLOCKIFY_API_KEY")
            .ok()
            .filter(|value| !value.is_empty())?;
        let workspace_id = std::env::var("CLOCKIFY_WORKSPACE_ID")
            .ok()
            .filter(|value| !value.is_empty())?;

        Some(Self {
            api_key,
            workspace_id,
            project_id: std::env::var("CLOCKIFY_PROJECT_ID")
                .ok()
                .filter(|value| !value.is_empty()),
            base_url: std::env::var("CLOCKIFY_BASE_URL")
                .unwrap_or_else(|_| "https://api.clockify.me/api/v1".to_owned())
                .trim_end_matches('/')
                .to_owned(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ClockifyTimeEntryRequest {
    pub start: String,
    pub end: String,
    pub description: String,
    #[serde(rename = "projectId", skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

#[derive(Deserialize)]
struct ClockifyTimeEntryResponse {
    id: String,
}

pub struct ClockifyError {
    pub status: Option<reqwest::StatusCode>,
    pub message: String,
}

#[derive(Clone, sqlx::FromRow)]
pub struct TimeEntryDescriptionRow {
    pub task_title: String,
    pub minutes: i64,
}

pub fn build_time_entry_request(
    entry_date: &str,
    entries: &[TimeEntryDescriptionRow],
    project_id: Option<String>,
) -> Result<ClockifyTimeEntryRequest, String> {
    let date = NaiveDate::parse_from_str(entry_date, "%Y-%m-%d")
        .map_err(|_| "entry_date must be YYYY-MM-DD".to_owned())?;
    let start = Utc.from_utc_datetime(
        &date
            .and_hms_opt(0, 0, 0)
            .expect("midnight is always a valid time"),
    );
    let total_minutes: i64 = entries.iter().map(|entry| entry.minutes).sum();
    let end = start + Duration::minutes(total_minutes);
    let description = entries
        .iter()
        .map(|entry| format!("{} ({}h)", entry.task_title, format_hours(entry.minutes)))
        .collect::<Vec<_>>()
        .join(", ");

    Ok(ClockifyTimeEntryRequest {
        start: format_timestamp(start),
        end: format_timestamp(end),
        description,
        project_id,
    })
}

pub async fn create_time_entry(
    config: &ClockifyConfig,
    entry: &ClockifyTimeEntryRequest,
) -> Result<String, ClockifyError> {
    send_time_entry(
        reqwest::Client::new()
            .post(format!(
                "{}/workspaces/{}/time-entries",
                config.base_url, config.workspace_id
            ))
            .header("X-Api-Key", &config.api_key)
            .json(entry),
    )
    .await
}

pub async fn update_time_entry(
    config: &ClockifyConfig,
    id: &str,
    entry: &ClockifyTimeEntryRequest,
) -> Result<String, ClockifyError> {
    send_time_entry(
        reqwest::Client::new()
            .put(format!(
                "{}/workspaces/{}/time-entries/{id}",
                config.base_url, config.workspace_id
            ))
            .header("X-Api-Key", &config.api_key)
            .json(entry),
    )
    .await
}

async fn send_time_entry(request: reqwest::RequestBuilder) -> Result<String, ClockifyError> {
    let response = request.send().await.map_err(|error| ClockifyError {
        status: None,
        message: format!("Clockify request failed: {error}"),
    })?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(ClockifyError {
            status: Some(status),
            message: format!("Clockify request failed with {status}: {body}"),
        });
    }
    response
        .json::<ClockifyTimeEntryResponse>()
        .await
        .map(|response| response.id)
        .map_err(|error| ClockifyError {
            status: None,
            message: format!("Clockify returned an invalid response: {error}"),
        })
}

fn format_timestamp(timestamp: DateTime<Utc>) -> String {
    timestamp.to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn format_hours(minutes: i64) -> String {
    let hours = minutes as f64 / 60.0;
    if hours.fract() == 0.0 {
        format!("{hours:.0}")
    } else {
        hours.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_clockify_request_from_daily_entries() {
        let request = build_time_entry_request(
            "2026-08-28",
            &[
                TimeEntryDescriptionRow {
                    task_title: "Task A".to_owned(),
                    minutes: 90,
                },
                TimeEntryDescriptionRow {
                    task_title: "Task B".to_owned(),
                    minutes: 30,
                },
            ],
            Some("project-1".to_owned()),
        )
        .unwrap();

        assert_eq!(request.start, "2026-08-28T00:00:00Z");
        assert_eq!(request.end, "2026-08-28T02:00:00Z");
        assert_eq!(request.description, "Task A (1.5h), Task B (0.5h)");
        assert_eq!(request.project_id.as_deref(), Some("project-1"));
    }
}
