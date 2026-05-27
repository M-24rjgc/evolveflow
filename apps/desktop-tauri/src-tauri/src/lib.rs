use std::sync::Arc;
use tauri::{
    AppHandle, Manager,
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Runtime,
};
mod sidecar;
use sidecar::{SidecarManager, start_supervisor};

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
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let show_item = MenuItemBuilder::with_id("show", "显示窗口").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&show_item)
                .item(&quit_item)
                .build()?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
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
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event {
                        if let Some(app) = tray.app_handle() {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
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
    Ok(serde_json::json!({
        "healthy": state.check_health(),
    }))
}