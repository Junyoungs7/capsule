//! hera-mcp.exe — MCP 클라이언트(Claude Code·Desktop 등)가 띄우는 stdio MCP 서버.
//! 목록·초기화는 직접 답하고, 도구 호출·리소스 읽기는 실행 중인 Hera 로 로컬 이름 있는 파이프를 통해 넘긴다 (docs/mcp.md).
//! 파이프 이름은 HERA_MCP_PIPE 로 바꿀 수 있다 (테스트용).
#![cfg_attr(not(windows), allow(unused))]

#[path = "../mcp_proto.rs"]
mod proto;

use std::io::{BufRead, BufReader, Write};

/// 요청 1개 = 연결 1개 (Hera 가 다시 켜져도 그대로 이어진다)
fn forward(pipe: &str, req: serde_json::Value) -> Result<serde_json::Value, String> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION: 파이프 서버가 이 프로세스로 가장(impersonate)하지 못하게
        let open = || std::fs::OpenOptions::new().read(true).write(true).custom_flags(0x0010_0000 | 0x0001_0000).open(pipe);
        let mut tries = 0;
        let f = loop {
            match open() {
                Ok(f) => break f,
                Err(e) if e.raw_os_error() == Some(231) && tries < 50 => {
                    tries += 1; // ERROR_PIPE_BUSY — 다른 요청 처리 중 (새 인스턴스를 곧 만든다)
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(e) if matches!(e.raw_os_error(), Some(2 | 3 | 231)) => return Err(proto::NOT_RUNNING.into()),
                Err(e) => return Err(format!("Hera 에 연결하지 못했어요: {e}")),
            }
        };
        writeln!(&f, "{req}").map_err(|e| format!("Hera 로 보내지 못했어요: {e}"))?;
        let mut line = String::new();
        BufReader::new(&f).read_line(&mut line).map_err(|e| format!("Hera 응답을 받지 못했어요: {e}"))?;
        if line.is_empty() {
            return Err(proto::NOT_RUNNING.into());
        }
        proto::reply(&line)
    }
    #[cfg(not(windows))]
    {
        let _ = (pipe, req);
        Err("hera-mcp 는 아직 Windows 에서만 동작해요".into())
    }
}

fn main() {
    let pipe = std::env::var("HERA_MCP_PIPE").unwrap_or_else(|_| proto::pipe_name());
    let mut out = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(resp) = proto::handle(&line, &mut |req| forward(&pipe, req)) {
            if writeln!(out, "{resp}").and_then(|_| out.flush()).is_err() {
                break;
            }
        }
    }
}
