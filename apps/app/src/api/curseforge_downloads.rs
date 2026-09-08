use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::Url;

const WINDOW_LABEL: &str = "curseforge-authors-downloads";
const DASHBOARD_URL: &str = "https://authors.curseforge.com/dashboard";
const CAPTURE_SCRIPT: &str = include_str!("curseforge_capture.js");
const DOWNLOAD_SCRAPER: &str = include_str!("curseforge_downloads.js");
const READY_PARAM: &str = "__fodrinth_cf_ready";
const RESULT_PARAM: &str = "__fodrinth_cf_download_result";

fn query_param<R: Runtime>(window: &WebviewWindow<R>, key: &str) -> Result<Option<String>, String> {
    let url = window
        .url()
        .map_err(|error| format!("Could not read CurseForge Authors URL: {error}"))?;
    Ok(url
        .query_pairs()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned()))
}

fn clear_query_param<R: Runtime>(window: &WebviewWindow<R>, key: &str) -> Result<(), String> {
    let key = serde_json::to_string(key).map_err(|error| error.to_string())?;
    window
        .eval(format!(
            r#"(() => {{
                try {{
                    const url = new URL(location.href);
                    url.searchParams.delete({key});
                    history.replaceState(history.state, '', url.href);
                }} catch (_) {{}}
            }})();"#
        ))
        .map_err(|error| format!("Could not clear CurseForge analytics bridge state: {error}"))
}

async fn wait_for_document<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let _ = clear_query_param(window, READY_PARAM);
    let key = serde_json::to_string(READY_PARAM).map_err(|error| error.to_string())?;
    let started = std::time::Instant::now();

    while started.elapsed() < Duration::from_secs(25) {
        // eval_with_callback is unreliable on the current CurseForge Authors dashboard on
        // Windows/WebView2. Use plain eval to publish readiness into the URL, which Rust can
        // read through WebviewWindow::url() without IPC from the remote page.
        let _ = window.eval(format!(
            r#"(() => {{
                try {{
                    if (document.readyState !== 'loading' && document.body && (document.body.innerText || '').length > 40) {{
                        const url = new URL(location.href);
                        url.searchParams.set({key}, '1');
                        history.replaceState(history.state, '', url.href);
                    }}
                }} catch (_) {{}}
            }})();"#
        ));

        if query_param(window, READY_PARAM)?.as_deref() == Some("1") {
            let _ = clear_query_param(window, READY_PARAM);
            tokio::time::sleep(Duration::from_millis(900)).await;
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    Err("Timed out waiting for CurseForge Authors downloads page".to_string())
}

async fn ensure_window<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>, String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        return Ok(window);
    }

    let url = Url::parse(DASHBOARD_URL).map_err(|error| error.to_string())?;
    WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(url))
        .title("CurseForge Authors Downloads")
        .inner_size(1180.0, 820.0)
        .min_inner_size(900.0, 640.0)
        .visible(false)
        .initialization_script(CAPTURE_SCRIPT)
        .build()
        .map_err(|error| format!("Could not create hidden CurseForge Authors downloads session: {error}"))
}

async fn poll_result<R: Runtime>(window: &WebviewWindow<R>) -> Result<Value, String> {
    let _ = clear_query_param(window, RESULT_PARAM);
    let result_key = serde_json::to_string(RESULT_PARAM).map_err(|error| error.to_string())?;

    // The scraper stores its result in a page global. Mirror that global into the current
    // URL with history.replaceState. This avoids Tauri's callback-based JS evaluation path,
    // which CurseForge's current dashboard intermittently never answers on Windows.
    window
        .eval(format!(
            r#"(() => {{
                const key = {result_key};
                const publish = () => {{
                    try {{
                        const value = window.__FODRINTH_CF_DOWNLOAD_V3_RESULT__;
                        if (value == null) {{
                            setTimeout(publish, 200);
                            return;
                        }}
                        const url = new URL(location.href);
                        url.searchParams.set(key, JSON.stringify(value));
                        history.replaceState(history.state, '', url.href);
                    }} catch (_) {{
                        setTimeout(publish, 300);
                    }}
                }};
                publish();
            }})();"#
        ))
        .map_err(|error| format!("Could not start CurseForge analytics result bridge: {error}"))?;

    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_secs(55) {
        if let Some(raw) = query_param(window, RESULT_PARAM)? {
            let _ = clear_query_param(window, RESULT_PARAM);
            return serde_json::from_str::<Value>(&raw)
                .map_err(|error| format!("Could not decode CurseForge download analytics: {error}"));
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

    // Install the capture hook explicitly after each navigation because this dedicated
    // hidden window can be reused across multiple background refreshes.
    window
        .eval(CAPTURE_SCRIPT)
        .map_err(|error| format!("Could not install CurseForge analytics capture: {error}"))?;

    let _ = clear_query_param(&window, RESULT_PARAM);
    let script = DOWNLOAD_SCRAPER.replace("__PERIOD_DAYS__", &period_days.to_string());
    window
        .eval(script)
        .map_err(|error| format!("Could not start CurseForge download analytics reader: {error}"))?;
    poll_result(&window).await
}
