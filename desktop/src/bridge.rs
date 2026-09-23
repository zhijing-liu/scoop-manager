//! stdio RPC 桥接层。
//!
//! 与 sidecar 之间使用「长度前缀 + 原始 body」分帧，而不是 NDJSON —— 后者要求
//! body 是合法 JSON 字符串，会带来一次 JSON 转义；而 Tauri 的 invoke 信封还会
//! 再转义一次。长度前缀让 body 以原始字节直传，全链路零转义。
//!
//! 帧格式（两个方向一致）：
//!
//! ```text
//! u32 BE headerLength | JSON header (UTF-8) | body (bodyLength 字节)
//! ```
//!
//! 对 WebView 暴露三个命令：
//!   - `api_request`      普通请求；返回 `tauri::ipc::Response`（原始字节）
//!   - `api_stream_start` 流式请求（SSE）；分块通过 `rpc:chunk:{id}` 事件推送
//!   - `api_stream_cancel` 取消流

use std::collections::HashMap;
use std::io::Write;
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeResponseBody, Response};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

/// 协议版本。必须与 `src/server/adapter.ipc.ts` 的 `IPC_PROTOCOL_SCHEMA` 一致。
pub const PROTOCOL_SCHEMA: u32 = 2;

/// 等待 sidecar 就绪的最长时间（首次启动要做 scoop 环境探测）
const READY_TIMEOUT: Duration = Duration::from_secs(30);
/// 普通请求的最长等待时间
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
/// 就绪轮询间隔
const READY_POLL: Duration = Duration::from_millis(40);

/// 帧头长度上限，超过即判定为协议错位（例如被日志污染）
const MAX_HEADER_LENGTH: usize = 4 * 1024 * 1024;

// ---------------------------------------------------------------- 帧定义

/// 入站帧头（sidecar → 本进程）
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum InHeader {
    #[serde(rename = "ready")]
    Ready {
        #[serde(default)]
        schema: u32,
        #[serde(default)]
        pid: u32,
    },
    #[serde(rename = "response")]
    Response {
        id: String,
        #[serde(default)]
        status: u16,
        #[serde(default)]
        headers: HashMap<String, String>,
        /// true 表示后面还会有 chunk 帧（SSE）
        #[serde(default)]
        stream: bool,
        /// 普通响应时等于紧随其后的 body 字节数
        #[serde(rename = "bodyLength", default)]
        body_length: usize,
    },
    #[serde(rename = "chunk")]
    Chunk {
        id: String,
        #[serde(rename = "bodyLength", default)]
        body_length: usize,
    },
    #[serde(rename = "end")]
    End { id: String },
    #[serde(rename = "error")]
    Error {
        id: String,
        #[serde(default)]
        message: String,
    },
}

impl InHeader {
    /// 头之后应该跟多少字节的 body
    fn body_length(&self) -> usize {
        match self {
            InHeader::Ready { .. } | InHeader::End { .. } | InHeader::Error { .. } => 0,
            InHeader::Response { body_length, .. } | InHeader::Chunk { body_length, .. } => *body_length,
        }
    }
}

/// 出站帧头（本进程 → sidecar）
#[derive(Serialize)]
struct OutHeader<'a> {
    id: &'a str,
    method: &'a str,
    path: &'a str,
    headers: &'a HashMap<String, String>,
    #[serde(rename = "bodyLength")]
    body_length: usize,
}

/// 回给 WebView 的帧头。JS 侧按同样的 `u32 + JSON + body` 布局解码。
#[derive(Serialize)]
struct ReplyHeader<'a> {
    status: u16,
    headers: &'a HashMap<String, String>,
    #[serde(rename = "bodyLength")]
    body_length: usize,
}

fn pack(header: &impl Serialize, body: &[u8]) -> Vec<u8> {
    let header_bytes = serde_json::to_vec(header).unwrap_or_default();
    let mut out = Vec::with_capacity(4 + header_bytes.len() + body.len());
    out.extend_from_slice(&(header_bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(&header_bytes);
    out.extend_from_slice(body);
    out
}

// ---------------------------------------------------------------- 分帧累积器

/// 累积 stdout 字节并切出完整帧。
///
/// 必须自己处理粘包/拆包：管道一次 read 可能带回多个帧，也可能只有半个帧。
#[derive(Default)]
pub struct FrameAccumulator {
    buffer: Vec<u8>,
}

impl FrameAccumulator {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<(InHeader, Vec<u8>)> {
        self.buffer.extend_from_slice(chunk);
        let mut frames = Vec::new();
        let mut consumed = 0usize;

        loop {
            let rest = &self.buffer[consumed..];
            if rest.len() < 4 {
                break;
            }

            let header_length = u32::from_be_bytes([rest[0], rest[1], rest[2], rest[3]]) as usize;
            if header_length > MAX_HEADER_LENGTH {
                eprintln!("[bridge] 帧头长度异常（{header_length}），判定为协议错位，已重置读取缓冲。");
                self.buffer.clear();
                return frames;
            }
            if rest.len() < 4 + header_length {
                break;
            }

            let header: InHeader = match serde_json::from_slice(&rest[4..4 + header_length]) {
                Ok(header) => header,
                Err(error) => {
                    eprintln!("[bridge] 无法解析帧头（{error}），已重置读取缓冲。");
                    self.buffer.clear();
                    return frames;
                }
            };

            let body_length = header.body_length();
            if rest.len() < 4 + header_length + body_length {
                break;
            }

            let body_start = 4 + header_length;
            let body = rest[body_start..body_start + body_length].to_vec();
            consumed += body_start + body_length;
            frames.push((header, body));
        }

        if consumed > 0 {
            self.buffer.drain(..consumed);
        }
        frames
    }
}

// ---------------------------------------------------------------- Bridge

enum Pending {
    /// 普通请求：等 response 帧（body 与头同帧到达）即可返回
    Once { reply: oneshot::Sender<Vec<u8>> },
    /// 流式请求：分块通过事件推给前端，这里只是登记状态
    Stream,
}

pub struct Bridge {
    child: Mutex<Option<Child>>,
    pending: Mutex<HashMap<String, Pending>>,
    seq: AtomicU64,
    /// sidecar 进程是否存活（spawn 成功即为 true，stdout EOF 置 false）
    alive: AtomicBool,
    /// sidecar 是否已上报 ready 帧
    ready: AtomicBool,
    /// 子进程代次：每次 attach 自增。
    /// stdout 读取线程是独立线程，它的 EOF 回调可能晚于下一次 attach，
    /// 用代次才能判断"我盯的那个进程是否还是当前进程"。
    generation: AtomicU64,
}

impl Bridge {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(1),
            alive: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            generation: AtomicU64::new(0),
        }
    }

    pub fn next_id(&self) -> String {
        format!("r{}", self.seq.fetch_add(1, Ordering::Relaxed))
    }

    /// 接管一个新的子进程，返回它的代次。
    pub fn attach(&self, child: Child) -> u64 {
        *self.child.lock().unwrap() = Some(child);
        self.alive.store(true, Ordering::SeqCst);
        self.ready.store(false, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn take_child(&self) -> Option<Child> {
        self.child.lock().unwrap().take()
    }

    pub fn mark_ready(&self, schema: u32, pid: u32) {
        if schema != PROTOCOL_SCHEMA {
            eprintln!("[bridge] 协议版本不匹配：外壳期望 {PROTOCOL_SCHEMA}，sidecar 上报 {schema}。");
        }
        eprintln!("[bridge] sidecar 已就绪（schema={schema}, pid={pid}）。");
        self.ready.store(true, Ordering::SeqCst);
    }

    /// stdout 读到 EOF：子进程已退出
    pub fn mark_dead(&self) {
        self.alive.store(false, Ordering::SeqCst);
        self.ready.store(false, Ordering::SeqCst);
        self.pending.lock().unwrap().clear();
    }

    /// 传入的代次是否仍是当前代次。
    pub fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    /// 仅当代次未变时才标记死亡。
    ///
    /// 「重启服务」是 kill 旧进程 -> spawn 新进程，而旧进程的 stdout 读取线程是独立线程：
    /// 它的 EOF 与 mark_dead 完全可能晚于新进程的 attach。若不加代次判断，
    /// 旧线程会把刚起来的新进程置成 alive=false 并清空它已登记的在途请求，
    /// 表现为重启后立刻提示「本地服务未在运行」。
    pub fn mark_dead_if_current(&self, generation: u64) {
        if self.is_current(generation) {
            self.mark_dead();
        }
    }

    /// 等待 sidecar 就绪。
    ///
    /// 用轮询而不是 Notify：逻辑简单、不会因为唤醒时序写错而导致偶发挂死，
    /// 40ms 的粒度对首屏体验没有可感知影响。
    pub async fn wait_ready(&self, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        loop {
            if !self.alive.load(Ordering::SeqCst) {
                return Err("本地服务未在运行。可在托盘菜单选择「重启服务」后重试。".to_string());
            }
            if self.ready.load(Ordering::SeqCst) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err("等待本地服务就绪超时。".to_string());
            }
            tokio::time::sleep(READY_POLL).await;
        }
    }

    // ------------------------------------------------------------ 写帧

    fn write_frame(&self, frame: &[u8]) -> Result<(), String> {
        let mut guard = self.child.lock().unwrap();
        let child = guard.as_mut().ok_or_else(|| "本地服务进程尚未启动。".to_string())?;
        let stdin = child.stdin.as_mut().ok_or_else(|| "本地服务进程的标准输入不可用。".to_string())?;
        stdin.write_all(frame).map_err(|error| format!("写入本地服务失败：{error}"))?;
        stdin.flush().map_err(|error| format!("写入本地服务失败：{error}"))
    }

    fn send_request(&self, header: &OutHeader<'_>, body: &[u8]) -> Result<(), String> {
        self.write_frame(&pack(header, body))
    }

    /// 发送控制帧（例如 `{"type":"shutdown"}`）
    pub fn send_control(&self, payload: serde_json::Value) -> Result<(), String> {
        let bytes = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
        let mut frame = Vec::with_capacity(4 + bytes.len());
        frame.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        frame.extend_from_slice(&bytes);
        self.write_frame(&frame)
    }

    // ------------------------------------------------------------ 收帧

    pub fn on_frame(&self, app: &AppHandle, header: InHeader, body: Vec<u8>) {
        match header {
            InHeader::Ready { schema, pid } => {
                self.mark_ready(schema, pid);
                let _ = app.emit("backend-ready", serde_json::json!({ "schema": schema, "pid": pid }));
            }

            InHeader::Response {
                id,
                status,
                headers,
                stream,
                ..
            } => {
                if stream {
                    // 流式响应：头帧只宣告"流已建立"，数据在 chunk 帧里。
                    // 前端在调用 api_stream_start 之前就注册好了监听，这里无需动作。
                    return;
                }

                match self.pending.lock().unwrap().remove(&id) {
                    Some(Pending::Once { reply }) => {
                        let packed = pack(
                            &ReplyHeader {
                                status,
                                headers: &headers,
                                body_length: body.len(),
                            },
                            &body,
                        );
                        let _ = reply.send(packed);
                    }
                    // 流式请求收到了非流式响应：SSE 端点在建流之前就失败了
                    //（典型情况：任务已被清理，路由直接返回 404 JSON）。
                    // 必须转成 rpc:error 事件，否则垫片侧的 EventSource 既收不到 chunk、
                    // 也收不到 end/error，会永远停在"已连接"，前端连重连都触发不了。
                    Some(Pending::Stream) => {
                        let text = String::from_utf8_lossy(&body).into_owned();
                        let message = if text.trim().is_empty() {
                            format!("流式请求失败（HTTP {status}）。")
                        } else {
                            text
                        };
                        let _ = app.emit(&format!("rpc:error:{id}"), message);
                    }
                    None => {}
                }
            }

            InHeader::Chunk { id, .. } => {
                // SSE 文本本身是 UTF-8，这里丢失字节的概率为 0
                let text = String::from_utf8_lossy(&body).into_owned();
                let _ = app.emit(&format!("rpc:chunk:{id}"), text);
            }

            InHeader::End { id } => {
                self.pending.lock().unwrap().remove(&id);
                let _ = app.emit(&format!("rpc:end:{id}"), ());
            }

            InHeader::Error { id, message } => {
                let entry = self.pending.lock().unwrap().remove(&id);
                match entry {
                    Some(Pending::Once { reply }) => {
                        let empty = HashMap::new();
                        let packed = pack(
                            &ReplyHeader {
                                status: 502,
                                headers: &empty,
                                body_length: message.len(),
                            },
                            message.as_bytes(),
                        );
                        let _ = reply.send(packed);
                    }
                    _ => {
                        let _ = app.emit(&format!("rpc:error:{id}"), message);
                    }
                }
            }
        }
    }
}

impl Default for Bridge {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------- 命令

/// 普通请求。
///
/// 返回 `tauri::ipc::Response`：Tauri 会把 `InvokeResponseBody::Raw` 直接交给
/// WebView 作为 ArrayBuffer，不经过 JSON 序列化 —— 这是"零转义"的第二层保证。
#[tauri::command]
pub async fn api_request(
    state: tauri::State<'_, Bridge>,
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<Response, String> {
    state.wait_ready(READY_TIMEOUT).await?;

    let id = state.next_id();
    let (tx, rx) = oneshot::channel();
    state.pending.lock().unwrap().insert(id.clone(), Pending::Once { reply: tx });

    let raw = body.map(String::into_bytes).unwrap_or_default();
    let header = OutHeader {
        id: &id,
        method: &method,
        path: &path,
        headers: &headers,
        body_length: raw.len(),
    };

    if let Err(error) = state.send_request(&header, &raw) {
        state.pending.lock().unwrap().remove(&id);
        return Err(error);
    }

    match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
        Ok(Ok(frame)) => Ok(Response::new(InvokeResponseBody::Raw(frame))),
        Ok(Err(_)) => Err("本地服务未返回结果。".to_string()),
        Err(_) => {
            state.pending.lock().unwrap().remove(&id);
            Err("请求超时。".to_string())
        }
    }
}

/// 开启一条流式请求（SSE）。分块会以 `rpc:chunk:{stream_id}` 事件推送，
/// 结束时推送 `rpc:end:{stream_id}`，出错时推送 `rpc:error:{stream_id}`。
#[tauri::command]
pub async fn api_stream_start(
    state: tauri::State<'_, Bridge>,
    stream_id: String,
    path: String,
) -> Result<(), String> {
    state.wait_ready(READY_TIMEOUT).await?;

    state.pending.lock().unwrap().insert(stream_id.clone(), Pending::Stream);

    let empty = HashMap::new();
    let header = OutHeader {
        id: &stream_id,
        method: "GET",
        path: &path,
        headers: &empty,
        body_length: 0,
    };

    if let Err(error) = state.send_request(&header, &[]) {
        state.pending.lock().unwrap().remove(&stream_id);
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub fn api_stream_cancel(state: tauri::State<'_, Bridge>, stream_id: String) {
    state.pending.lock().unwrap().remove(&stream_id);
}
