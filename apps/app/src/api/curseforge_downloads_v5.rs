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
const STAGE_PARAM: &str = "__fodrinth_cf_download_stage";

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
	let _ = clear_query_param(window, STAGE_PARAM);
	let result_key = serde_json::to_string(RESULT_PARAM).map_err(|error| error.to_string())?;
	let stage_key = serde_json::to_string(STAGE_PARAM).map_err(|error| error.to_string())?;

	window
		.eval(format!(
			r#"(() => {{
				const resultKey = {result_key};
				const stageKey = {stage_key};
				const publish = () => {{
					try {{
						const url = new URL(location.href);
						const stage = window.__FODRINTH_CF_DOWNLOAD_STAGE__;
						if (stage) url.searchParams.set(stageKey, String(stage));
						const value = window.__FODRINTH_CF_DOWNLOAD_V3_RESULT__;
						if (value != null) url.searchParams.set(resultKey, JSON.stringify(value));
						history.replaceState(history.state, '', url.href);
						if (value == null) setTimeout(publish, 200);
					}} catch (_) {{
						setTimeout(publish, 300);
					}}
				}};
				publish();
			}})();"#
		))
		.map_err(|error| format!("Could not start CurseForge analytics result bridge: {error}"))?;

	let started = std::time::Instant::now();
	while started.elapsed() < Duration::from_secs(90) {
		if let Some(raw) = query_param(window, RESULT_PARAM)? {
			let _ = clear_query_param(window, RESULT_PARAM);
			let _ = clear_query_param(window, STAGE_PARAM);
			return serde_json::from_str::<Value>(&raw)
				.map_err(|error| format!("Could not decode CurseForge download analytics: {error}"));
		}
		tokio::time::sleep(Duration::from_millis(250)).await;
	}

	let stage = query_param(window, STAGE_PARAM)?.unwrap_or_else(|| "unknown".to_string());
	Err(format!(
		"Timed out waiting for CurseForge download analytics (stage: {stage})"
	))
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

	window
		.eval(CAPTURE_SCRIPT)
		.map_err(|error| format!("Could not install CurseForge analytics capture: {error}"))?;

	let _ = clear_query_param(&window, RESULT_PARAM);
	let _ = clear_query_param(&window, STAGE_PARAM);

	let script = DOWNLOAD_SCRAPER
		.replace("__PERIOD_DAYS__", &period_days.to_string())
		.replace(
			"const run = async () => {",
			"const run = async () => { window.__FODRINTH_CF_DOWNLOAD_STAGE__ = 'boot';",
		)
		.replace(
			"    await openDownloads();",
			r#"    window.__FODRINTH_CF_DOWNLOAD_STAGE__ = 'open-downloads';
    if (Array.isArray(window.__FODRINTH_CF_CAPTURES__)) window.__FODRINTH_CF_CAPTURES__.length = 0;
    await openDownloads();
    const wakeDownloadsCharts = async () => {
      const headings = Array.from(document.querySelectorAll('body *')).filter((element) => {
        if (element.children.length > 4) return false;
        return /downloads over time/i.test(norm(element.textContent));
      });
      for (const heading of headings) {
        try { heading.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}
        try { window.dispatchEvent(new Event('resize')); } catch (_) {}
        await sleep(500);
      }
      try { window.scrollTo(0, 0); } catch (_) {}
    };
    await wakeDownloadsCharts();"#,
		)
		.replace(
			"    if (Array.isArray(window.__FODRINTH_CF_CAPTURES__)) window.__FODRINTH_CF_CAPTURES__.length = 0;\n    await selectPeriod();",
			"    window.__FODRINTH_CF_DOWNLOAD_STAGE__ = 'select-period';\n    await selectPeriod();",
		)
		.replace(
			"    await selectTotal();",
			"    window.__FODRINTH_CF_DOWNLOAD_STAGE__ = 'select-total';\n    await selectTotal();\n    await wakeDownloadsCharts();",
		)
		.replace(
			r#"    const captured = captures();
    for (const capture of captured) visit(capture.value, capture.url, 0);
    const reactPropsInspected = inspectReactChartProps();"#,
			r#"    window.__FODRINTH_CF_DOWNLOAD_STAGE__ = 'parse-captures';
    const captured = captures().slice(-220);
    const fodrinthProjectDays = new Map();
    const fodrinthProjectNames = new Map();
    const fodrinthProjectPeriods = [];
    const fodrinthSeen = new WeakSet();
    const fodrinthGenericSeriesName = /^(?:total|unique|downloads?|total downloads|unique downloads|all projects|minecraft|minecraft java|data|series)$/i;

    const fodrinthRememberPoint = (projectId, projectName, dateValue, amountValue, context) => {
      if (/unique|loader|version|file/i.test(context || '')) return;
      const day = dayKey(dateValue);
      const amount = toNumber(amountValue);
      const id = norm(projectId || projectName);
      if (!id || !day || amount == null || amount < 0) return;
      if (projectName) fodrinthProjectNames.set(id, norm(projectName));
      const key = `${id}\u0000${day}`;
      const old = fodrinthProjectDays.get(key);
      if (old == null || amount > old) fodrinthProjectDays.set(key, amount);
    };

    const fodrinthScanProjectSeries = (value, inherited = {}, depth = 0, context = '') => {
      if (depth > 12 || value == null || typeof value === 'function') return;
      if (typeof value === 'object') {
        if (fodrinthSeen.has(value)) return;
        fodrinthSeen.add(value);
      }
      if (Array.isArray(value)) {
        for (const child of value) fodrinthScanProjectSeries(child, inherited, depth + 1, context);
        return;
      }
      if (typeof value !== 'object') return;

      const projectObject = value.project && typeof value.project === 'object' ? value.project : null;
      let projectId = norm(
        value.projectId ?? value.project_id ?? value.sourceProject ?? value.source_project ??
        projectObject?.id ?? projectObject?.projectId ?? inherited.id ?? '',
      );
      let projectName = norm(
        value.projectName ?? value.project_name ?? projectObject?.name ?? projectObject?.title ??
        inherited.name ?? '',
      );
      const seriesLabel = norm(value.seriesName ?? value.label ?? value.name ?? value.title ?? '');
      const pointArray = Array.isArray(value.data) ? value.data
        : Array.isArray(value.values) ? value.values
          : Array.isArray(value.points) ? value.points
            : null;
      if (!projectName && pointArray && seriesLabel && !fodrinthGenericSeriesName.test(seriesLabel) && !/unique|loader|version|file/i.test(seriesLabel)) {
        projectName = seriesLabel;
      }
      if (!projectId && projectName) projectId = projectName;

      const localContext = `${context} ${seriesLabel}`.trim();
      const directDate = value.date ?? value.day ?? value.time ?? value.timestamp ?? value.bucket ?? value.x;
      const directAmount =
        value.totalDownloads ?? value.total_downloads ?? value.downloads ?? value.downloadCount ??
        value.download_count ?? value.total ?? value.count ?? value.value ?? value.y;
      if (projectId && directDate != null && directAmount != null) {
        fodrinthRememberPoint(projectId, projectName, directDate, directAmount, localContext);
      }

      const dates = Array.isArray(value.dates) ? value.dates
        : Array.isArray(value.days) ? value.days
          : Array.isArray(value.labels) && value.labels.filter((item) => toDate(item)).length >= 2 ? value.labels
            : Array.isArray(value.categories) && value.categories.filter((item) => toDate(item)).length >= 2 ? value.categories
              : Array.isArray(value.timestamps) ? value.timestamps
                : null;
      const totals = Array.isArray(value.downloads) ? value.downloads
        : Array.isArray(value.totalDownloads) ? value.totalDownloads
          : Array.isArray(value.totals) ? value.totals
            : Array.isArray(value.values) && !/unique/i.test(localContext) ? value.values
              : null;
      if (projectId && dates && totals && dates.length === totals.length && totals.every((item) => toNumber(item) != null)) {
        for (let index = 0; index < dates.length; index++) {
          fodrinthRememberPoint(projectId, projectName, dates[index], totals[index], localContext);
        }
      }

      for (const collectionKey of ['datasets', 'series']) {
        const datasets = value[collectionKey];
        if (!Array.isArray(datasets)) continue;
        for (const dataset of datasets) {
          if (!dataset || typeof dataset !== 'object') continue;
          let datasetName = norm(dataset.projectName ?? dataset.project_name ?? dataset.name ?? dataset.label ?? dataset.title ?? projectName ?? '');
          let datasetId = norm(dataset.projectId ?? dataset.project_id ?? dataset.sourceProject ?? dataset.source_project ?? projectId ?? datasetName);
          if (!datasetId || !datasetName || fodrinthGenericSeriesName.test(datasetName) || /unique|loader|version|file/i.test(datasetName)) continue;
          const datasetValues = Array.isArray(dataset.data) ? dataset.data
            : Array.isArray(dataset.values) ? dataset.values
              : Array.isArray(dataset.points) ? dataset.points
                : Array.isArray(dataset.downloads) ? dataset.downloads
                  : null;
          if (!datasetValues) continue;
          if (dates && datasetValues.length === dates.length && datasetValues.every((item) => toNumber(item) != null)) {
            for (let index = 0; index < dates.length; index++) {
              fodrinthRememberPoint(datasetId, datasetName, dates[index], datasetValues[index], `${localContext}.${collectionKey}`);
            }
          } else {
            for (const point of datasetValues) {
              if (!point || typeof point !== 'object') continue;
              const date = point.date ?? point.day ?? point.time ?? point.timestamp ?? point.bucket ?? point.x;
              const amount = point.totalDownloads ?? point.total_downloads ?? point.downloads ?? point.downloadCount ?? point.download_count ?? point.total ?? point.count ?? point.value ?? point.y;
              if (date != null && amount != null) fodrinthRememberPoint(datasetId, datasetName, date, amount, `${localContext}.${collectionKey}`);
            }
          }
        }
      }

      const nextInherited = { id: projectId || inherited.id, name: projectName || inherited.name };
      for (const [key, child] of Object.entries(value)) {
        if (child == null || typeof child !== 'object') continue;
        fodrinthScanProjectSeries(child, nextInherited, depth + 1, `${localContext}.${key}`);
      }
    };

    for (const capture of captured) fodrinthScanProjectSeries(capture.value, {}, 0, capture.url || 'capture');

    const fodrinthCurrentStart = Date.now() - periodDays * DAY;
    const fodrinthPerProject = new Map();
    const fodrinthPerDay = new Map();
    for (const [key, amount] of fodrinthProjectDays) {
      const separator = key.indexOf('\u0000');
      if (separator < 0) continue;
      const id = key.slice(0, separator);
      const day = key.slice(separator + 1);
      const time = new Date(`${day}T12:00:00`).getTime();
      if (!Number.isFinite(time) || time < fodrinthCurrentStart - DAY || time > Date.now() + DAY) continue;
      fodrinthPerProject.set(id, (fodrinthPerProject.get(id) ?? 0) + amount);
      fodrinthPerDay.set(day, (fodrinthPerDay.get(day) ?? 0) + amount);
    }
    for (const [id, period] of fodrinthPerProject) {
      fodrinthProjectPeriods.push({ id, name: fodrinthProjectNames.get(id) || id, period, current: period });
    }
    const fodrinthRows = Array.from(fodrinthPerDay, ([day, value]) => ({
      date: new Date(`${day}T12:00:00`),
      value,
    })).sort((a, b) => a.date - b.date);
    if (fodrinthRows.length >= 2) addCandidate(fodrinthRows, 'total', 'fodrinth-per-project-daily-downloads', 20000);

    for (const capture of captured) visit(capture.value, capture.url, 0);
    const reactPropsInspected = 0;"#,
		)
		.replace(
			"const currentSeriesPoints = series.filter((row) => {",
			"window.__FODRINTH_CF_DOWNLOAD_STAGE__ = 'render-fallback'; const currentSeriesPoints = series.filter((row) => {",
		)
		.replace(
			"    const current = periodCard?.value ?? (enoughCurrentSeries ? sumRange('total', currentStart - DAY, now + DAY) : null);",
			"    const fodrinthProjectPeriodTotal = fodrinthProjectPeriods.reduce((sum, project) => sum + (toNumber(project.period) ?? 0), 0);\n    const current = periodCard?.value ?? (enoughCurrentSeries ? sumRange('total', currentStart - DAY, now + DAY) : (fodrinthProjectPeriods.length ? fodrinthProjectPeriodTotal : null));",
		)
		.replace(
			"      projects: [],\n      debug,",
			"      projects: fodrinthProjectPeriods,\n      debug: { ...debug, projectSeriesPoints: fodrinthProjectDays.size, projectPeriodCount: fodrinthProjectPeriods.length },",
		)
		.replace(
			"window.__FODRINTH_CF_DOWNLOAD_V3_RESULT__ = {\n      needsLogin: false,",
			"window.__FODRINTH_CF_DOWNLOAD_STAGE__ = 'done'; window.__FODRINTH_CF_DOWNLOAD_V3_RESULT__ = {\n      needsLogin: false,",
		);

	window
		.eval(script)
		.map_err(|error| format!("Could not start CurseForge download analytics reader: {error}"))?;
	poll_result(&window).await
}
