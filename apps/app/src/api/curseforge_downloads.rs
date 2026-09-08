use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::Url;

const WINDOW_LABEL: &str = "curseforge-authors";
const DASHBOARD_URL: &str = "https://authors.curseforge.com/dashboard";
const CAPTURE_SCRIPT: &str = include_str!("curseforge_capture.js");
const DOWNLOAD_SCRAPER: &str = include_str!("curseforge_downloads.js");

fn js_result_to_value(raw: String) -> Value {
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::String(inner)) => {
            serde_json::from_str::<Value>(&inner).unwrap_or(Value::String(inner))
        }
        Ok(value) => value,
        Err(_) => Value::String(raw),
    }
}

async fn eval_json<R: Runtime>(
    window: &WebviewWindow<R>,
    script: String,
) -> Result<Value, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel::<String>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let callback_sender = sender.clone();

    window
        .eval_with_callback(script, move |raw| {
            if let Ok(mut guard) = callback_sender.lock()
                && let Some(sender) = guard.take()
            {
                let _ = sender.send(raw);
            }
        })
        .map_err(|error| format!("Could not evaluate CurseForge Authors downloads page: {error}"))?;

    let raw = tokio::time::timeout(Duration::from_secs(10), receiver)
        .await
        .map_err(|_| "Timed out reading CurseForge Authors downloads page".to_string())?
        .map_err(|_| "CurseForge Authors downloads page closed before returning data".to_string())?;
    Ok(js_result_to_value(raw))
}

async fn wait_for_document<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_secs(20) {
        if let Ok(value) = eval_json(
            window,
            "JSON.stringify({ready: document.readyState, body: document.body?.innerText?.length || 0})"
                .to_string(),
        )
        .await
        {
            let ready = value.get("ready").and_then(Value::as_str).unwrap_or("");
            let body = value.get("body").and_then(Value::as_u64).unwrap_or(0);
            if ready != "loading" && body > 40 {
                tokio::time::sleep(Duration::from_millis(1200)).await;
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Ok(())
}

async fn ensure_window<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>, String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        return Ok(window);
    }

    let url = Url::parse(DASHBOARD_URL).map_err(|error| error.to_string())?;
    WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(url))
        .title("CurseForge Authors")
        .inner_size(1180.0, 820.0)
        .min_inner_size(900.0, 640.0)
        .visible(false)
        .initialization_script(CAPTURE_SCRIPT)
        .build()
        .map_err(|error| format!("Could not create hidden CurseForge Authors analytics session: {error}"))
}

async fn poll_result<R: Runtime>(window: &WebviewWindow<R>) -> Result<Value, String> {
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_secs(50) {
        let value = eval_json(
            window,
            "JSON.stringify(window.__FODRINTH_CF_DOWNLOAD_V3_RESULT__ ?? null)".to_string(),
        )
        .await?;
        if !value.is_null() {
            return Ok(value);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err("Timed out waiting for CurseForge download analytics".to_string())
}

#[tauri::command]
pub async fn curseforge_get_author_downloads<R: Runtime>(
    app: AppHandle<R>,
    period_days: u32,
) -> Result<Value, String> {
    let period_days = period_days.clamp(1, 365);
    let window = ensure_window(&app).await?;
    let url = Url::parse(DASHBOARD_URL).map_err(|error| error.to_string())?;

    window
        .navigate(url)
        .map_err(|error| format!("Could not navigate CurseForge Authors downloads page: {error}"))?;
    wait_for_document(&window).await?;

    // The shared Authors window can have been created by another creator integration module,
    // so install the network capture hook explicitly after each dashboard navigation too.
    window
        .eval(CAPTURE_SCRIPT)
        .map_err(|error| format!("Could not install CurseForge analytics capture: {error}"))?;

    let script = DOWNLOAD_SCRAPER.replace("__PERIOD_DAYS__", &period_days.to_string());
    window
        .eval(script)
        .map_err(|error| format!("Could not start CurseForge download analytics reader: {error}"))?;
    poll_result(&window).await
}
