use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::Url;

const WINDOW_LABEL: &str = "curseforge-authors-projects";
const PROJECTS_URL: &str = "https://authors.curseforge.com/#/projects";
const CAPTURE_SCRIPT: &str = include_str!("curseforge_capture.js");
const PROJECTS_SCRAPER: &str = include_str!("curseforge_projects_v2.js");
const READY_PARAM: &str = "__fodrinth_cf_projects_ready";
const RESULT_PARAM: &str = "__fodrinth_cf_projects_result";

fn query_param<R: Runtime>(window: &WebviewWindow<R>, key: &str) -> Result<Option<String>, String> {
    let url = window
        .url()
        .map_err(|error| format!("Could not read CurseForge Authors projects URL: {error}"))?;
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
        .map_err(|error| format!("Could not clear CurseForge projects bridge state: {error}"))
}

async fn wait_for_document<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let _ = clear_query_param(window, READY_PARAM);
    let key = serde_json::to_string(READY_PARAM).map_err(|error| error.to_string())?;
    let started = std::time::Instant::now();

    while started.elapsed() < Duration::from_secs(25) {
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

    Err("Timed out waiting for CurseForge Authors projects page".to_string())
}

async fn ensure_window<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>, String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        return Ok(window);
    }

    let url = Url::parse(PROJECTS_URL).map_err(|error| error.to_string())?;
    WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(url))
        .title("CurseForge Authors Projects")
        .inner_size(1180.0, 820.0)
        .min_inner_size(900.0, 640.0)
        .visible(false)
        .initialization_script(CAPTURE_SCRIPT)
        .build()
        .map_err(|error| format!("Could not create hidden CurseForge Authors projects session: {error}"))
}

async fn poll_result<R: Runtime>(window: &WebviewWindow<R>) -> Result<Value, String> {
    let _ = clear_query_param(window, RESULT_PARAM);
    let result_key = serde_json::to_string(RESULT_PARAM).map_err(|error| error.to_string())?;

    window
        .eval(format!(
            r#"(() => {{
                const key = {result_key};
                const publish = () => {{
                    try {{
                        const value = window.__FODRINTH_CF_PROJECTS_V2_RESULT__;
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
        .map_err(|error| format!("Could not start CurseForge projects result bridge: {error}"))?;

    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_secs(35) {
        if let Some(raw) = query_param(window, RESULT_PARAM)? {
            let _ = clear_query_param(window, RESULT_PARAM);
            return serde_json::from_str::<Value>(&raw)
                .map_err(|error| format!("Could not decode CurseForge projects: {error}"));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    Err("Timed out waiting for CurseForge author projects".to_string())
}

#[tauri::command]
pub async fn curseforge_get_author_projects_v2<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Value, String> {
    let window = ensure_window(&app).await?;
    let url = Url::parse(PROJECTS_URL).map_err(|error| error.to_string())?;

    window
        .navigate(url)
        .map_err(|error| format!("Could not navigate CurseForge Authors projects page: {error}"))?;
    wait_for_document(&window).await?;

    window
        .eval(CAPTURE_SCRIPT)
        .map_err(|error| format!("Could not install CurseForge projects capture: {error}"))?;

    let _ = clear_query_param(&window, RESULT_PARAM);
    window
        .eval(PROJECTS_SCRAPER)
        .map_err(|error| format!("Could not start CurseForge project reader: {error}"))?;
    poll_result(&window).await
}
