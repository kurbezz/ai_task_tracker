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
