mod support;

use rmcp::{
    model::{CallToolRequestParam, ClientInfo},
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
    },
    ServiceExt,
};

#[tokio::test]
async fn ping_tool_round_trips_over_authenticated_mcp_session() {
    let (base_url, server) = support::spawn_http_server(support::state().await).await;

    let headers = support::api_key_header().into_iter().collect();
    let transport = StreamableHttpClientTransport::with_client(
        reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .expect("test client should build"),
        StreamableHttpClientTransportConfig::with_uri(format!("{base_url}/mcp")),
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
        .call_tool(CallToolRequestParam {
            name: "ping".into(),
            arguments: Some(serde_json::json!({}).as_object().cloned().unwrap()),
        })
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
    let transport = StreamableHttpClientTransport::with_client(
        reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .expect("test client should build"),
        StreamableHttpClientTransportConfig::with_uri(format!("{base_url}/mcp")),
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
        .call_tool(CallToolRequestParam {
            name: "create_task".into(),
            arguments: Some(create_args),
        })
        .await
        .expect("create_task should succeed");
    assert_ne!(created.is_error, Some(true));
    let created_text = created.content.first().expect("content block");
    let created_task: serde_json::Value =
        serde_json::from_str(created_text.as_text().expect("text content").text.as_str())
            .expect("valid task json");
    assert_eq!(created_task["title"], "Ship the MCP server");
    assert_eq!(created_task["status"], "TODO");
    let task_id = created_task["id"].as_str().expect("task id").to_owned();

    let get_args = serde_json::json!({ "task_id": task_id })
        .as_object()
        .cloned()
        .expect("get args should be an object");
    let fetched = client
        .call_tool(CallToolRequestParam {
            name: "get_task".into(),
            arguments: Some(get_args),
        })
        .await
        .expect("get_task should succeed");
    assert_ne!(fetched.is_error, Some(true));

    client.cancel().await.expect("cancel client");
    server.abort();
}
