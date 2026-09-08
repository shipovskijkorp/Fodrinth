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

    let stage = query_param(window, STAGE_PARAM)?
        .unwrap_or_else(|| "unknown".to_string());
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

    // The React fiber tree on the Authors dashboard is enormous. Walking it can block the
    // WebView2 JS thread for longer than the entire analytics timeout. Network captures and
    // the rendered chart are enough, so keep the scraper bounded and observable.
    //
    // 90-day dashboard payloads are substantially larger than 7/30-day payloads. The generic
    // recursive candidate finder can both become expensive and mistake a single project line
    // for the global line. For 90d we therefore use a bounded project-aware pass over captured
    // JSON, aggregate project/day rows for the overall chart, and return period totals per mod.
    let script = DOWNLOAD_SCRAPER
        .replace("__PERIOD_DAYS__", &period_days.to_string())
        .replace(
            "const run = async () => {",
            "const run = async () => { window.__FODRINTH_CF_DOWNLOAD_STAGE__ = 'boot';",
        )
        .replace(
            "await openDownloads();",
            "window.__FODRINTH_CF_DOWNLOAD_STAGE__ = 'open-downloads'; await openDownloads();",
        )
        .replace(
            "await selectPeriod();",
            "window.__FODRINTH_CF_DOWNLOAD_STAGE__ = 'select-period'; await selectPeriod();",
        )
        .replace(
            "await selectTotal();",
            "window.__FODRINTH_CF_DOWNLOAD_STAGE__ = 'select-total'; await selectTotal();",
        )
        .replace(
            "const captured = captures();",
            "window.__FODRINTH_CF_DOWNLOAD_STAGE__ = 'parse-captures'; const allCaptured = captures(); const relevantCaptured = allCaptured.filter((capture) => /download|stat|analytic|metric|chart/i.test(capture.url)); const captured = (relevantCaptured.length ? relevantCaptured : allCaptured).slice(-80);",
        )
        .replace(
            r#"    for (const capture of captured) visit(capture.value, capture.url, 0);
    const reactPropsInspected = inspectReactChartProps();"#,
            r#"    const focusedProjectPeriods = [];
    if (periodDays === 90) {
      const projectDays = new Map();
      const projectNames = new Map();
      const seenFocused = new WeakSet();
      const genericSeriesName = /^(?:total|unique|downloads?|total downloads|unique downloads|all projects|minecraft|minecraft java)$/i;

      const rememberFocusedPoint = (projectId, projectName, dateValue, amountValue, context) => {
        if (/unique/i.test(context || '')) return;
        const date = toDate(dateValue);
        const day = dayKey(date);
        const amount = toNumber(amountValue);
        const id = norm(projectId || projectName);
        if (!id || !day || amount == null || amount < 0) return;
        if (projectName) projectNames.set(id, norm(projectName));
        const key = `${id}\u0000${day}`;
        const old = projectDays.get(key);
        if (old == null || amount > old) projectDays.set(key, amount);
      };

      const scanFocusedProjectData = (value, inherited = {}, depth = 0, context = '') => {
        if (depth > 10 || value == null || typeof value === 'function') return;
        if (typeof value === 'object') {
          if (seenFocused.has(value)) return;
          seenFocused.add(value);
        }
        if (Array.isArray(value)) {
          for (const child of value) scanFocusedProjectData(child, inherited, depth + 1, context);
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

        const pointArray = Array.isArray(value.data) ? value.data
          : Array.isArray(value.values) ? value.values
            : Array.isArray(value.points) ? value.points
              : null;
        const seriesLabel = norm(value.seriesName ?? value.label ?? value.name ?? value.title ?? '');
        if (!projectName && pointArray && seriesLabel && !genericSeriesName.test(seriesLabel)) {
          projectName = seriesLabel;
        }
        if (!projectId && projectName) projectId = projectName;

        const localContext = `${context} ${seriesLabel}`.trim();
        const dateValue = value.date ?? value.day ?? value.time ?? value.timestamp ?? value.bucket ?? value.x;
        const amountValue =
          value.totalDownloads ?? value.total_downloads ?? value.downloads ?? value.downloadCount ??
          value.download_count ?? value.total ?? value.count ?? value.y ?? value.value;
        if (projectId && dateValue != null && amountValue != null) {
          rememberFocusedPoint(projectId, projectName, dateValue, amountValue, localContext);
        }

        const dateValues = Array.isArray(value.dates) ? value.dates
          : Array.isArray(value.days) ? value.days
            : Array.isArray(value.labels) ? value.labels
              : Array.isArray(value.categories) ? value.categories
                : null;
        const totalValues = Array.isArray(value.downloads) ? value.downloads
          : Array.isArray(value.totalDownloads) ? value.totalDownloads
            : Array.isArray(value.totals) ? value.totals
              : Array.isArray(value.values) && !/unique/i.test(localContext) ? value.values
                : null;
        if (projectId && dateValues && totalValues && dateValues.length === totalValues.length) {
          for (let index = 0; index < dateValues.length; index++) {
            rememberFocusedPoint(projectId, projectName, dateValues[index], totalValues[index], localContext);
          }
        }

        const nextInherited = { id: projectId || inherited.id, name: projectName || inherited.name };
        for (const [key, child] of Object.entries(value)) {
          if (child == null || typeof child !== 'object') continue;
          scanFocusedProjectData(child, nextInherited, depth + 1, `${localContext}.${key}`);
        }
      };

      for (const capture of captured) {
        scanFocusedProjectData(capture.value, {}, 0, capture.url || 'capture');
      }

      const currentStart90 = Date.now() - periodDays * DAY;
      const perProject = new Map();
      const perDay = new Map();
      for (const [key, value] of projectDays) {
        const separator = key.indexOf('\u0000');
        if (separator < 0) continue;
        const id = key.slice(0, separator);
        const day = key.slice(separator + 1);
        const time = new Date(`${day}T12:00:00`).getTime();
        if (!Number.isFinite(time) || time < currentStart90 - DAY || time > Date.now() + DAY) continue;
        perProject.set(id, (perProject.get(id) ?? 0) + value);
        perDay.set(day, (perDay.get(day) ?? 0) + value);
      }

      for (const [id, period] of perProject) {
        focusedProjectPeriods.push({ id, name: projectNames.get(id) || id, period, current: period });
      }

      const focusedRows = Array.from(perDay, ([day, value]) => ({
        date: new Date(`${day}T12:00:00`),
        value,
      })).sort((a, b) => a.date - b.date);
      if (focusedRows.length >= 5) {
        addCandidate(focusedRows, 'total', 'focused-90-day-per-project-captures', 10000);
      }
    } else {
      for (const capture of captured) visit(capture.value, capture.url, 0);
    }
    const reactPropsInspected = 0;"#,
        )
        .replace(
            "const currentSeriesPoints = series.filter((row) => {",
            "window.__FODRINTH_CF_DOWNLOAD_STAGE__ = 'render-fallback'; const currentSeriesPoints = series.filter((row) => {",
        )
        .replace(
            "const current = periodCard?.value ?? (enoughCurrentSeries ? sumRange('total', currentStart - DAY, now + DAY) : null);",
            "const focusedPeriodTotal = focusedProjectPeriods.reduce((sum, project) => sum + (toNumber(project.period) ?? 0), 0); const current = periodCard?.value ?? (enoughCurrentSeries ? sumRange('total', currentStart - DAY, now + DAY) : (focusedProjectPeriods.length ? focusedPeriodTotal : null));",
        )
        .replace(
            "      projects: [],\n      debug,",
            "      projects: focusedProjectPeriods,\n      debug,",
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
