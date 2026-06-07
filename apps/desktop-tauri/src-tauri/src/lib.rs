use std::sync::Arc;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
mod sidecar;
use sidecar::{start_supervisor, SidecarManager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .manage(Arc::new(SidecarManager::new()))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let show_item = MenuItemBuilder::with_id("show", "显示窗口").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&show_item)
                .item(&quit_item)
                .build()?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        let mgr = app.state::<Arc<SidecarManager>>();
                        let _ = mgr.shutdown_wrapper();
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .icon({
                    match app.default_window_icon() {
                        Some(icon) => icon.clone(),
                        None => {
                            eprintln!("Warning: No default window icon found");
                            return Ok(());
                        }
                    }
                })
                .build(app)?;

            let mgr = app.state::<Arc<SidecarManager>>();
            let app_handle = app.handle().clone();
            if let Err(e) = mgr.start(&app_handle) {
                eprintln!("Warning: Failed to start sidecar: {}", e);
            }
            let app_handle2 = app.handle().clone();
            std::thread::spawn(move || {
                start_supervisor(app_handle2);
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            invoke_capability,
            get_sidecar_status,
            start_ai_session,
            get_degradation_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
async fn invoke_capability(
    state: tauri::State<'_, Arc<SidecarManager>>,
    method: String,
    params: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let response = state.send_request(&method, params).await?;
    if let Some(error) = response.error {
        Err(format!("RPC error {}: {}", error.code, error.message))
    } else {
        Ok(response.result.unwrap_or(serde_json::Value::Null))
    }
}

#[tauri::command]
async fn get_sidecar_status(
    state: tauri::State<'_, Arc<SidecarManager>>,
) -> Result<serde_json::Value, String> {
    let healthy = state.check_health();
    // Also check AI readiness via a quick heartbeat query
    let ai_ready = if healthy {
        match state.send_request("heartbeat", None).await {
            Ok(resp) => resp
                .result
                .and_then(|r| r.get("aiReady").cloned())
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            Err(_) => false,
        }
    } else {
        false
    };

    Ok(serde_json::json!({
        "healthy": healthy,
        "aiReady": ai_ready,
    }))
}

#[tauri::command]
async fn start_ai_session(
    state: tauri::State<'_, Arc<SidecarManager>>,
    session_id: String,
    message: String,
) -> Result<serde_json::Value, String> {
    let response = state
        .send_request(
            "ai.stream",
            Some(serde_json::json!({
                "session_id": session_id,
                "message": message,
            })),
        )
        .await?;
    if let Some(error) = response.error {
        Err(format!(
            "AI session error {}: {}",
            error.code, error.message
        ))
    } else {
        Ok(response.result.unwrap_or(serde_json::Value::Null))
    }
}

#[tauri::command]
async fn get_degradation_state(
    state: tauri::State<'_, Arc<SidecarManager>>,
) -> Result<String, String> {
    if !state.check_health() {
        return Ok("critical".to_string());
    }

    match state.send_request("ai.check_connectivity", None).await {
        Ok(resp) => {
            let connected = resp
                .result
                .and_then(|r| r.get("connected").cloned())
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if connected {
                Ok("full".to_string())
            } else {
                Ok("ai_offline".to_string())
            }
        }
        Err(_) => Ok("ai_offline".to_string()),
    }
}
