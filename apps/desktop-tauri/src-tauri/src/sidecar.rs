use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write as IoWrite};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Clone)]
pub struct SidecarManager {
    process: Arc<Mutex<Option<Child>>>,
    last_heartbeat: Arc<Mutex<Instant>>,
    request_counter: Arc<Mutex<u64>>,
    app_handle: Arc<Mutex<Option<AppHandle>>>,
    pending_requests: Arc<Mutex<HashMap<Value, oneshot::Sender<JsonRpcResponse>>>>,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            process: Arc::new(Mutex::new(None)),
            last_heartbeat: Arc::new(Mutex::new(Instant::now())),
            request_counter: Arc::new(Mutex::new(0)),
            app_handle: Arc::new(Mutex::new(None)),
            pending_requests: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn start(&self, app_handle: &AppHandle) -> Result<(), String> {
        {
            let mut process = self.process.lock().unwrap();
            if let Some(ref mut old_child) = *process {
                let _ = old_child.kill();
                let _ = old_child.wait();
            }
            *process = None;
        }

        *self.app_handle.lock().unwrap() = Some(app_handle.clone());

        let resource_dir = app_handle.path().resource_dir().ok();
        let sidecar_path = if let Some(resource_dir) = resource_dir.as_ref() {
            let candidates = vec![
                resource_dir.join("runtime/dist/sidecar.js"),
                resource_dir.join("resources/runtime/dist/sidecar.js"),
                resource_dir.join("../runtime/dist/sidecar.js"),
            ];
            candidates
                .into_iter()
                .find(|p| p.exists())
                .map(|p| Self::node_compatible_path(&p))
        } else {
            None
        }
        .or_else(|| Self::find_sidecar_relative().ok())
        .ok_or("Sidecar script not found".to_string())?;

        let node_path = Self::find_node_runtime(resource_dir.as_ref());

        let mut command = Command::new(&node_path);
        command
            .arg(&sidecar_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        command.creation_flags(0x08000000);

        if let Some(resource_root) = Self::resource_root_for_sidecar(&sidecar_path) {
            command.current_dir(resource_root);
        }

        Self::append_launch_log(
            app_handle,
            &format!(
                "starting sidecar: node={}, script={}",
                node_path, sidecar_path
            ),
        );

        let mut child = command
            .spawn()
            .map_err(|e| format!("Failed to start sidecar with {}: {}", node_path, e))?;

        let stdout = child
            .stdout
            .take()
            .ok_or("Failed to capture sidecar stdout")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("Failed to capture sidecar stderr")?;

        *self.process.lock().unwrap() = Some(child);
        *self.last_heartbeat.lock().unwrap() = Instant::now();

        let app = app_handle.clone();
        let last_hb = self.last_heartbeat.clone();
        let pending = self.pending_requests.clone();

        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(text) => {
                        if let Ok(msg) = serde_json::from_str::<Value>(&text) {
                            *last_hb.lock().unwrap() = Instant::now();
                            let method = msg.get("method").and_then(|m| m.as_str());
                            match method {
                                Some("system.ready") => {
                                    Self::append_launch_log(&app, "stdout: system.ready");
                                    *last_hb.lock().unwrap() = Instant::now();
                                    let rebuild_result = std::panic::catch_unwind(
                                        std::panic::AssertUnwindSafe(|| {
                                            let mgr = app.state::<Arc<SidecarManager>>();
                                            mgr.send_rebuild_state()
                                        }),
                                    );
                                    match rebuild_result {
                                        Ok(Ok(())) => Self::append_launch_log(
                                            &app,
                                            "rebuild_state dispatched",
                                        ),
                                        Ok(Err(err)) => Self::append_launch_log(
                                            &app,
                                            &format!("rebuild_state error: {}", err),
                                        ),
                                        Err(_) => {
                                            Self::append_launch_log(&app, "rebuild_state panic")
                                        }
                                    }
                                }
                                Some("heartbeat") => {
                                    *last_hb.lock().unwrap() = Instant::now();
                                }
                                Some("reminder.due") => {
                                    *last_hb.lock().unwrap() = Instant::now();
                                    if let Some(message) = msg
                                        .get("params")
                                        .and_then(|p| p.get("message"))
                                        .and_then(|m| m.as_str())
                                    {
                                        let app_for_thread = app.clone();
                                        let app_for_notification = app_for_thread.clone();
                                        let body = message.to_string();
                                        let _ = app_for_thread.run_on_main_thread(move || {
                                            use tauri_plugin_notification::NotificationExt;
                                            let _ = app_for_notification
                                                .notification()
                                                .builder()
                                                .title("EvolveFlow 提醒")
                                                .body(body)
                                                .show();
                                        });
                                    }
                                }
                                Some("ai.stream_chunk") => {
                                    *last_hb.lock().unwrap() = Instant::now();
                                    // Forward AI stream chunks as dedicated Tauri events
                                    if let Some(params) = msg.get("params") {
                                        let _ = app.emit("ai-stream-chunk", params);
                                    }
                                }
                                _ => {}
                            }

                            if let Some(id) = msg.get("id") {
                                if msg.get("result").is_some() || msg.get("error").is_some() {
                                    let mut pending_map = pending.lock().unwrap();
                                    if let Some(sender) = pending_map.remove(id) {
                                        if let Ok(resp) =
                                            serde_json::from_value::<JsonRpcResponse>(msg.clone())
                                        {
                                            let _ = sender.send(resp);
                                        }
                                    }
                                }
                            }

                            let _ = app.emit("sidecar-event", &text);
                        } else {
                            Self::append_launch_log(&app, &format!("stdout: {}", text));
                        }
                    }
                    Err(_) => break,
                }
            }

            Self::append_launch_log(&app, "stdout reader ended");
            let mut pending_map = pending.lock().unwrap();
            for (_, sender) in pending_map.drain() {
                let _ = sender.send(JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: None,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32001,
                        message: "Sidecar exited before responding".to_string(),
                        data: None,
                    }),
                    request_id: None,
                });
            }
        });

        let app_for_stderr = app_handle.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(text) => {
                        Self::append_launch_log(&app_for_stderr, &format!("stderr: {}", text));
                        let _ = app_for_stderr
                            .emit("sidecar-event", format!("sidecar stderr: {}", text));
                    }
                    Err(_) => break,
                }
            }
            Self::append_launch_log(&app_for_stderr, "stderr reader ended");
        });

        Ok(())
    }

    fn send_rebuild_state(&self) -> Result<(), String> {
        let handle = match self.app_handle.lock().unwrap().as_ref().cloned() {
            Some(h) => h,
            None => {
                let _ = self.send_request_internal(
                    "rebuild_state",
                    Some(serde_json::json!({
                        "reminders": [],
                        "pendingTaskIds": []
                    })),
                );
                return Ok(());
            }
        };

        let data_dir = match handle.path().app_data_dir() {
            Ok(dir) => dir,
            Err(_) => {
                let _ = self.send_request_internal(
                    "rebuild_state",
                    Some(serde_json::json!({
                        "reminders": [],
                        "pendingTaskIds": []
                    })),
                );
                return Ok(());
            }
        };

        let db_path = data_dir.join("evolveflow.db");

        match rusqlite::Connection::open(&db_path) {
            Ok(db) => {
                let reminders: Vec<serde_json::Value> = match db.prepare(
                    "SELECT id, trigger_at, message, task_id FROM reminders WHERE status = 'pending'",
                ) {
                    Ok(mut stmt) => match stmt.query_map([], |row| {
                        Ok(serde_json::json!({
                            "id": row.get::<_, String>(0)?,
                            "triggerAt": row.get::<_, String>(1)?,
                            "message": row.get::<_, Option<String>>(2)?,
                            "taskId": row.get::<_, Option<String>>(3)?,
                        }))
                    }) {
                        Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
                        Err(_) => Vec::new(),
                    },
                    Err(_) => Vec::new(),
                };

                let pending_task_ids: Vec<String> =
                    match db.prepare("SELECT id FROM tasks WHERE status = 'pending'") {
                        Ok(mut stmt) => match stmt.query_map([], |row| row.get::<_, String>(0)) {
                            Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
                            Err(_) => Vec::new(),
                        },
                        Err(_) => Vec::new(),
                    };

                let _ = self.send_request_internal(
                    "rebuild_state",
                    Some(serde_json::json!({
                        "reminders": reminders,
                        "pendingTaskIds": pending_task_ids,
                    })),
                );
            }
            Err(e) => {
                eprintln!("Failed to open database for rebuild_state: {}", e);
                let _ = self.send_request_internal(
                    "rebuild_state",
                    Some(serde_json::json!({
                        "reminders": [],
                        "pendingTaskIds": []
                    })),
                );
            }
        }

        Ok(())
    }

    fn write_json_request(
        &self,
        method: &str,
        params: Option<Value>,
        is_internal: bool,
    ) -> Result<(Value, oneshot::Receiver<JsonRpcResponse>), String> {
        let mut process = self.process.lock().unwrap();
        let child = process.as_mut().ok_or("Sidecar not running")?;

        let mut counter = self.request_counter.lock().unwrap();
        *counter += 1;
        let id = Value::Number(serde_json::Number::from(*counter));

        let (tx, rx) = oneshot::channel::<JsonRpcResponse>();
        {
            let mut pending = self.pending_requests.lock().unwrap();
            pending.insert(id.clone(), tx);
        }

        let (request_id_prefix, idempotency_key, session_id) = if is_internal {
            (
                format!("internal-{}", *counter),
                Some(format!("internal-{}-{}", method, *counter)),
                Some("system".to_string()),
            )
        } else {
            (format!("req-{}", *counter), None, None)
        };

        let request = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: Some(id.clone()),
            method: method.to_string(),
            params,
            request_id: Some(request_id_prefix),
            command: Some(method.to_string()),
            payload: None,
            idempotency_key,
            session_id,
        };

        let json_str =
            serde_json::to_string(&request).map_err(|e| format!("Serialize error: {}", e))?;

        if let Some(stdin) = child.stdin.as_mut() {
            writeln!(stdin, "{}", json_str).map_err(|e| format!("Write error: {}", e))?;
            stdin.flush().map_err(|e| format!("Flush error: {}", e))?;
        }

        Ok((id, rx))
    }

    fn send_request_internal(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<JsonRpcResponse, String> {
        let (id, _rx) = self.write_json_request(method, params, true)?;
        Ok(JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id: Some(id),
            request_id: None,
            result: Some(Value::String("sent".to_string())),
            error: None,
        })
    }

    pub fn send_health_probe(&self) -> Result<(), String> {
        self.send_request_internal("heartbeat", None).map(|_| ())
    }

    pub async fn send_request(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<JsonRpcResponse, String> {
        let (_id, rx) = self.write_json_request(method, params, false)?;

        // AI streaming requests use a much longer timeout
        let timeout_dur = if method == "ai.stream" || method == "ai.chat" {
            Duration::from_secs(120)
        } else {
            Duration::from_secs(30)
        };

        match tokio::time::timeout(timeout_dur, rx).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Err("Oneshot sender dropped".to_string()),
            Err(_) => Err(format!("Request timeout ({}s)", timeout_dur.as_secs())),
        }
    }

    pub fn shutdown_wrapper(&self) -> Result<(), String> {
        let _ = self.send_request_internal("shutdown", None);
        std::thread::sleep(Duration::from_millis(200));

        let mut process = self.process.lock().unwrap();
        if let Some(ref mut child) = *process {
            let _ = child.kill();
            *process = None;
        }
        Ok(())
    }

    pub fn check_health(&self) -> bool {
        let mut process = self.process.lock().unwrap();
        match process.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(Some(_status)) => {
                    *process = None;
                    false
                }
                Ok(None) => {
                    let last = *self.last_heartbeat.lock().unwrap();
                    last.elapsed() < Duration::from_secs(10)
                }
                Err(_) => false,
            },
            None => false,
        }
    }

    fn find_sidecar_relative() -> Result<String, String> {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| std::env::current_dir().unwrap());

        let candidates = vec![
            exe_dir.join("../../resources/runtime/dist/sidecar.js"),
            exe_dir.join("../../../runtime/dist/sidecar.js"),
            exe_dir.join("../../runtime/dist/sidecar.js"),
            exe_dir.join("../runtime/dist/sidecar.js"),
            exe_dir.join("runtime/dist/sidecar.js"),
            exe_dir.join("../../../../../runtime/dist/sidecar.js"),
        ];

        for c in &candidates {
            if c.exists() {
                return Ok(Self::node_compatible_path(c));
            }
        }

        Err("Sidecar script not found".to_string())
    }

    fn find_node_runtime(resource_dir: Option<&PathBuf>) -> String {
        if let Some(resource_dir) = resource_dir {
            let candidates = vec![
                resource_dir.join("node/node.exe"),
                resource_dir.join("resources/node/node.exe"),
                resource_dir.join("node/node"),
                resource_dir.join("resources/node/node"),
            ];
            for candidate in candidates {
                if candidate.exists() {
                    return Self::node_compatible_path(&candidate);
                }
            }
        }

        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| std::env::current_dir().unwrap());
        let relative_candidates = vec![
            exe_dir.join("../../resources/node/node.exe"),
            exe_dir.join("../../resources/node/node"),
        ];
        for candidate in relative_candidates {
            if candidate.exists() {
                return Self::node_compatible_path(&candidate);
            }
        }

        "node".to_string()
    }

    fn resource_root_for_sidecar(sidecar_path: &str) -> Option<PathBuf> {
        let path = PathBuf::from(sidecar_path);
        let dist_dir = path.parent()?;
        let runtime_dir = dist_dir.parent()?;
        runtime_dir.parent().map(|p| p.to_path_buf())
    }

    fn node_compatible_path(path: &PathBuf) -> String {
        let raw = path.to_string_lossy().to_string();
        if cfg!(windows) {
            if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
                return format!(r"\\{}", rest);
            }
            if let Some(rest) = raw.strip_prefix(r"\\?\") {
                return rest.to_string();
            }
        }
        raw
    }

    fn append_launch_log(app_handle: &AppHandle, message: &str) {
        let primary_dir = app_handle.path().app_data_dir().ok();
        let fallback_dir = std::env::var("USERPROFILE")
            .ok()
            .map(|home| PathBuf::from(home).join(".evolveflow").join("app-data"));

        for data_dir in [primary_dir, fallback_dir].into_iter().flatten() {
            let log_dir = data_dir.join("logs");
            if fs::create_dir_all(&log_dir).is_err() {
                continue;
            }
            let log_path = log_dir.join("sidecar-launch.log");
            if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
                let _ = writeln!(file, "{} {}", chrono_like_timestamp(), message);
            }
        }
    }
}

fn chrono_like_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => format!("[{}.{:03}]", duration.as_secs(), duration.subsec_millis()),
        Err(_) => "[time-error]".to_string(),
    }
}

pub fn start_supervisor(app_handle: AppHandle) {
    let app = app_handle.clone();
    loop {
        std::thread::sleep(Duration::from_secs(2));
        let mgr = app.state::<Arc<SidecarManager>>();
        if !mgr.check_health() {
            let _ = mgr.start(&app);
        } else {
            let _ = mgr.send_health_probe();
        }
    }
}
