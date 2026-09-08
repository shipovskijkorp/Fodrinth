use serde_json::{Value, json};
use std::time::Duration;
use tauri::{AppHandle, LogicalPosition, Manager, Runtime, WebviewWindow};

const WINDOW_LABEL: &str = "curseforge-authors-downloads";
const RESULT_PARAM: &str = "__fodrinth_cf_download_augmented_result";
const PROJECT_AUGMENTER: &str = include_str!("curseforge_downloads_bars.js");

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
	while started.elapsed() < Duration::from_secs(60) {
		if let Some(raw) = query_param(window, RESULT_PARAM)? {
			let _ = clear_query_param(window, RESULT_PARAM);
			return serde_json::from_str::<Value>(&raw)
				.map_err(|error| format!("Could not decode CurseForge project analytics: {error}"));
		}
		tokio::time::sleep(Duration::from_millis(150)).await;
	}

	Err("Timed out mapping CurseForge period analytics to projects".to_string())
}

fn zero_lifetime_project(project: &Value) -> bool {
	project
		.get("allTime")
		.and_then(Value::as_f64)
		.is_some_and(|value| value == 0.0)
}

fn append_zero_period_projects(result: &mut Value, known_projects: &Value) {
	let Some(known) = known_projects.as_array() else {
		return;
	};
	let Some(object) = result.as_object_mut() else {
		return;
	};
	let projects = object.entry("projects").or_insert_with(|| Value::Array(Vec::new()));
	let Some(projects) = projects.as_array_mut() else {
		return;
	};

	for project in known.iter().filter(|project| zero_lifetime_project(project)) {
		let id = project.get("id").and_then(Value::as_str).unwrap_or_default();
		let name = project
			.get("name")
			.and_then(Value::as_str)
			.filter(|value| !value.is_empty())
			.unwrap_or(id);
		if id.is_empty() && name.is_empty() {
			continue;
		}
		let exists = projects.iter().any(|candidate| {
			candidate.get("id").and_then(Value::as_str) == Some(id)
				|| candidate.get("name").and_then(Value::as_str) == Some(name)
		});
		if !exists {
			projects.push(json!({
				"id": if id.is_empty() { name } else { id },
				"name": name,
				"period": 0,
				"current": 0,
			}));
		}
	}
}

#[tauri::command]
pub async fn curseforge_get_author_downloads_v6<R: Runtime>(
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

	let mapping_projects = Value::Array(
		known_projects
			.as_array()
			.into_iter()
			.flatten()
			.filter(|project| !zero_lifetime_project(project))
			.cloned()
			.collect(),
	);
	let mapping_count = mapping_projects.as_array().map_or(0, Vec::len);
	if mapping_count == 0 {
		let mut result = base;
		append_zero_period_projects(&mut result, &known_projects);
		if let Some(object) = result.as_object_mut() {
			object.insert("current".to_string(), Value::from(0));
		}
		return Ok(result);
	}

	let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
		return Ok(base);
	};

	let _ = window.set_position(LogicalPosition::new(-32000.0, -32000.0));
	let _ = window.set_skip_taskbar(true);
	let _ = window.show();
	let _ = window.eval(
		r#"(() => {
			try {
				window.dispatchEvent(new Event('resize'));
				const headings = Array.from(document.querySelectorAll('body *')).filter((element) => {
					if (element.children.length > 5) return false;
					const text = String(element.textContent || '').replace(/\s+/g, ' ').trim();
					return /downloads/i.test(text) && /project/i.test(text);
				});
				const heading = headings[0];
				if (heading) heading.scrollIntoView({ block: 'center', inline: 'nearest' });
				window.dispatchEvent(new Event('resize'));
			} catch (_) {}
		})();"#,
	);
	tokio::time::sleep(Duration::from_millis(1200)).await;

	let base_json = serde_json::to_string(&base).map_err(|error| error.to_string())?;
	let known_json = serde_json::to_string(&mapping_projects).map_err(|error| error.to_string())?;
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

	let mut result = poll_augmented_result(&window).await.unwrap_or(base);
	append_zero_period_projects(&mut result, &known_projects);
	let _ = window.hide();
	Ok(result)
}
