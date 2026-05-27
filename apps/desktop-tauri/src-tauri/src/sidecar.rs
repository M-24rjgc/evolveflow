use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::io::{BufRead, BufReader, Write as IoWrite};
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

        let sidecar_path = if let Ok(resource_dir) = app_handle.path().resource_dir() {
            let candidates = vec![
                resource_dir.join("runtime/dist/sidecar.js"),
                resource_dir.join("../runtime/dist/sidecar.js"),
            ];
            candidates.into_iter().find(|p| p.exists())
                .map(|p| p.to_string_lossy().to_string())
        } else {
            None
        }.or_else(|| Self::find_sidecar_relative().ok())
        .ok_or("Sidecar script not found".to_string())?;

        let mut child = Command::new("node")
            .arg(&sidecar_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start sidecar: {}", e))?;

        let stdout = child.stdout.take().ok_or("Failed to capture sidecar stdout")?;

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
                            let method = msg.get("method").and_then(|m| m.as_str());
                            match method {
                                Some("system.ready") => {
                                    *last_hb.lock().unwrap() = Instant::now();
                                    let mgr = app.state::<Arc<SidecarManager>>();
                                    let _ = mgr.send_rebuild_state();
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
                                        let app_clone = app.clone();
                                        let body = message.to_string();
                                        let _ = app_clone.run_on_main_thread(move || {
                                            use tauri_plugin_notification::NotificationExt;
                                            let _ = app_clone
                                                .notification()
                                                .builder()
                                                .title("EvolveFlow 提醒")
                                                .body(body)
                                                .show();
                                        });
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
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(())
    }

    fn send_rebuild_state(&self) -> Result<(), String> {
        let handle_guard = self.app_handle.lock().unwrap();
        let handle = match handle_guard.as_ref() {
            Some(h) => h,
            None => {
                let _ = self.send_request_internal("rebuild_state", Some(serde_json::json!({
                    "reminders": [],
                    "pendingTaskIds": []
                })));
                return Ok(());
            }
        };

        let data_dir = match handle.path().app_data_dir() {
            Ok(dir) => dir,
            Err(_) => {
                let _ = self.send_request_internal("rebuild_state", Some(serde_json::json!({
                    "reminders": [],
                    "pendingTaskIds": []
                })));
                return Ok(());
            }
        };

        let db_path = data_dir.join("evolveflow.db");

        match rusqlite::Connection::open(&db_path) {
            Ok(db) => {
                let reminders: Vec<serde_json::Value> = db
                    .prepare(
                        "SELECT id, trigger_at, message, task_id FROM reminders WHERE status = 'pending'",
                    )
                    .ok()
                    .and_then(|mut stmt| {
                        stmt.query_map([], |row| {
                            Ok(serde_json::json!({
                                "id": row.get::<_, String>(0)?,
                                "triggerAt": row.get::<_, String>(1)?,
                                "message": row.get::<_, Option<String>>(2)?,
                                "taskId": row.get::<_, Option<String>>(3)?,
                            }))
                        })
                        .ok()
                    })
                    .map(|rows| rows.filter_map(|r| r.ok()).collect())
                    .unwrap_or_default();

                let pending_task_ids: Vec<String> = db
                    .prepare("SELECT id FROM tasks WHERE status = 'pending'")
                    .ok()
                    .and_then(|mut stmt| {
                        stmt.query_map([], |row| row.get::<_, String>(0))
                            .ok()
                    })
                    .map(|rows| rows.filter_map(|r| r.ok()).collect())
                    .unwrap_or_default();

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
                let _ = self.send_request_internal("rebuild_state", Some(serde_json::json!({
                    "reminders": [],
                    "pendingTaskIds": []
                })));
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

    pub async fn send_request(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<JsonRpcResponse, String> {
        let (_id, rx) = self.write_json_request(method, params, false)?;

        match tokio::time::timeout(Duration::from_secs(5), rx).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Err("Oneshot sender dropped".to_string()),
            Err(_) => Err("Request timeout (5s)".to_string()),
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

    pub fn shutdown(&self) -> Result<(), String> {
        self.shutdown_wrapper()
    }

    pub fn check_health(&self) -> bool {
        let last = *self.last_heartbeat.lock().unwrap();
        last.elapsed() < Duration::from_secs(5)
    }

    fn find_sidecar_relative() -> Result<String, String> {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| std::env::current_dir().unwrap());

        let candidates = vec![
            exe_dir.join("../../../runtime/dist/sidecar.js"),
            exe_dir.join("../../runtime/dist/sidecar.js"),
            exe_dir.join("../runtime/dist/sidecar.js"),
            exe_dir.join("runtime/dist/sidecar.js"),
        ];

        for c in &candidates {
            if c.exists() {
                return Ok(c.to_string_lossy().to_string());
            }
        }

        Err("Sidecar script not found".to_string())
    }
}

pub fn start_supervisor(app_handle: AppHandle) {
    let app = app_handle.clone();
    loop {
        std::thread::sleep(Duration::from_secs(2));
        let mgr = app.state::<Arc<SidecarManager>>();
        if !mgr.check_health() {
            let _ = mgr.start(&app);
        }
    }
}
