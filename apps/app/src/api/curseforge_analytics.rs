use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::Url;

const WINDOW_LABEL: &str = "curseforge-authors";
const DASHBOARD_URL: &str = "https://authors.curseforge.com/dashboard";
const TRANSACTIONS_URL: &str = "https://authors.curseforge.com/#/transactions";
const USD_PER_POINT: f64 = 0.05;

// Runs before the CurseForge application scripts. We only keep JSON responses that are
// likely to contain creator statistics. The page itself remains in charge of authentication;
// Fodrinth never receives the author's password.
const CAPTURE_SCRIPT: &str = r###"
(() => {
  if (location.hostname !== 'authors.curseforge.com') return;
  if (window.__FODRINTH_CF_CAPTURE_INSTALLED__) return;
  window.__FODRINTH_CF_CAPTURE_INSTALLED__ = true;
  window.__FODRINTH_CF_CAPTURES__ = [];

  const interesting = /analytics|stat|download|reward|point|transaction|earning|project|dashboard/i;
  const record = (url, text, contentType) => {
    try {
      if (!text || typeof text !== 'string') return;
      if (text.length > 750000) text = text.slice(0, 750000);
      const looksJson = /json/i.test(contentType || '') || /^[\s]*[\[{]/.test(text);
      if (!looksJson) return;
      if (!interesting.test(String(url || '')) && !interesting.test(text.slice(0, 3000))) return;
      const bucket = window.__FODRINTH_CF_CAPTURES__;
      bucket.push({ url: String(url || ''), text, at: Date.now() });
      if (bucket.length > 120) bucket.splice(0, bucket.length - 120);
    } catch (_) {}
  };

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function(...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const clone = response.clone();
        const url = clone.url || args[0]?.url || args[0] || '';
        const type = clone.headers?.get?.('content-type') || '';
        clone.text().then((text) => record(url, text, type)).catch(() => {});
      } catch (_) {}
      return response;
    };
  }

  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__fodrinthUrl = url;
    return open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', () => {
      try {
        const type = this.getResponseHeader('content-type') || '';
        if (typeof this.responseText === 'string') record(this.responseURL || this.__fodrinthUrl, this.responseText, type);
      } catch (_) {}
    }, { once: true });
    return send.apply(this, args);
  };
})();
"###;

const TRANSACTION_SCRAPER: &str = r###"
(() => {
  window.__FODRINTH_CF_TX_RESULT__ = null;
  const periodDays = Math.max(1, Number('__PERIOD_DAYS__') || 30);
  const cutoff = Date.now() - periodDays * 2 * 86400000;
  const pointRate = 0.05;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

  const parseDate = (raw) => {
    const s = norm(raw);
    let d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d;
    const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[^0-9]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return null;
    d = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]), Number(m[4] || 12), Number(m[5] || 0), Number(m[6] || 0));
    return Number.isNaN(d.getTime()) ? null : d;
  };

  const rowSignature = () => Array.from(document.querySelectorAll('tr.MuiTableRow-root.RaDatagrid-row'))
    .slice(0, 8)
    .map((row) => norm(row.innerText))
    .join('||');

  const waitForChange = async (before, timeout = 12000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      await sleep(150);
      if (rowSignature() !== before) return true;
    }
    return false;
  };

  const disabled = (button) => !button || button.disabled || norm(button.getAttribute('aria-disabled')).toLowerCase() === 'true' || /Mui-disabled/.test(button.closest('li')?.className || '');
  const prevButton = () => document.querySelector('button[aria-label="Go to previous page"],button[aria-label*="previous page" i]');
  const nextButton = () => document.querySelector('button[aria-label="Go to next page"],button[aria-label*="next page" i]');

  const ensureFirstPage = async () => {
    for (let i = 0; i < 200; i++) {
      const prev = prevButton();
      if (disabled(prev)) return;
      const before = rowSignature();
      prev.click();
      if (!(await waitForChange(before))) return;
    }
  };

  const parseBalance = () => {
    const lines = norm(document.body?.innerText).split(/\n+/).map(norm).filter(Boolean);
    for (const line of lines) {
      if (!/(balance|available|reward)/i.test(line) || !/points?/i.test(line)) continue;
      const m = line.match(/([\d,.]+)\s*points?/i) || line.match(/(?:balance|available|reward)[^\d]*([\d,.]+)/i);
      if (m) {
        const n = Number(m[1].replace(/,/g, ''));
        if (Number.isFinite(n)) return n;
      }
    }
    const body = norm(document.body?.innerText);
    const fallback = body.match(/(?:^|[\s(>])([\d,.]+)\s*points?/i);
    if (!fallback) return null;
    const n = Number(fallback[1].replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  const parseMods = async (row, expected) => {
    const button = row.querySelector('button[aria-controls*="-expand"], [aria-controls*="-expand"]');
    if (!button) return [];
    const wasExpanded = norm(button.getAttribute('aria-expanded')).toLowerCase() === 'true';
    if (!wasExpanded) {
      button.click();
      await sleep(220);
    }
    const id = button.getAttribute('aria-controls');
    const panel = id ? document.getElementById(id) : null;
    const root = panel?.querySelector('div.css-1jfg054') || panel;
    const kids = root ? Array.from(root.children) : [];
    const merged = new Map();
    for (let i = 0; i + 2 < kids.length; i += 3) {
      const pointsEl = kids[i];
      const labelEl = kids[i + 1];
      const projectEl = kids[i + 2];
      if (norm(labelEl?.textContent).toLowerCase() !== 'points for') continue;
      const points = Number(norm(pointsEl?.textContent).replace(/,/g, ''));
      const link = projectEl?.querySelector?.('a[aria-label],a[href],a');
      const name = norm(link?.getAttribute?.('aria-label') || link?.textContent);
      if (!name || !Number.isFinite(points)) continue;
      merged.set(name, (merged.get(name) || 0) + points);
    }
    if (!wasExpanded) button.click();
    const mods = Array.from(merged, ([name, points]) => ({ name, points, usd: points * pointRate }));
    const sum = mods.reduce((total, mod) => total + mod.points, 0);
    if (mods.length && Number.isFinite(expected) && expected - sum > 0.02) {
      const points = expected - sum;
      mods.push({ name: '(Unattributed / rounding)', points, usd: points * pointRate });
    }
    return mods;
  };

  const run = async () => {
    const body = norm(document.body?.innerText);
    if (/sign in|log in/i.test(body) && !/points generated|transactions/i.test(body)) {
      window.__FODRINTH_CF_TX_RESULT__ = { needsLogin: true, earnings: [], withdrawals: [], rewardPoints: null };
      return;
    }

    await ensureFirstPage();
    const earnings = [];
    const withdrawals = [];
    const seen = new Set();
    let scannedPages = 0;

    for (let page = 1; page <= 200; page++) {
      const rows = Array.from(document.querySelectorAll('tr.MuiTableRow-root.RaDatagrid-row'));
      let pageOldest = null;
      for (const row of rows) {
        const tds = Array.from(row.querySelectorAll('td'));
        if (tds.length < 6) continue;
        const kind = norm(tds[1]?.textContent);
        const status = norm(row.querySelector('td.column-type')?.textContent || tds[3]?.textContent);
        const dateCell = row.querySelector('td.column-dateCreated');
        const dateEl = dateCell?.querySelector('time,span') || dateCell;
        const dateRaw = norm(dateEl?.getAttribute?.('datetime') || dateEl?.getAttribute?.('data-date') || dateEl?.getAttribute?.('data-datetime') || dateEl?.getAttribute?.('title') || dateEl?.textContent);
        const date = parseDate(dateRaw);
        if (!date) continue;
        const timestamp = date.getTime();
        pageOldest = pageOldest == null ? timestamp : Math.min(pageOldest, timestamp);
        if (timestamp < cutoff) continue;

        const pointsText = norm(tds[5]?.textContent);
        const points = Number(pointsText.replace(/[^0-9.\-]/g, ''));
        if (!Number.isFinite(points)) continue;
        const details = norm(tds[2]?.textContent);
        const tx = norm(tds[6]?.textContent || tds[6]?.querySelector?.('a[href]')?.textContent);
        const key = [dateRaw, kind, status, points, details, tx].join('|');
        if (seen.has(key)) continue;
        seen.add(key);

        if (kind.toLowerCase() === 'points generated' && points > 0) {
          const projects = await parseMods(row, points);
          earnings.push({
            timestamp: new Date(timestamp).toISOString(),
            dateText: dateRaw,
            points,
            usd: points * pointRate,
            details,
            transaction: tx,
            projects,
          });
        } else if (status.toLowerCase() === 'fulfilled' && points < 0) {
          withdrawals.push({
            timestamp: new Date(timestamp).toISOString(),
            dateText: dateRaw,
            points,
            usd: Math.abs(points) * pointRate,
            method: kind,
            details,
            transaction: tx,
          });
        }
      }
      scannedPages++;
      if (pageOldest != null && pageOldest < cutoff) break;
      const next = nextButton();
      if (disabled(next)) break;
      const before = rowSignature();
      next.click();
      if (!(await waitForChange(before))) break;
    }

    const rewardPoints = parseBalance();
    window.__FODRINTH_CF_TX_RESULT__ = {
      needsLogin: false,
      rewardPoints,
      rewardBalanceUsd: Number.isFinite(rewardPoints) ? rewardPoints * pointRate : null,
      earnings,
      withdrawals,
      scannedPages,
    };
  };

  run().catch((error) => {
    window.__FODRINTH_CF_TX_RESULT__ = {
      needsLogin: false,
      rewardPoints: null,
      earnings: [],
      withdrawals: [],
      error: String(error?.stack || error?.message || error),
    };
  });
  return true;
})();
"###;

const DOWNLOAD_SCRAPER: &str = r###"
(() => {
  window.__FODRINTH_CF_DOWNLOAD_RESULT__ = null;
  const periodDays = Math.max(1, Number('__PERIOD_DAYS__') || 30);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const toNumber = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string') return null;
    const match = v.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const n = Number(match[0]);
    return Number.isFinite(n) ? n : null;
  };

  const findSmallLabelElement = (pattern) => {
    const matches = Array.from(document.querySelectorAll('body *')).filter((el) => {
      const text = norm(el.textContent);
      return text && text.length < 100 && pattern.test(text);
    });
    matches.sort((a, b) => norm(a.textContent).length - norm(b.textContent).length);
    return matches[0] || null;
  };

  const cardMetric = (patterns) => {
    for (const pattern of patterns) {
      const label = findSmallLabelElement(pattern);
      if (!label) continue;
      let node = label;
      for (let depth = 0; depth < 5 && node; depth++, node = node.parentElement) {
        const text = norm(node.innerText || node.textContent);
        const withoutLabel = text.replace(pattern, ' ');
        const numbers = Array.from(withoutLabel.matchAll(/(?:^|\s)([\d,.]+)(?!\s*%)/g))
          .map((m) => toNumber(m[1]))
          .filter((n) => n != null);
        if (numbers.length) {
          const pct = text.match(/([+-]?\d+(?:\.\d+)?)\s*%/);
          return { value: numbers[0], percent: pct ? Number(pct[1]) : null, text };
        }
      }
    }
    return null;
  };

  const capturedJson = () => (window.__FODRINTH_CF_CAPTURES__ || [])
    .map((entry) => {
      try { return { url: entry.url, value: JSON.parse(entry.text) }; } catch (_) { return null; }
    })
    .filter(Boolean);

  const findSeries = (captures) => {
    const candidates = [];
    const visit = (value, path, depth) => {
      if (depth > 12 || value == null) return;
      if (Array.isArray(value)) {
        if (value.length >= 2 && value.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
          const rows = value.map((item) => {
            const entries = Object.entries(item);
            const dateEntry = entries.find(([key, val]) => /date|time|timestamp|day|bucket/i.test(key) && (typeof val === 'string' || typeof val === 'number'));
            const totalEntry = entries.find(([key, val]) => /download/i.test(key) && !/unique/i.test(key) && toNumber(val) != null);
            const uniqueEntry = entries.find(([key, val]) => /unique.*download|download.*unique/i.test(key) && toNumber(val) != null);
            if (!dateEntry || (!totalEntry && !uniqueEntry)) return null;
            const date = new Date(dateEntry[1]);
            if (Number.isNaN(date.getTime())) return null;
            return {
              date: date.toISOString(),
              total: totalEntry ? toNumber(totalEntry[1]) : null,
              unique: uniqueEntry ? toNumber(uniqueEntry[1]) : null,
            };
          }).filter(Boolean);
          if (rows.length >= 2) {
            const score = rows.length * 10 + rows.filter((row) => row.total != null).length + rows.filter((row) => row.unique != null).length * 2;
            candidates.push({ rows, score, path });
          }
        }
        value.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      } else if (typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key, depth + 1);
      }
    };
    for (const capture of captures) visit(capture.value, capture.url, 0);
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  };

  const findProjects = (captures) => {
    const projects = new Map();
    const visit = (value, depth) => {
      if (depth > 12 || value == null) return;
      if (Array.isArray(value)) {
        value.forEach((item) => visit(item, depth + 1));
        return;
      }
      if (typeof value !== 'object') return;
      const entries = Object.entries(value);
      const nameEntry = entries.find(([key, val]) => /^(project_?name|name|title|slug)$/i.test(key) && typeof val === 'string' && val.trim());
      const idEntry = entries.find(([key, val]) => /^(project_?id|mod_?id|id)$/i.test(key) && (typeof val === 'string' || typeof val === 'number'));
      const totalEntry = entries.find(([key, val]) => /^(total_?)?downloads?|download_?count$/i.test(key) && !/unique/i.test(key) && toNumber(val) != null);
      const uniqueEntry = entries.find(([key, val]) => /unique.*downloads?|downloads?.*unique/i.test(key) && toNumber(val) != null);
      const iconEntry = entries.find(([key, val]) => /icon.*url|logo.*url|avatar.*url/i.test(key) && typeof val === 'string');
      if (nameEntry && (totalEntry || uniqueEntry)) {
        const name = norm(nameEntry[1]);
        const id = idEntry ? String(idEntry[1]) : name;
        const old = projects.get(id) || { id, name, total: null, unique: null, icon: null };
        const total = totalEntry ? toNumber(totalEntry[1]) : null;
        const unique = uniqueEntry ? toNumber(uniqueEntry[1]) : null;
        if (total != null && (old.total == null || total > old.total)) old.total = total;
        if (unique != null && (old.unique == null || unique > old.unique)) old.unique = unique;
        if (!old.icon && iconEntry) old.icon = iconEntry[1];
        projects.set(id, old);
      }
      for (const child of Object.values(value)) visit(child, depth + 1);
    };
    for (const capture of captures) visit(capture.value, 0);
    return Array.from(projects.values());
  };

  const trySelectPeriod = async () => {
    const wanted = [`Last ${periodDays} days`, `${periodDays} days`].map((v) => v.toLowerCase());
    const controls = Array.from(document.querySelectorAll('button,[role="button"],option'));
    const match = controls.find((el) => wanted.includes(norm(el.textContent).toLowerCase()));
    if (match && match.tagName !== 'OPTION') {
      match.click();
      await sleep(1500);
    }
  };

  const run = async () => {
    const body = norm(document.body?.innerText);
    if (/sign in|log in/i.test(body) && !/total project downloads|unique downloads|last 30 days/i.test(body)) {
      window.__FODRINTH_CF_DOWNLOAD_RESULT__ = { needsLogin: true };
      return;
    }

    if (!/total project downloads|unique downloads|downloads over time|last 30 days/i.test(body)) {
      const downloadsLink = Array.from(document.querySelectorAll('a,button,[role="button"]'))
        .find((el) => norm(el.textContent).toLowerCase() === 'downloads');
      if (downloadsLink) {
        downloadsLink.click();
        await sleep(2200);
      }
    }

    await trySelectPeriod();
    await sleep(500);

    const captures = capturedJson();
    const seriesCandidate = findSeries(captures);
    let series = seriesCandidate?.rows || [];
    series.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    const seven = cardMetric([/^last 7 days$/i]);
    const thirty = cardMetric([/^last 30 days$/i]);
    const yesterday = cardMetric([/^yesterday(?:\s+vs\.?\s+same day last week)?$/i, /^yesterday$/i]);
    const allTime = cardMetric([/^total project downloads$/i, /^all[- ]time downloads$/i]);
    const uniqueCard = cardMetric([/^unique downloads$/i, /^total unique downloads$/i]);

    const now = Date.now();
    const currentStart = now - periodDays * 86400000;
    const previousStart = now - periodDays * 2 * 86400000;
    const sumRange = (field, start, end) => series.reduce((total, row) => {
      const t = new Date(row.date).getTime();
      const value = row[field];
      return t >= start && t < end && Number.isFinite(value) ? total + value : total;
    }, 0);
    const hasSeriesTotal = series.some((row) => Number.isFinite(row.total));
    const hasSeriesUnique = series.some((row) => Number.isFinite(row.unique));

    let current = periodDays === 7 ? seven?.value : periodDays === 30 ? thirty?.value : null;
    let changePercent = periodDays === 7 ? seven?.percent : periodDays === 30 ? thirty?.percent : null;
    let previous = current != null && Number.isFinite(changePercent) && Math.abs(100 + changePercent) > 0.0001
      ? current / (1 + changePercent / 100)
      : null;

    if (current == null && hasSeriesTotal) current = sumRange('total', currentStart, now + 86400000);
    if (previous == null && hasSeriesTotal) previous = sumRange('total', previousStart, currentStart);
    const uniqueCurrent = hasSeriesUnique ? sumRange('unique', currentStart, now + 86400000) : uniqueCard?.value ?? null;
    const uniquePrevious = hasSeriesUnique ? sumRange('unique', previousStart, currentStart) : null;

    const projects = findProjects(captures);

    window.__FODRINTH_CF_DOWNLOAD_RESULT__ = {
      needsLogin: false,
      current,
      previous,
      changePercent: Number.isFinite(changePercent) ? changePercent : null,
      uniqueCurrent,
      uniquePrevious,
      allTime: allTime?.value ?? null,
      yesterday: yesterday?.value ?? null,
      yesterdayChangePercent: Number.isFinite(yesterday?.percent) ? yesterday.percent : null,
      series,
      projects,
      capturesSeen: captures.length,
      seriesSource: seriesCandidate?.path || null,
    };
  };

  run().catch((error) => {
    window.__FODRINTH_CF_DOWNLOAD_RESULT__ = {
      needsLogin: false,
      current: null,
      previous: null,
      uniqueCurrent: null,
      uniquePrevious: null,
      allTime: null,
      series: [],
      projects: [],
      error: String(error?.stack || error?.message || error),
    };
  });
  return true;
})();
"###;

fn js_result_to_value(raw: String) -> Value {
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::String(inner)) => serde_json::from_str::<Value>(&inner).unwrap_or(Value::String(inner)),
        Ok(value) => value,
        Err(_) => Value::String(raw),
    }
}

async fn eval_json<R: Runtime>(window: &WebviewWindow<R>, script: String) -> Result<Value, String> {
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
        .map_err(|error| format!("Could not evaluate CurseForge page: {error}"))?;

    let raw = tokio::time::timeout(Duration::from_secs(10), receiver)
        .await
        .map_err(|_| "Timed out reading CurseForge page".to_string())?
        .map_err(|_| "CurseForge page closed before returning data".to_string())?;
    Ok(js_result_to_value(raw))
}

async fn poll_global<R: Runtime>(
    window: &WebviewWindow<R>,
    global_name: &str,
    timeout: Duration,
) -> Result<Value, String> {
    let started = std::time::Instant::now();
    while started.elapsed() < timeout {
        let value = eval_json(
            window,
            format!("JSON.stringify(window.{global_name} ?? null)"),
        )
        .await?;
        if !value.is_null() {
            return Ok(value);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    Err(format!("Timed out waiting for {global_name}"))
}

fn portal_status_fallback() -> Value {
    json!({
        "connected": false,
        "needsLogin": true,
        "pointsUsdRate": USD_PER_POINT,
        "rewardPoints": null,
        "rewardBalanceUsd": null,
        "earnings": [],
        "withdrawals": [],
        "downloads": null,
    })
}

#[tauri::command]
pub async fn curseforge_open_author_portal<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let url = Url::parse(DASHBOARD_URL).map_err(|error| error.to_string())?;
    WebviewWindowBuilder::new(&app, WINDOW_LABEL, WebviewUrl::External(url))
        .title("CurseForge Authors")
        .inner_size(1180.0, 820.0)
        .min_inner_size(900.0, 640.0)
        .initialization_script(CAPTURE_SCRIPT)
        .build()
        .map_err(|error| format!("Could not open CurseForge Authors: {error}"))?;
    Ok(())
}

async fn scrape_transactions<R: Runtime>(window: &WebviewWindow<R>, period_days: u32) -> Result<Value, String> {
    let url = Url::parse(TRANSACTIONS_URL).map_err(|error| error.to_string())?;
    window.navigate(url).map_err(|error| format!("Could not open CurseForge transactions: {error}"))?;
    tokio::time::sleep(Duration::from_millis(2800)).await;
    let script = TRANSACTION_SCRAPER.replace("__PERIOD_DAYS__", &period_days.to_string());
    window.eval(script).map_err(|error| format!("Could not start CurseForge rewards scraper: {error}"))?;
    poll_global(window, "__FODRINTH_CF_TX_RESULT__", Duration::from_secs(45)).await
}

async fn scrape_downloads<R: Runtime>(window: &WebviewWindow<R>, period_days: u32) -> Result<Value, String> {
    let url = Url::parse(DASHBOARD_URL).map_err(|error| error.to_string())?;
    window.navigate(url).map_err(|error| format!("Could not open CurseForge analytics: {error}"))?;
    tokio::time::sleep(Duration::from_millis(3500)).await;
    let script = DOWNLOAD_SCRAPER.replace("__PERIOD_DAYS__", &period_days.to_string());
    window.eval(script).map_err(|error| format!("Could not start CurseForge downloads scraper: {error}"))?;
    poll_global(window, "__FODRINTH_CF_DOWNLOAD_RESULT__", Duration::from_secs(25)).await
}

#[tauri::command]
pub async fn curseforge_get_author_analytics<R: Runtime>(
    app: AppHandle<R>,
    period_days: u32,
) -> Result<Value, String> {
    let period_days = period_days.clamp(1, 365);
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        curseforge_open_author_portal(app).await?;
        return Ok(portal_status_fallback());
    };

    let current_url = window.url().map_err(|error| error.to_string())?;
    if current_url.host_str() != Some("authors.curseforge.com") {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(portal_status_fallback());
    }

    let transactions = match scrape_transactions(&window, period_days).await {
        Ok(value) => value,
        Err(error) => json!({
            "needsLogin": false,
            "rewardPoints": null,
            "earnings": [],
            "withdrawals": [],
            "error": error,
        }),
    };

    if transactions
        .get("needsLogin")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(portal_status_fallback());
    }

    let downloads = match scrape_downloads(&window, period_days).await {
        Ok(value) => value,
        Err(error) => json!({
            "needsLogin": false,
            "current": null,
            "previous": null,
            "uniqueCurrent": null,
            "uniquePrevious": null,
            "allTime": null,
            "series": [],
            "projects": [],
            "error": error,
        }),
    };

    if downloads
        .get("needsLogin")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(portal_status_fallback());
    }

    let reward_points = transactions.get("rewardPoints").cloned().unwrap_or(Value::Null);
    let reward_balance_usd = transactions
        .get("rewardBalanceUsd")
        .cloned()
        .unwrap_or(Value::Null);
    let earnings = transactions.get("earnings").cloned().unwrap_or_else(|| json!([]));
    let withdrawals = transactions.get("withdrawals").cloned().unwrap_or_else(|| json!([]));

    Ok(json!({
        "connected": true,
        "needsLogin": false,
        "pointsUsdRate": USD_PER_POINT,
        "rewardPoints": reward_points,
        "rewardBalanceUsd": reward_balance_usd,
        "earnings": earnings,
        "withdrawals": withdrawals,
        "downloads": downloads,
        "transactionsError": transactions.get("error").cloned().unwrap_or(Value::Null),
        "downloadsError": downloads.get("error").cloned().unwrap_or(Value::Null),
    }))
}
