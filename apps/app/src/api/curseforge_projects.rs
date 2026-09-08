use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use url::Url;

const WINDOW_LABEL: &str = "curseforge-authors";
const PROJECTS_URL: &str = "https://authors.curseforge.com/#/projects";

const PROJECTS_SCRAPER: &str = r###"
(() => {
  window.__FODRINTH_CF_PROJECTS_RESULT__ = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const number = (value) => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    const match = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const captures = () => (window.__FODRINTH_CF_CAPTURES__ || [])
    .map((entry) => {
      try {
        return { url: String(entry?.url || ''), value: JSON.parse(entry?.text || '') };
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);

  const projects = new Map();

  const keep = (candidate) => {
    if (!candidate) return;
    const id = norm(candidate.id);
    const name = norm(candidate.name);
    if (!id || !name) return;

    const previous = projects.get(id) || {};
    const next = {
      id,
      name: name || previous.name || `Project ${id}`,
      slug: norm(candidate.slug) || previous.slug || null,
      summary: norm(candidate.summary) || previous.summary || '',
      description: norm(candidate.description) || previous.description || '',
      icon: norm(candidate.icon) || previous.icon || null,
      downloads: number(candidate.downloads) ?? previous.downloads ?? null,
      status: norm(candidate.status) || previous.status || null,
      sourceUrl: norm(candidate.sourceUrl) || previous.sourceUrl || null,
      issuesUrl: norm(candidate.issuesUrl) || previous.issuesUrl || null,
      license: norm(candidate.license) || previous.license || null,
      url:
        norm(candidate.url) ||
        previous.url ||
        `https://authors.curseforge.com/#/projects/${encodeURIComponent(id)}`,
    };
    projects.set(id, next);
  };

  const readString = (object, names) => {
    if (!object || typeof object !== 'object') return '';
    for (const name of names) {
      const value = object[name];
      if (typeof value === 'string' || typeof value === 'number') {
        const text = norm(value);
        if (text) return text;
      }
    }
    return '';
  };

  const readImage = (object) => {
    if (!object || typeof object !== 'object') return '';
    const direct = readString(object, [
      'iconUrl', 'iconURL', 'icon_url', 'logoUrl', 'logoURL', 'logo_url',
      'thumbnailUrl', 'thumbnailURL', 'thumbnail_url', 'avatarUrl', 'avatar_url',
    ]);
    if (direct) return direct;

    for (const key of ['logo', 'icon', 'thumbnail', 'avatar']) {
      const child = object[key];
      if (!child || typeof child !== 'object') continue;
      const nested = readString(child, ['thumbnailUrl', 'url', 'downloadUrl', 'imageUrl', 'src']);
      if (nested) return nested;
    }
    return '';
  };

  const inspect = (value, path = '', depth = 0) => {
    if (depth > 12 || value == null) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => inspect(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;

    const explicitId = readString(value, [
      'projectId', 'projectID', 'project_id', 'addonId', 'addonID', 'addon_id', 'modId', 'modID', 'mod_id',
    ]);
    const genericId = readString(value, ['id']);
    const id = explicitId || genericId;
    const name = readString(value, ['projectName', 'project_name', 'name', 'title']);
    const slug = readString(value, ['slug', 'projectSlug', 'project_slug']);
    const summary = readString(value, ['summary', 'shortDescription', 'short_description', 'tagline']);
    const description = readString(value, ['description', 'projectDescription', 'project_description']);
    const downloads =
      number(value.downloadCount) ??
      number(value.download_count) ??
      number(value.downloads) ??
      number(value.totalDownloads) ??
      number(value.total_downloads);
    const status = readString(value, ['status', 'projectStatus', 'project_status']);
    const sourceUrl = readString(value, ['sourceUrl', 'sourceURL', 'source_url', 'sourceCodeUrl', 'repositoryUrl']);
    const issuesUrl = readString(value, ['issueTrackerUrl', 'issuesUrl', 'issuesURL', 'issues_url']);
    const license = readString(value, ['license', 'licenseName', 'license_name']);
    const icon = readImage(value);

    let score = 0;
    if (explicitId) score += 3;
    if (/project|addon|mod/i.test(path)) score += 2;
    if (slug) score += 1;
    if (downloads != null) score += 1;
    if (summary || description) score += 1;
    if (icon) score += 1;

    const looksLikeFile =
      !!readString(value, ['fileId', 'fileID', 'file_id']) ||
      (!!readString(value, ['fileName', 'file_name']) && !slug && downloads == null);

    if (id && name && score >= 3 && !looksLikeFile) {
      keep({
        id,
        name,
        slug,
        summary,
        description,
        icon,
        downloads,
        status,
        sourceUrl,
        issuesUrl,
        license,
      });
    }

    for (const [key, child] of Object.entries(value)) {
      inspect(child, path ? `${path}.${key}` : key, depth + 1);
    }
  };

  const readDom = () => {
    const links = Array.from(document.querySelectorAll('a[href]'));
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/(?:#\/|\/)projects\/(\d+)/i);
      if (!match) continue;

      const id = match[1];
      let name = norm(link.getAttribute('aria-label') || link.textContent);
      let root = link;
      for (let i = 0; i < 5 && root; i++, root = root.parentElement) {
        if (!name || name.length > 120 || /^(edit|manage|files|project)$/i.test(name)) {
          const heading = root.querySelector?.('h1,h2,h3,h4,[class*="title" i],[class*="name" i]');
          const headingText = norm(heading?.textContent);
          if (headingText && headingText.length <= 120) name = headingText;
        }
        if (name && name.length <= 120 && !/^(edit|manage|files|project)$/i.test(name)) break;
      }

      if (!name || name.length > 120) continue;
      const card = link.closest('tr,article,li,[class*="card" i],[class*="paper" i]') || link.parentElement;
      const image = card?.querySelector?.('img[src]');
      const text = norm(card?.innerText || '');
      const downloadsMatch = text.match(/([\d,.]+)\s+downloads?/i);
      keep({
        id,
        name,
        icon: image?.src || '',
        downloads: downloadsMatch ? number(downloadsMatch[1]) : null,
        url: new URL(href, location.href).href,
      });
    }
  };

  const run = async () => {
    let capturedCount = 0;

    for (let attempt = 0; attempt < 28; attempt++) {
      const body = norm(document.body?.innerText);
      const looksLoggedOut = /sign in|log in/i.test(body) && !/projects|dashboard|rewards/i.test(body);
      if (looksLoggedOut) {
        window.__FODRINTH_CF_PROJECTS_RESULT__ = {
          connected: false,
          needsLogin: true,
          projects: [],
        };
        return;
      }

      const captured = captures();
      capturedCount = Math.max(capturedCount, captured.length);
      for (const capture of captured) inspect(capture.value, capture.url, 0);
      readDom();

      if (projects.size > 0) break;
      await sleep(300);
    }

    window.__FODRINTH_CF_PROJECTS_RESULT__ = {
      connected: true,
      needsLogin: false,
      projects: Array.from(projects.values()).sort((a, b) => a.name.localeCompare(b.name)),
      capturesSeen: capturedCount,
    };
  };

  run().catch((error) => {
    window.__FODRINTH_CF_PROJECTS_RESULT__ = {
      connected: true,
      needsLogin: false,
      projects: [],
      error: String(error?.stack || error?.message || error),
    };
  });

  return true;
})();
"###;

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
        .map_err(|error| format!("Could not evaluate CurseForge Authors page: {error}"))?;

    let raw = tokio::time::timeout(Duration::from_secs(10), receiver)
        .await
        .map_err(|_| "Timed out reading CurseForge Authors page".to_string())?
        .map_err(|_| "CurseForge Authors page closed before returning data".to_string())?;

    Ok(js_result_to_value(raw))
}

async fn poll_result<R: Runtime>(window: &WebviewWindow<R>) -> Result<Value, String> {
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_secs(25) {
        let value = eval_json(
            window,
            "JSON.stringify(window.__FODRINTH_CF_PROJECTS_RESULT__ ?? null)".to_string(),
        )
        .await?;
        if !value.is_null() {
            return Ok(value);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    Err("Timed out waiting for CurseForge project list".to_string())
}

fn login_fallback() -> Value {
    json!({
        "connected": false,
        "needsLogin": true,
        "projects": [],
    })
}

#[tauri::command]
pub async fn curseforge_get_author_projects<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Value, String> {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        crate::api::curseforge_analytics::curseforge_open_author_portal(app.clone()).await?;
        return Ok(login_fallback());
    };

    let current_url = window.url().map_err(|error| error.to_string())?;
    if current_url.host_str() != Some("authors.curseforge.com") {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(login_fallback());
    }

    // Start with a clean capture bucket so unrelated rewards/dashboard responses do not
    // look like creator projects when the same author window was used by Analytics first.
    let _ = window.eval("window.__FODRINTH_CF_CAPTURES__ = [];");

    let projects_url = Url::parse(PROJECTS_URL).map_err(|error| error.to_string())?;
    window
        .navigate(projects_url)
        .map_err(|error| format!("Could not open CurseForge projects: {error}"))?;
    tokio::time::sleep(Duration::from_millis(3200)).await;

    window
        .eval(PROJECTS_SCRAPER)
        .map_err(|error| format!("Could not start CurseForge project scraper: {error}"))?;

    let result = poll_result(&window).await?;
    if result
        .get("needsLogin")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
    }

    Ok(result)
}
