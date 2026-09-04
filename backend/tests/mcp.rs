mod support;

use rmcp::{
    model::{CallToolRequestParams, ClientInfo},
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
    },
    ServiceExt,
};

#[tokio::test]
async fn ping_tool_round_trips_over_authenticated_mcp_session() {
    let (base_url, server) = support::spawn_http_server(support::state().await).await;

    let headers = support::api_key_header().into_iter().collect();
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(format!("{base_url}/mcp"))
            .custom_headers(headers),
    );
    let client = ClientInfo::default()
        .serve(transport)
        .await
        .expect("authenticated client should connect");

    let tools = client
        .list_tools(Default::default())
        .await
        .expect("list tools");
    assert!(tools.tools.iter().any(|tool| tool.name == "ping"));

    let result = client
        .call_tool(
            CallToolRequestParams::new("ping")
                .with_arguments(serde_json::json!({}).as_object().cloned().unwrap()),
        )
        .await
        .expect("ping call should succeed");
    assert_ne!(result.is_error, Some(true));

    client.cancel().await.expect("cancel client");
    server.abort();
}

#[tokio::test]
async fn mcp_route_rejects_missing_api_key() {
    let (base_url, server) = support::spawn_http_server(support::state().await).await;

    let response = reqwest::Client::new()
        .post(format!("{base_url}/mcp"))
        .header("content-type", "application/json")
        .body(r#"{"jsonrpc":"2.0","method":"initialize","params":{},"id":1}"#)
        .send()
        .await
        .expect("request should complete");

    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    server.abort();
}

#[tokio::test]
async fn mcp_route_rejects_invalid_api_key() {
    let (base_url, server) = support::spawn_http_server(support::state().await).await;

    let response = reqwest::Client::new()
        .post(format!("{base_url}/mcp"))
        .header("x-api-key", "wrong-key")
        .header("content-type", "application/json")
        .body(r#"{"jsonrpc":"2.0","method":"initialize","params":{},"id":1}"#)
        .send()
        .await
        .expect("request should complete");

    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    server.abort();
}

async fn create_project(base_url: &str) -> String {
    let response = reqwest::Client::new()
        .post(format!("{base_url}/api/projects"))
        .header("x-api-key", "test-key")
        .json(&serde_json::json!({"name": "Tracker"}))
        .send()
        .await
        .expect("create project request should complete");
    let body: serde_json::Value = response.json().await.expect("json body");
    body["id"].as_str().expect("project id").to_owned()
}

#[tokio::test]
async fn create_task_and_get_task_tools_round_trip() {
    let (base_url, server) = support::spawn_http_server(support::state().await).await;
    let project_id = create_project(&base_url).await;

    let headers = support::api_key_header().into_iter().collect();
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(format!("{base_url}/mcp"))
            .custom_headers(headers),
    );
    let client = ClientInfo::default()
        .serve(transport)
        .await
        .expect("client connects");

    let create_args = serde_json::json!({
        "project_id": project_id,
        "title": "Ship the MCP server"
    })
    .as_object()
    .cloned()
    .expect("create args should be an object");
    let created = client
        .call_tool(CallToolRequestParams::new("create_task").with_arguments(create_args))
        .await
        .expect("create_task should succeed");
    assert_ne!(created.is_error, Some(true));
    let created_text = created.content.first().expect("content block");
    let created_task: serde_json::Value =
        serde_json::from_str(created_text.as_text().expect("text content").text.as_str())
            .expect("valid task json");
    assert_eq!(created_task["title"], "Ship the MCP server");
    assert_eq!(created_task["status"], "TO_DO");
    let task_id = created_task["id"].as_str().expect("task id").to_owned();

    let get_args = serde_json::json!({ "task_id": task_id })
        .as_object()
        .cloned()
        .expect("get args should be an object");
    let fetched = client
        .call_tool(CallToolRequestParams::new("get_task").with_arguments(get_args))
        .await
        .expect("get_task should succeed");
    assert_ne!(fetched.is_error, Some(true));

    client.cancel().await.expect("cancel client");
    server.abort();
}

#[tokio::test]
async fn delete_task_tool_removes_a_task() {
    let (base_url, server) = support::spawn_http_server(support::state().await).await;
    let project_id = create_project(&base_url).await;

    let headers = support::api_key_header().into_iter().collect();
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(format!("{base_url}/mcp"))
            .custom_headers(headers),
    );
    let client = ClientInfo::default()
        .serve(transport)
        .await
        .expect("client connects");

    let create_args = serde_json::json!({
        "project_id": project_id,
        "title": "Delete through MCP"
    })
    .as_object()
    .cloned()
    .expect("create args should be an object");
    let created = client
        .call_tool(CallToolRequestParams::new("create_task").with_arguments(create_args))
        .await
        .expect("create_task should succeed");
    let created_task: serde_json::Value = serde_json::from_str(
        created
            .content
            .first()
            .expect("content block")
            .as_text()
            .expect("text content")
            .text
            .as_str(),
    )
    .expect("valid task json");
    let task_id = created_task["id"].as_str().expect("task id").to_owned();

    let delete_args = serde_json::json!({ "task_id": task_id })
        .as_object()
        .cloned()
        .expect("delete args should be an object");
    let deleted = client
        .call_tool(CallToolRequestParams::new("delete_task").with_arguments(delete_args))
        .await
        .expect("delete_task should succeed");
    assert_ne!(deleted.is_error, Some(true));
    assert_eq!(
        deleted
            .content
            .first()
            .expect("content block")
            .as_text()
            .expect("text content")
            .text,
        "deleted"
    );

    let get_args = serde_json::json!({ "task_id": task_id })
        .as_object()
        .cloned()
        .expect("get args should be an object");
    let fetched = client
        .call_tool(CallToolRequestParams::new("get_task").with_arguments(get_args))
        .await
        .expect("get_task should return a tool-level error");
    assert_eq!(fetched.is_error, Some(true));
    assert_eq!(
        fetched
            .content
            .first()
            .expect("content block")
            .as_text()
            .expect("text content")
            .text,
        "not found"
    );

    client.cancel().await.expect("cancel client");
    server.abort();
}

#[tokio::test]
async fn list_projects_and_list_project_tasks_tools_return_created_data() {
    let (base_url, server) = support::spawn_http_server(support::state().await).await;
    let project_id = create_project(&base_url).await;

    let headers = support::api_key_header().into_iter().collect();
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(format!("{base_url}/mcp"))
            .custom_headers(headers),
    );
    let client = ClientInfo::default()
        .serve(transport)
        .await
        .expect("client connects");

    let list_projects_result = client
        .call_tool(
            CallToolRequestParams::new("list_projects")
                .with_arguments(serde_json::json!({}).as_object().cloned().unwrap()),
        )
        .await
        .expect("list_projects should succeed");
    let projects_text = list_projects_result.content.first().expect("content block");
    let projects: serde_json::Value =
        serde_json::from_str(projects_text.as_text().expect("text content").text.as_str())
            .expect("valid projects json");
    assert!(projects
        .as_array()
        .expect("projects array")
        .iter()
        .any(|project| project["id"] == project_id));

    let create_args = serde_json::json!({ "project_id": project_id, "title": "Task in project" })
        .as_object()
        .cloned()
        .expect("create args should be an object");
    client
        .call_tool(CallToolRequestParams::new("create_task").with_arguments(create_args))
        .await
        .expect("create_task should succeed");

    let list_tasks_args = serde_json::json!({ "project_id": project_id })
        .as_object()
        .cloned()
        .expect("list task args should be an object");
    let list_tasks_result = client
        .call_tool(CallToolRequestParams::new("list_project_tasks").with_arguments(list_tasks_args))
        .await
        .expect("list_project_tasks should succeed");
    let tasks_text = list_tasks_result.content.first().expect("content block");
    let tasks: serde_json::Value =
        serde_json::from_str(tasks_text.as_text().expect("text content").text.as_str())
            .expect("valid tasks json");
    assert_eq!(tasks.as_array().expect("tasks array").len(), 1);
    assert_eq!(tasks[0]["title"], "Task in project");

    client.cancel().await.expect("cancel client");
    server.abort();
}

#[tokio::test]
async fn transition_task_status_tool_enforces_workflow_rules() {
    let (base_url, server) = support::spawn_http_server(support::state().await).await;
    let project_id = create_project(&base_url).await;

    let headers = support::api_key_header().into_iter().collect();
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(format!("{base_url}/mcp"))
            .custom_headers(headers),
    );
    let client = ClientInfo::default()
        .serve(transport)
        .await
        .expect("client connects");

    let create_args = serde_json::json!({ "project_id": project_id, "title": "Transition me" })
        .as_object()
        .cloned()
        .expect("create args should be an object");
    let created = client
        .call_tool(CallToolRequestParams::new("create_task").with_arguments(create_args))
        .await
        .expect("create_task should succeed");
    let created_task: serde_json::Value = serde_json::from_str(
        created
            .content
            .first()
            .expect("content block")
            .as_text()
            .expect("text content")
            .text
            .as_str(),
    )
    .expect("valid task json");
    let task_id = created_task["id"].as_str().expect("task id").to_owned();

    let invalid_args = serde_json::json!({ "task_id": task_id, "status": "TO_REVIEW" })
        .as_object()
        .cloned()
        .expect("invalid args should be an object");
    let invalid = client
        .call_tool(
            CallToolRequestParams::new("transition_task_status").with_arguments(invalid_args),
        )
        .await
        .expect("invalid transition should return a tool-level result");
    assert_eq!(invalid.is_error, Some(true));

    let valid_args = serde_json::json!({ "task_id": task_id, "status": "TO_AGENT" })
        .as_object()
        .cloned()
        .expect("valid args should be an object");
    let valid = client
        .call_tool(CallToolRequestParams::new("transition_task_status").with_arguments(valid_args))
        .await
        .expect("valid transition call should return a result");
    assert_ne!(valid.is_error, Some(true));
    let transitioned: serde_json::Value = serde_json::from_str(
        valid
            .content
            .first()
            .expect("content block")
            .as_text()
            .expect("text content")
            .text
            .as_str(),
    )
    .expect("valid task json");
    assert_eq!(transitioned["status"], "TO_AGENT");

    client.cancel().await.expect("cancel client");
    server.abort();
}

#[tokio::test]
async fn add_task_log_tool_appends_a_log_entry() {
    let (base_url, server) = support::spawn_http_server(support::state().await).await;
    let project_id = create_project(&base_url).await;

    let headers = support::api_key_header().into_iter().collect();
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(format!("{base_url}/mcp"))
            .custom_headers(headers),
    );
    let client = ClientInfo::default()
        .serve(transport)
        .await
        .expect("client connects");

    let create_args = serde_json::json!({ "project_id": project_id, "title": "Log me" })
        .as_object()
        .cloned()
        .expect("create args should be an object");
    let created = client
        .call_tool(CallToolRequestParams::new("create_task").with_arguments(create_args))
        .await
        .expect("create_task should succeed");
    let created_task: serde_json::Value = serde_json::from_str(
        created
            .content
            .first()
            .expect("content block")
            .as_text()
            .expect("text content")
            .text
            .as_str(),
    )
    .expect("valid task json");
    let task_id = created_task["id"].as_str().expect("task id").to_owned();

    let log_args = serde_json::json!({
        "task_id": task_id,
        "author": "fixer",
        "message": "Started implementation"
    })
    .as_object()
    .cloned()
    .expect("log args should be an object");
    let logged = client
        .call_tool(CallToolRequestParams::new("add_task_log").with_arguments(log_args))
        .await
        .expect("add_task_log should succeed");
    assert_ne!(logged.is_error, Some(true));
    let log: serde_json::Value = serde_json::from_str(
        logged
            .content
            .first()
            .expect("content block")
            .as_text()
            .expect("text content")
            .text
            .as_str(),
    )
    .expect("valid log json");
    assert_eq!(log["author"], "fixer");
    assert_eq!(log["message"], "Started implementation");

    client.cancel().await.expect("cancel client");
    server.abort();
}

#[tokio::test]
async fn add_task_tag_and_remove_task_tag_tools_manage_tags() {
    let (base_url, server) = support::spawn_http_server(support::state().await).await;
    let project_id = create_project(&base_url).await;

    let headers = support::api_key_header().into_iter().collect();
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(format!("{base_url}/mcp"))
            .custom_headers(headers),
    );
    let client = ClientInfo::default()
        .serve(transport)
        .await
        .expect("client connects");

    let create_args = serde_json::json!({ "project_id": project_id, "title": "Tag me" })
        .as_object()
        .cloned()
        .expect("create args should be an object");
    let created = client
        .call_tool(CallToolRequestParams::new("create_task").with_arguments(create_args))
        .await
        .expect("create_task should succeed");
    let created_task: serde_json::Value = serde_json::from_str(
        created
            .content
            .first()
            .expect("content block")
            .as_text()
            .expect("text content")
            .text
            .as_str(),
    )
    .expect("valid task json");
    let task_id = created_task["id"].as_str().expect("task id").to_owned();

    let add_args = serde_json::json!({
        "task_id": task_id.clone(),
        "name": "NEEDS_USER_INPUT"
    })
    .as_object()
    .cloned()
    .expect("add tag args should be an object");
    let tagged = client
        .call_tool(CallToolRequestParams::new("add_task_tag").with_arguments(add_args))
        .await
        .expect("add_task_tag should succeed");
    assert_ne!(tagged.is_error, Some(true));
    let tagged_task: serde_json::Value = serde_json::from_str(
        tagged
            .content
            .first()
            .expect("content block")
            .as_text()
            .expect("text content")
            .text
            .as_str(),
    )
    .expect("valid task json");
    let tags = tagged_task["tags"].as_array().expect("tags array");
    assert_eq!(tags.len(), 1);
    assert_eq!(tags[0]["name"], "NEEDS_USER_INPUT");
    let tag_id = tags[0]["id"].as_str().expect("tag id").to_owned();

    let remove_args = serde_json::json!({
        "task_id": task_id.clone(),
        "tag_id": tag_id
    })
    .as_object()
    .cloned()
    .expect("remove tag args should be an object");
    let removed = client
        .call_tool(CallToolRequestParams::new("remove_task_tag").with_arguments(remove_args))
        .await
        .expect("remove_task_tag should succeed");
    assert_ne!(removed.is_error, Some(true));

    let get_args = serde_json::json!({ "task_id": task_id })
        .as_object()
        .cloned()
        .expect("get args should be an object");
    let refetched = client
        .call_tool(CallToolRequestParams::new("get_task").with_arguments(get_args))
        .await
        .expect("get_task should succeed");
    let refetched_task: serde_json::Value = serde_json::from_str(
        refetched
            .content
            .first()
            .expect("content block")
            .as_text()
            .expect("text content")
            .text
            .as_str(),
    )
    .expect("valid task json");
    assert!(refetched_task["tags"]
        .as_array()
        .expect("tags array")
        .is_empty());

    client.cancel().await.expect("cancel client");
    server.abort();
}

#[tokio::test]
async fn update_task_tool_sets_agent_and_result_summary_without_touching_title() {
    let (base_url, server) = support::spawn_http_server(support::state().await).await;
    let project_id = create_project(&base_url).await;

    let headers = support::api_key_header().into_iter().collect();
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(format!("{base_url}/mcp"))
            .custom_headers(headers),
    );
    let client = ClientInfo::default()
        .serve(transport)
        .await
        .expect("client connects");

    let create_args = serde_json::json!({ "project_id": project_id, "title": "Update me" })
        .as_object()
        .cloned()
        .expect("create args should be an object");
    let created = client
        .call_tool(CallToolRequestParams::new("create_task").with_arguments(create_args))
        .await
        .expect("create_task should succeed");
    let created_task: serde_json::Value = serde_json::from_str(
        created
            .content
            .first()
            .expect("content block")
            .as_text()
            .expect("text content")
            .text
            .as_str(),
    )
    .expect("valid task json");
    let task_id = created_task["id"].as_str().expect("task id").to_owned();

    let update_args = serde_json::json!({
        "task_id": task_id,
        "agent": "fixer",
        "result_summary": "Done"
    })
    .as_object()
    .cloned()
    .expect("update args should be an object");
    let updated = client
        .call_tool(CallToolRequestParams::new("update_task").with_arguments(update_args))
        .await
        .expect("update_task should succeed");
    assert_ne!(updated.is_error, Some(true));
    let updated_task: serde_json::Value = serde_json::from_str(
        updated
            .content
            .first()
            .expect("content block")
            .as_text()
            .expect("text content")
            .text
            .as_str(),
    )
    .expect("valid task json");
    assert_eq!(updated_task["title"], "Update me");
    assert_eq!(updated_task["agent"], "fixer");
    assert_eq!(updated_task["result_summary"], "Done");

    client.cancel().await.expect("cancel client");
    server.abort();
}

#[tokio::test]
async fn update_task_tool_sets_title_and_description_and_rejects_blank_title() {
    let (base_url, server) = support::spawn_http_server(support::state().await).await;
    let project_id = create_project(&base_url).await;

    let headers = support::api_key_header().into_iter().collect();
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(format!("{base_url}/mcp"))
            .custom_headers(headers),
    );
    let client = ClientInfo::default()
        .serve(transport)
        .await
        .expect("client connects");

    let create_args = serde_json::json!({
        "project_id": project_id,
        "title": "Original title",
        "description": "Original description"
    })
    .as_object()
    .cloned()
    .expect("create args should be an object");
    let created = client
        .call_tool(CallToolRequestParams::new("create_task").with_arguments(create_args))
        .await
        .expect("create_task should succeed");
    let created_task: serde_json::Value = serde_json::from_str(
        created
            .content
            .first()
            .expect("content block")
            .as_text()
            .expect("text content")
            .text
            .as_str(),
    )
    .expect("valid task json");
    let task_id = created_task["id"].as_str().expect("task id").to_owned();

    // Update title and description.
    let update_args = serde_json::json!({
        "task_id": task_id,
        "title": "New title",
        "description": "New description"
    })
    .as_object()
    .cloned()
    .expect("update args should be an object");
    let updated = client
        .call_tool(CallToolRequestParams::new("update_task").with_arguments(update_args))
        .await
        .expect("update_task should succeed");
    assert_ne!(updated.is_error, Some(true));
    let updated_task: serde_json::Value = serde_json::from_str(
        updated
            .content
            .first()
            .expect("content block")
            .as_text()
            .expect("text content")
            .text
            .as_str(),
    )
    .expect("valid task json");
    assert_eq!(updated_task["title"], "New title");
    assert_eq!(updated_task["description"], "New description");

    // Omitting title/description leaves existing values untouched.
    let noop_args = serde_json::json!({
        "task_id": task_id,
        "agent": "fixer"
    })
    .as_object()
    .cloned()
    .expect("noop args should be an object");
    let noop_updated = client
        .call_tool(CallToolRequestParams::new("update_task").with_arguments(noop_args))
        .await
        .expect("update_task should succeed");
    assert_ne!(noop_updated.is_error, Some(true));
    let noop_updated_task: serde_json::Value = serde_json::from_str(
        noop_updated
            .content
            .first()
            .expect("content block")
            .as_text()
            .expect("text content")
            .text
            .as_str(),
    )
    .expect("valid task json");
    assert_eq!(noop_updated_task["title"], "New title");
    assert_eq!(noop_updated_task["description"], "New description");
    assert_eq!(noop_updated_task["agent"], "fixer");

    // Empty-string title is rejected.
    let blank_title_args = serde_json::json!({
        "task_id": task_id,
        "title": ""
    })
    .as_object()
    .cloned()
    .expect("blank title args should be an object");
    let blank_title_result = client
        .call_tool(CallToolRequestParams::new("update_task").with_arguments(blank_title_args))
        .await
        .expect("update_task call should complete");
    assert_eq!(blank_title_result.is_error, Some(true));

    client.cancel().await.expect("cancel client");
    server.abort();
}

#[tokio::test]
async fn add_task_tag_returns_tool_errors_for_blank_and_noncanonical_names() {
    let (base_url, server) = support::spawn_http_server(support::state().await).await;
    let project_id = create_project(&base_url).await;

    let headers = support::api_key_header().into_iter().collect();
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(format!("{base_url}/mcp"))
            .custom_headers(headers),
    );
    let client = ClientInfo::default()
        .serve(transport)
        .await
        .expect("client connects");

    let create_args = serde_json::json!({ "project_id": project_id, "title": "Tag validation" })
        .as_object()
        .cloned()
        .expect("create args should be an object");
    let created = client
        .call_tool(CallToolRequestParams::new("create_task").with_arguments(create_args))
        .await
        .expect("create_task should succeed");
    let created_task: serde_json::Value = serde_json::from_str(
        created
            .content
            .first()
            .expect("content block")
            .as_text()
            .expect("text content")
            .text
            .as_str(),
    )
    .expect("valid task json");
    let task_id = created_task["id"].as_str().expect("task id").to_owned();

    for name in [" ", "failed"] {
        let arguments = serde_json::json!({ "task_id": task_id, "name": name })
            .as_object()
            .cloned()
            .expect("tag args should be an object");
        let result = client
            .call_tool(CallToolRequestParams::new("add_task_tag").with_arguments(arguments))
            .await
            .expect("validation failure should return a tool-level result");
        assert_eq!(result.is_error, Some(true), "{name:?} should be rejected");
    }

    client.cancel().await.expect("cancel client");
    server.abort();
}
