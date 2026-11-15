//! 통합: 실제 hera-mcp.exe 를 띄워 in-process 파이프 서버(mcp::serve_pipe — Hera 와 같은 코드, 가짜 처리기)에 붙인다.
#![cfg(windows)]

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

fn session(pipe: &str, lines: &[Value]) -> Vec<Value> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_hera-mcp"))
        .env("HERA_MCP_PIPE", pipe)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    for l in lines {
        writeln!(stdin, "{l}").unwrap();
    }
    drop(stdin); // EOF → hera-mcp 종료
    let out: Vec<Value> = BufReader::new(child.stdout.take().unwrap()).lines().map(|l| serde_json::from_str(&l.unwrap()).unwrap()).collect();
    assert!(child.wait().unwrap().success());
    out
}

fn call(id: i64, name: &str, args: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": {"name": name, "arguments": args}})
}

#[test]
fn hera_mcp_relays_to_pipe() {
    let pipe = format!(r"\\.\pipe\hera-mcp-test-{}", std::process::id());
    let p = pipe.clone();
    std::thread::spawn(move || {
        hera_lib::mcp::serve_pipe(&p, |line| {
            let req: Value = serde_json::from_str(line).unwrap();
            match req["tool"].as_str() {
                Some("add_todo") => json!({"ok": {"id": "t1", "title": req["args"]["title"]}}),
                Some(t) => json!({"err": format!("denied {t}")}),
                None => json!({"ok": {"uri": req["resource"]}}),
            }
            .to_string()
        })
        .unwrap();
    });
    std::thread::sleep(std::time::Duration::from_millis(200));

    let out = session(
        &pipe,
        &[
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}}),
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
            call(3, "add_todo", json!({"title": "우유 사기"})),
            call(4, "launch", json!({"target": "calc"})),
            json!({"jsonrpc": "2.0", "id": 5, "method": "resources/read", "params": {"uri": "hera://notes"}}),
        ],
    );
    assert_eq!(out.len(), 5, "알림에는 응답하지 않는다: {out:?}");
    assert_eq!(out[0]["result"]["serverInfo"]["name"], "hera");
    assert!(out[1]["result"]["tools"].as_array().unwrap().iter().any(|t| t["name"] == "add_todo"));
    assert_eq!(out[2]["result"]["isError"], false);
    assert!(out[2]["result"]["content"][0]["text"].as_str().unwrap().contains("우유 사기"));
    assert_eq!(out[3]["result"]["isError"], true);
    assert_eq!(out[3]["result"]["content"][0]["text"], "denied launch");
    assert!(out[4]["result"]["contents"][0]["text"].as_str().unwrap().contains("hera://notes"));
}

#[test]
fn hera_not_running_is_a_clear_error() {
    let out = session(r"\\.\pipe\hera-mcp-test-nobody-home", &[json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}), call(2, "get_status", json!({}))]);
    assert!(out[0]["result"]["tools"].is_array()); // 목록은 Hera 없이도
    assert_eq!(out[1]["result"]["isError"], true);
    assert!(out[1]["result"]["content"][0]["text"].as_str().unwrap().contains("실행 중이 아니에요"));
}

#[test]
fn second_server_on_same_name_fails() {
    let pipe = format!(r"\\.\pipe\hera-mcp-test-dup-{}", std::process::id());
    let p = pipe.clone();
    std::thread::spawn(move || hera_lib::mcp::serve_pipe(&p, |_| String::new()));
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert!(hera_lib::mcp::serve_pipe(&pipe, |_| String::new()).is_err()); // FIRST_PIPE_INSTANCE: 가로채기 방지
}
