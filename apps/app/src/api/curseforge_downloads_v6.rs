use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, LogicalPosition, Manager, Runtime, WebviewWindow};

const WINDOW_LABEL: &str = "curseforge-authors-downloads";
const RESULT_PARAM: &str = "__fodrinth_cf_download_augmented_result";
const PROJECT_AUGMENTER: &str = include_str!("curseforge_downloads_projects.js");

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
		.map_err(|error| format!("Could not clear CurseForge project analytics bridge: {error}"))
}

async fn poll_augmented_result<R: Runtime>(window: &WebviewWindow<R>) -> Result<Value, String> {
	let _ = clear_query_param(window, RESULT_PARAM);
	let result_key = serde_json::to_string(RESULT_PARAM).map_err(|error| error.to_string())?;
	window
		.eval(format!(
			r#"(() => {{
				const resultKey = {result_key};
				const publish = () => {{
					try {{
						if (window.__FODRINTH_CF_DOWNLOAD_PROJECTS_AUGMENTED__ !== true) {{
							setTimeout(publish, 100);
							return;
						}}
						const value = window.__FODRINTH_CF_DOWNLOAD_V3_RESULT__;
						if (value == null) {{
							setTimeout(publish, 100);
							return;
						}}
						const url = new URL(location.href);
						url.searchParams.set(resultKey, JSON.stringify(value));
						history.replaceState(history.state, '', url.href);
					}} catch (_) {{
						setTimeout(publish, 150);
					}}
				}};
				publish();
			}})();"#
		))
		.map_err(|error| format!("Could not start CurseForge project analytics bridge: {error}"))?;

	let started = std::time::Instant::now();
	while started.elapsed() < Duration::from_secs(25) {
		if let Some(raw) = query_param(window, RESULT_PARAM)? {
			let _ = clear_query_param(window, RESULT_PARAM);
			return serde_json::from_str::<Value>(&raw)
				.map_err(|error| format!("Could not decode CurseForge project analytics: {error}"));
		}
		tokio::time::sleep(Duration::from_millis(150)).await;
	}

	Err("Timed out mapping CurseForge period analytics to projects".to_string())
}

#[tauri::command]
pub async fn curseforge_get_author_downloads<R: Runtime>(
	app: AppHandle<R>,
	period_days: u32,
	known_projects: Option<Value>,
) -> Result<Value, String> {
	let period_days = period_days.clamp(1, 365);
	let base = super::curseforge_downloads_v5::curseforge_get_author_downloads(
		app.clone(),
		period_days,
	)
	.await?;

	let known_projects = known_projects.unwrap_or_else(|| Value::Array(Vec::new()));
	let known_count = known_projects.as_array().map_or(0, Vec::len);
	if known_count == 0 {
		return Ok(base);
	}

	let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
		return Ok(base);
	};

	let _ = window.set_position(LogicalPosition::new(-32000.0, -32000.0));
	let _ = window.set_skip_taskbar(true);
	let _ = window.show();

	let base_json = serde_json::to_string(&base).map_err(|error| error.to_string())?;
	let known_json = serde_json::to_string(&known_projects).map_err(|error| error.to_string())?;
	window
		.eval(format!(
			"window.__FODRINTH_CF_DOWNLOAD_V3_RESULT__ = {base_json}; window.__FODRINTH_CF_DOWNLOAD_PROJECTS_AUGMENTED__ = false;"
		))
		.map_err(|error| format!("Could not prepare CurseForge project analytics: {error}"))?;

	let script = PROJECT_AUGMENTER
		.replace("__KNOWN_PROJECTS__", &known_json)
		.replace("__PERIOD_DAYS__", &period_days.to_string());
	window
		.eval(script)
		.map_err(|error| format!("Could not start CurseForge project analytics mapper: {error}"))?;

	let result = poll_augmented_result(&window).await.unwrap_or(base);
	let _ = window.hide();
	Ok(result)
}
