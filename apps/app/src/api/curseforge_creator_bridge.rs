use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::Url;

const WINDOW_LABEL: &str = "curseforge-authors";
const DASHBOARD_URL: &str = "https://authors.curseforge.com/dashboard";
const PROJECTS_URL: &str = "https://authors.curseforge.com/#/projects";
const TRANSACTIONS_URL: &str = "https://authors.curseforge.com/#/transactions";
const USD_PER_POINT: f64 = 0.05;

// The Authors console does not expose the private author datasets through the public
// publishing API. Keep a private WebView session and read the same JSON responses the
// console uses. The window is created hidden for background creator refreshes and is only
// made visible when the user explicitly asks to open the Author Dashboard.
const CAPTURE_SCRIPT: &str = r###"
(() => {
  if (window.__FODRINTH_CF_CAPTURE_INSTALLED__) return;
  window.__FODRINTH_CF_CAPTURE_INSTALLED__ = true;
  window.__FODRINTH_CF_CAPTURES__ = [];

  const record = (url, text, contentType) => {
    try {
      if (!text || typeof text !== 'string') return;
      const trimmed = text.trim();
      const looksJson = /json/i.test(contentType || '') || trimmed.startsWith('{') || trimmed.startsWith('[');
      if (!looksJson) return;
      const bucket = window.__FODRINTH_CF_CAPTURES__;
      if (!Array.isArray(bucket)) return;
      bucket.push({
        url: String(url || ''),
        text: text.length > 1500000 ? text.slice(0, 1500000) : text,
        at: Date.now(),
      });
      if (bucket.length > 180) bucket.splice(0, bucket.length - 180);
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

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__fodrinthUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', () => {
      try {
        const type = this.getResponseHeader('content-type') || '';
        if (typeof this.responseText === 'string') {
          record(this.responseURL || this.__fodrinthUrl, this.responseText, type);
        }
      } catch (_) {}
    }, { once: true });
    return originalSend.apply(this, args);
  };
})();
"###;

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
      try { return { url: String(entry?.url || ''), value: JSON.parse(entry?.text || '') }; }
      catch (_) { return null; }
    })
    .filter(Boolean);

  const projects = new Map();
  const keep = (candidate) => {
    if (!candidate) return;
    const id = norm(candidate.id);
    const name = norm(candidate.name);
    if (!id || !name) return;
    const old = projects.get(id) || {};
    const next = {
      id,
      name: name || old.name || `Project ${id}`,
      slug: norm(candidate.slug) || old.slug || null,
      summary: norm(candidate.summary) || old.summary || '',
      description: norm(candidate.description) || old.description || '',
      icon: norm(candidate.icon) || old.icon || null,
      downloads: number(candidate.downloads) ?? old.downloads ?? null,
      status: norm(candidate.status) || old.status || null,
      sourceUrl: norm(candidate.sourceUrl) || old.sourceUrl || null,
      issuesUrl: norm(candidate.issuesUrl) || old.issuesUrl || null,
      license: norm(candidate.license) || old.license || null,
      dateCreated: norm(candidate.dateCreated) || old.dateCreated || null,
      dateModified: norm(candidate.dateModified) || old.dateModified || null,
      url: norm(candidate.url) || old.url || `https://authors.curseforge.com/#/projects/${encodeURIComponent(id)}`,
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
    if (depth > 14 || value == null) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => inspect(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;

    const explicitId = readString(value, [
      'projectId', 'projectID', 'project_id', 'addonId', 'addonID', 'addon_id', 'modId', 'modID', 'mod_id',
    ]);
    const id = explicitId || readString(value, ['id']);
    const name = readString(value, ['projectName', 'project_name', 'name', 'title']);
    const slug = readString(value, ['slug', 'projectSlug', 'project_slug']);
    const summary = readString(value, ['summary', 'shortDescription', 'short_description', 'tagline']);
    const description = readString(value, ['description', 'projectDescription', 'project_description']);
    const downloads =
      number(value.downloadCount) ?? number(value.download_count) ?? number(value.downloads) ??
      number(value.totalDownloads) ?? number(value.total_downloads);
    const status = readString(value, ['status', 'projectStatus', 'project_status']);
    const sourceUrl = readString(value, ['sourceUrl', 'sourceURL', 'source_url', 'sourceCodeUrl', 'repositoryUrl']);
    const issuesUrl = readString(value, ['issueTrackerUrl', 'issuesUrl', 'issuesURL', 'issues_url']);
    const license = readString(value, ['license', 'licenseName', 'license_name']);
    const dateCreated = readString(value, ['dateCreated', 'date_created', 'createdAt', 'created_at', 'created', 'published']);
    const dateModified = readString(value, [
      'dateModified', 'date_modified', 'modifiedAt', 'modified_at', 'updatedAt', 'updated_at',
      'updated', 'lastUpdated', 'last_updated', 'dateReleased', 'date_released', 'latestFileDate',
    ]);
    const icon = readImage(value);

    let score = 0;
    if (explicitId) score += 4;
    if (/project|addon|mod/i.test(path)) score += 2;
    if (slug) score += 1;
    if (downloads != null) score += 1;
    if (summary || description) score += 1;
    if (icon) score += 1;
    const looksLikeFile = !!readString(value, ['fileId', 'fileID', 'file_id']) ||
      (!!readString(value, ['fileName', 'file_name']) && !slug && downloads == null);

    if (id && name && score >= 3 && !looksLikeFile) {
      keep({ id, name, slug, summary, description, icon, downloads, status, sourceUrl, issuesUrl, license, dateCreated, dateModified });
    }
    for (const [key, child] of Object.entries(value)) inspect(child, path ? `${path}.${key}` : key, depth + 1);
  };

  const readDom = () => {
    const links = Array.from(document.querySelectorAll('a[href]'));
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/(?:#\/|\/)projects\/(\d+)/i);
      if (!match) continue;
      const id = match[1];
      const card = link.closest('tr,article,li,[class*="card" i],[class*="paper" i]') || link.parentElement;
      const heading = card?.querySelector?.('h1,h2,h3,h4,[class*="title" i],[class*="name" i]');
      let name = norm(link.getAttribute('aria-label') || heading?.textContent || link.textContent);
      if (!name || name.length > 140 || /^(edit|manage|files|project)$/i.test(name)) continue;
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

  const loggedOut = () => {
    const body = norm(document.body?.innerText);
    return /sign in|log in|continue with google/i.test(body) && !/projects|dashboard|statistics|rewards/i.test(body);
  };

  const run = async () => {
    for (let attempt = 0; attempt < 36; attempt++) {
      if (loggedOut()) {
        window.__FODRINTH_CF_PROJECTS_RESULT__ = { connected: false, needsLogin: true, projects: [] };
        return;
      }
      const captured = captures();
      for (const capture of captured) inspect(capture.value, capture.url, 0);
      readDom();
      if (projects.size > 0) break;
      await sleep(300);
    }
    window.__FODRINTH_CF_PROJECTS_RESULT__ = {
      connected: true,
      needsLogin: false,
      projects: Array.from(projects.values()).sort((a, b) => a.name.localeCompare(b.name)),
      capturesSeen: captures().length,
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

const DOWNLOAD_SCRAPER: &str = r###"
(() => {
  window.__FODRINTH_CF_DOWNLOAD_RESULT__ = null;
  const periodDays = Math.max(1, Number('__PERIOD_DAYS__') || 30);
  const DAY = 86400000;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const toNumber = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string') return null;
    const compact = v.trim().match(/^(-?[\d,.]+(?:\.\d+)?)\s*([kmb])$/i);
    if (compact) {
      const base = Number(compact[1].replace(/,/g, ''));
      const factor = { k: 1e3, m: 1e6, b: 1e9 }[compact[2].toLowerCase()];
      return Number.isFinite(base) ? base * factor : null;
    }
    const match = v.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const n = Number(match[0]);
    return Number.isFinite(n) ? n : null;
  };
  const toDate = (value) => {
    if (value == null || value === '') return null;
    if (typeof value === 'number') {
      const millis = value > 100000000000 ? value : value > 1000000000 ? value * 1000 : value;
      const d = new Date(millis);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const text = norm(value);
    let d = new Date(text);
    if (!Number.isNaN(d.getTime())) return d;
    const m = text.match(/(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    if (m) {
      d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const us = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (us) {
      d = new Date(Number(us[3]), Number(us[1]) - 1, Number(us[2]), 12);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
  };
  const captures = () => (window.__FODRINTH_CF_CAPTURES__ || [])
    .map((entry) => {
      try { return { url: String(entry?.url || ''), value: JSON.parse(entry?.text || '') }; }
      catch (_) { return null; }
    })
    .filter(Boolean);

  const flatten = (value, prefix = '', depth = 0, out = []) => {
    if (depth > 4 || value == null) return out;
    if (Array.isArray(value)) return out;
    if (typeof value !== 'object') {
      out.push([prefix, value]);
      return out;
    }
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (child != null && typeof child === 'object' && !Array.isArray(child)) flatten(child, path, depth + 1, out);
      else if (!Array.isArray(child)) out.push([path, child]);
    }
    return out;
  };

  const dateFromFlat = (flat) => {
    const preferred = flat.filter(([key]) => /(^|\.)(date|day|time|timestamp|bucket|period|createdAt|dateCreated)$/i.test(key));
    const loose = flat.filter(([key]) => /date|day|time|timestamp|bucket/i.test(key));
    for (const [, value] of [...preferred, ...loose]) {
      const date = toDate(value);
      if (date) return date;
    }
    return null;
  };
  const metricFromFlat = (flat, unique, pathHint = '') => {
    const tests = unique
      ? [/unique.*download|download.*unique/i, /unique/i]
      : [/total.*download|download.*total/i, /downloads?|downloadCount|download_count/i];
    for (const test of tests) {
      const entry = flat.find(([key, value]) => test.test(key) && toNumber(value) != null);
      if (entry) return toNumber(entry[1]);
    }
    if (/download/i.test(pathHint)) {
      const generic = flat.find(([key, value]) => /(^|\.)(value|count|total)$/i.test(key) && toNumber(value) != null);
      if (generic) return toNumber(generic[1]);
    }
    return null;
  };

  const seriesCandidates = [];
  const considerRows = (items, path) => {
    if (!Array.isArray(items) || items.length < 2) return;
    const rows = [];
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const flat = flatten(item);
      const date = dateFromFlat(flat);
      if (!date) continue;
      const total = metricFromFlat(flat, false, path);
      const unique = metricFromFlat(flat, true, path);
      if (total == null && unique == null) continue;
      rows.push({ date: date.toISOString(), total, unique });
    }
    if (rows.length < 2) return;
    const recent = rows.filter((row) => Date.now() - new Date(row.date).getTime() < periodDays * 3 * DAY).length;
    let score = rows.length * 12 + recent * 6;
    if (/download/i.test(path)) score += 45;
    if (/trend|time|chart|history|stat/i.test(path)) score += 20;
    seriesCandidates.push({ rows, score, path });
  };

  const considerDatasets = (object, path) => {
    if (!object || typeof object !== 'object' || Array.isArray(object)) return;
    const entries = Object.entries(object);
    const labelsEntry = entries.find(([key, value]) => /labels|categories|dates|buckets|timestamps/i.test(key) && Array.isArray(value) && value.length >= 2);
    const seriesEntry = entries.find(([key, value]) => /series|datasets|lines/i.test(key) && Array.isArray(value) && value.length);
    if (!labelsEntry || !seriesEntry) return;
    const labels = labelsEntry[1].map(toDate);
    if (labels.filter(Boolean).length < 2) return;

    const rows = labels.map((date) => ({ date: date?.toISOString?.() || null, total: 0, unique: 0, hasTotal: false, hasUnique: false }));
    for (const dataset of seriesEntry[1]) {
      if (!dataset || typeof dataset !== 'object') continue;
      const name = norm(dataset.name ?? dataset.label ?? dataset.title ?? dataset.key);
      const values = Array.isArray(dataset.data) ? dataset.data : Array.isArray(dataset.values) ? dataset.values : Array.isArray(dataset.points) ? dataset.points : null;
      if (!values || values.length !== rows.length) continue;
      const isUnique = /unique/i.test(name);
      const isDownloadSeries = /download/i.test(name) || /download/i.test(path) || (!name && /download/i.test(path));
      if (!isDownloadSeries) continue;
      values.forEach((raw, index) => {
        const value = toNumber(raw?.value ?? raw?.y ?? raw);
        if (value == null || !rows[index].date) return;
        if (isUnique) {
          rows[index].unique += value;
          rows[index].hasUnique = true;
        } else {
          rows[index].total += value;
          rows[index].hasTotal = true;
        }
      });
    }
    const normalized = rows.filter((row) => row.date && (row.hasTotal || row.hasUnique)).map((row) => ({
      date: row.date,
      total: row.hasTotal ? row.total : null,
      unique: row.hasUnique ? row.unique : null,
    }));
    if (normalized.length < 2) return;
    let score = normalized.length * 12 + 35;
    if (/download/i.test(path)) score += 45;
    seriesCandidates.push({ rows: normalized, score, path: `${path}.datasets` });
  };

  const visitSeries = (value, path = '', depth = 0) => {
    if (depth > 14 || value == null) return;
    if (Array.isArray(value)) {
      considerRows(value, path);
      value.forEach((child, index) => visitSeries(child, `${path}[${index}]`, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;
    considerDatasets(value, path);
    for (const [key, child] of Object.entries(value)) visitSeries(child, path ? `${path}.${key}` : key, depth + 1);
  };

  const projectMap = new Map();
  const keepProject = (candidate) => {
    const id = norm(candidate.id || candidate.name);
    const name = norm(candidate.name || candidate.id);
    if (!id || !name) return;
    const old = projectMap.get(id) || { id, name, icon: null, period: null, total: null, allTime: null, unique: null };
    old.name = name || old.name;
    old.icon = candidate.icon || old.icon;
    for (const key of ['period', 'total', 'allTime', 'unique']) {
      const value = toNumber(candidate[key]);
      if (value != null && (old[key] == null || value > old[key])) old[key] = value;
    }
    projectMap.set(id, old);
  };

  const inspectProjects = (value, path = '', depth = 0) => {
    if (depth > 14 || value == null) return;
    if (Array.isArray(value)) {
      value.forEach((child, index) => inspectProjects(child, `${path}[${index}]`, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;
    const flat = flatten(value);
    const findText = (pattern) => flat.find(([key, val]) => pattern.test(key) && (typeof val === 'string' || typeof val === 'number'))?.[1];
    const id = findText(/(^|\.)(projectId|project_id|modId|mod_id|id)$/i);
    const name = findText(/(^|\.)(projectName|project_name|name|title|slug)$/i);
    if (id != null && name != null && /project|download|stat|mod/i.test(path)) {
      const total = metricFromFlat(flat, false, path);
      const unique = metricFromFlat(flat, true, path);
      const allTimeEntry = flat.find(([key, val]) => /all.?time|lifetime|totalProjectDownloads/i.test(key) && toNumber(val) != null);
      const periodEntry = flat.find(([key, val]) => /period|current|selectedRange|rangeDownloads|downloadsInRange/i.test(key) && toNumber(val) != null);
      const iconEntry = flat.find(([key, val]) => /icon.*url|logo.*url|thumbnail.*url/i.test(key) && typeof val === 'string');
      if (total != null || unique != null || allTimeEntry || periodEntry) {
        keepProject({
          id,
          name,
          icon: iconEntry?.[1] || null,
          period: periodEntry ? toNumber(periodEntry[1]) : (/trend|range|period|chart|stat/i.test(path) ? total : null),
          total,
          allTime: allTimeEntry ? toNumber(allTimeEntry[1]) : (/lifetime|all.?time/i.test(path) ? total : null),
          unique,
        });
      }
    }
    for (const [key, child] of Object.entries(value)) inspectProjects(child, path ? `${path}.${key}` : key, depth + 1);
  };

  const collectProjectSeries = (value, path = '', depth = 0) => {
    if (depth > 14 || value == null) return;
    if (Array.isArray(value)) {
      if (/project|download/i.test(path)) {
        for (const item of value) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          const flat = flatten(item);
          const date = dateFromFlat(flat);
          if (!date) continue;
          const timestamp = date.getTime();
          if (timestamp < Date.now() - periodDays * DAY || timestamp > Date.now() + DAY) continue;
          const idEntry = flat.find(([key]) => /(^|\.)(projectId|project_id|modId|mod_id|id)$/i.test(key));
          const nameEntry = flat.find(([key, val]) => /(^|\.)(projectName|project_name|name|title|slug)$/i.test(key) && typeof val === 'string');
          if (!idEntry && !nameEntry) continue;
          const total = metricFromFlat(flat, false, path);
          const unique = metricFromFlat(flat, true, path);
          if (total == null && unique == null) continue;
          const key = norm(idEntry?.[1] ?? nameEntry?.[1]);
          const existing = projectMap.get(key) || {
            id: key,
            name: norm(nameEntry?.[1] ?? key),
            icon: null,
            period: 0,
            total: null,
            allTime: null,
            unique: 0,
          };
          if (total != null) existing.period = (toNumber(existing.period) ?? 0) + total;
          if (unique != null) existing.unique = (toNumber(existing.unique) ?? 0) + unique;
          projectMap.set(key, existing);
        }
      }
      value.forEach((child, index) => collectProjectSeries(child, `${path}[${index}]`, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) collectProjectSeries(child, path ? `${path}.${key}` : key, depth + 1);
  };

  const findSmallLabelElement = (patterns) => {
    const all = Array.from(document.querySelectorAll('body *'));
    for (const pattern of patterns) {
      const matches = all.filter((el) => {
        const text = norm(el.textContent);
        return text && text.length < 120 && pattern.test(text);
      });
      matches.sort((a, b) => norm(a.textContent).length - norm(b.textContent).length);
      if (matches[0]) return { element: matches[0], pattern };
    }
    return null;
  };
  const cardMetric = (patterns) => {
    const found = findSmallLabelElement(patterns);
    if (!found) return null;
    let node = found.element;
    for (let depth = 0; depth < 7 && node; depth++, node = node.parentElement) {
      const text = norm(node.innerText || node.textContent);
      const withoutLabel = text.replace(found.pattern, ' ');
      const numberMatches = Array.from(withoutLabel.matchAll(/(?:^|\s)([\d,.]+(?:\.\d+)?\s*[kmb]?)(?!\s*%)/gi));
      const values = numberMatches.map((m) => toNumber(m[1])).filter((n) => n != null);
      if (values.length) {
        const pct = text.match(/([+-]?\d+(?:\.\d+)?)\s*%/);
        return { value: values[0], percent: pct ? Number(pct[1]) : null, text };
      }
    }
    return null;
  };

  const clickDownloads = async () => {
    const body = norm(document.body?.innerText);
    if (/total project downloads|unique downloads|downloads over time/i.test(body)) return;
    const candidates = Array.from(document.querySelectorAll('a[href],button,[role="button"]'));
    const exact = candidates.find((el) => /^downloads$/i.test(norm(el.textContent)));
    const statistics = candidates.find((el) => /^statistics$/i.test(norm(el.textContent)));
    if (statistics) {
      statistics.click();
      await sleep(700);
    }
    const refreshed = Array.from(document.querySelectorAll('a[href],button,[role="button"]'));
    const downloads = refreshed.find((el) => /^downloads$/i.test(norm(el.textContent))) || exact;
    if (downloads) {
      downloads.click();
      await sleep(2200);
    }
  };

  const trySelectPeriod = async () => {
    const labels = [`Last ${periodDays} days`, `${periodDays} days`, `${periodDays}d`].map((v) => v.toLowerCase());
    const controls = Array.from(document.querySelectorAll('button,[role="button"],option,[role="option"]'));
    const match = controls.find((el) => labels.includes(norm(el.textContent).toLowerCase()));
    if (match && match.tagName !== 'OPTION') {
      match.click();
      await sleep(1400);
    }
  };

  const loggedOut = () => {
    const body = norm(document.body?.innerText);
    return /sign in|log in|continue with google/i.test(body) && !/dashboard|statistics|downloads|projects|rewards/i.test(body);
  };

  const run = async () => {
    for (let i = 0; i < 20; i++) {
      if (loggedOut()) {
        window.__FODRINTH_CF_DOWNLOAD_RESULT__ = { needsLogin: true, series: [], projects: [] };
        return;
      }
      if (norm(document.body?.innerText).length > 100) break;
      await sleep(250);
    }

    await clickDownloads();
    await trySelectPeriod();
    await sleep(700);

    const captured = captures();
    for (const capture of captured) {
      visitSeries(capture.value, capture.url, 0);
      inspectProjects(capture.value, capture.url, 0);
      collectProjectSeries(capture.value, capture.url, 0);
    }
    seriesCandidates.sort((a, b) => b.score - a.score);
    let series = (seriesCandidates[0]?.rows || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));

    // Merge duplicate dates; some dashboard endpoints expose one series per game/project.
    const merged = new Map();
    for (const row of series) {
      const key = row.date.slice(0, 10);
      const old = merged.get(key) || { date: row.date, total: 0, unique: 0, hasTotal: false, hasUnique: false };
      if (Number.isFinite(row.total)) { old.total += row.total; old.hasTotal = true; }
      if (Number.isFinite(row.unique)) { old.unique += row.unique; old.hasUnique = true; }
      merged.set(key, old);
    }
    series = Array.from(merged.values()).map((row) => ({
      date: row.date,
      total: row.hasTotal ? row.total : null,
      unique: row.hasUnique ? row.unique : null,
    })).sort((a, b) => new Date(a.date) - new Date(b.date));

    const seven = cardMetric([/^last 7 days$/i]);
    const thirty = cardMetric([/^last 30 days$/i]);
    const yesterday = cardMetric([/^yesterday(?:\s+vs\.?\s+same day last week)?$/i, /^yesterday$/i]);
    const allTime = cardMetric([/^total project downloads$/i, /^all[- ]time downloads$/i, /^total downloads$/i]);
    const uniqueCard = cardMetric([/^unique downloads$/i, /^total unique downloads$/i]);

    const now = Date.now();
    const currentStart = now - periodDays * DAY;
    const previousStart = now - periodDays * 2 * DAY;
    const sumRange = (field, start, end) => series.reduce((total, row) => {
      const time = new Date(row.date).getTime();
      const value = row[field];
      return time >= start && time < end && Number.isFinite(value) ? total + value : total;
    }, 0);
    const hasTotal = series.some((row) => Number.isFinite(row.total));
    const hasUnique = series.some((row) => Number.isFinite(row.unique));

    let current = periodDays === 7 ? seven?.value : periodDays === 30 ? thirty?.value : null;
    let changePercent = periodDays === 7 ? seven?.percent : periodDays === 30 ? thirty?.percent : null;
    let previous = current != null && Number.isFinite(changePercent) && Math.abs(100 + changePercent) > 0.0001
      ? current / (1 + changePercent / 100)
      : null;
    if (current == null && hasTotal) current = sumRange('total', currentStart, now + DAY);
    if (previous == null && hasTotal) previous = sumRange('total', previousStart, currentStart);

    const uniqueCurrent = hasUnique ? sumRange('unique', currentStart, now + DAY) : uniqueCard?.value ?? null;
    const uniquePrevious = hasUnique ? sumRange('unique', previousStart, currentStart) : null;
    const projects = Array.from(projectMap.values()).map((project) => ({
      ...project,
      current: project.period,
      allTime: project.allTime ?? project.total,
    })).filter((project) => project.name && (project.period != null || project.total != null || project.unique != null));

    window.__FODRINTH_CF_DOWNLOAD_RESULT__ = {
      needsLogin: false,
      current,
      previous,
      changePercent: Number.isFinite(changePercent) ? changePercent : null,
      uniqueCurrent,
      uniquePrevious,
      allTime: allTime?.value ?? (projects.length ? projects.reduce((sum, project) => sum + (toNumber(project.allTime) ?? 0), 0) : null),
      yesterday: yesterday?.value ?? null,
      yesterdayChangePercent: Number.isFinite(yesterday?.percent) ? yesterday.percent : null,
      series,
      projects,
      capturesSeen: captured.length,
      seriesSource: seriesCandidates[0]?.path || null,
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

const TRANSACTION_SCRAPER: &str = r###"
(() => {
  window.__FODRINTH_CF_TX_RESULT__ = null;
  const periodDays = Math.max(1, Number('__PERIOD_DAYS__') || 30);
  const cutoff = Date.now() - periodDays * 2 * 86400000;
  const pointRate = 0.05;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const toNumber = (value) => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    const match = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const number = Number(match[0]);
    return Number.isFinite(number) ? number : null;
  };
  const parseDate = (raw) => {
    if (typeof raw === 'number') {
      const value = raw > 100000000000 ? raw : raw > 1000000000 ? raw * 1000 : raw;
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    const text = norm(raw);
    let date = new Date(text);
    if (!Number.isNaN(date.getTime())) return date;
    const match = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[^0-9]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!match) return null;
    date = new Date(Number(match[3]), Number(match[1]) - 1, Number(match[2]), Number(match[4] || 12), Number(match[5] || 0), Number(match[6] || 0));
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const captures = () => (window.__FODRINTH_CF_CAPTURES__ || [])
    .map((entry) => {
      try { return { url: String(entry?.url || ''), value: JSON.parse(entry?.text || '') }; }
      catch (_) { return null; }
    }).filter(Boolean);

  const parseBalance = () => {
    const body = norm(document.body?.innerText);
    const matches = [
      /(?:balance|available|reward)[^\d]{0,40}([\d,.]+)\s*points?/i,
      /([\d,.]+)\s*points?[^\n]{0,40}(?:balance|available)/i,
      /(?:^|\s)([\d,.]+)\s*points?/i,
    ];
    for (const pattern of matches) {
      const match = body.match(pattern);
      const value = match ? toNumber(match[1]) : null;
      if (value != null) return value;
    }
    return null;
  };

  const parseExpandedProjects = async (row, expected) => {
    const button = row.querySelector('button[aria-controls*="expand" i],[aria-controls*="expand" i],button[aria-expanded]');
    if (!button) return [];
    const wasExpanded = norm(button.getAttribute('aria-expanded')).toLowerCase() === 'true';
    if (!wasExpanded) {
      button.click();
      await sleep(180);
    }
    const id = button.getAttribute('aria-controls');
    const panel = id ? document.getElementById(id) : row.nextElementSibling;
    const lines = String(panel?.innerText || '').split(/\n+/).map(norm).filter(Boolean);
    const result = [];
    for (let index = 0; index < lines.length; index++) {
      if (!/^points for$/i.test(lines[index])) continue;
      const points = toNumber(lines[index - 1]);
      const name = norm(lines[index + 1]);
      if (points == null || !name) continue;
      result.push({ name, points, usd: points * pointRate });
    }
    if (!wasExpanded) button.click();
    const sum = result.reduce((total, project) => total + project.points, 0);
    if (result.length && Number.isFinite(expected) && expected - sum > 0.02) {
      const points = expected - sum;
      result.push({ name: '(Unattributed / rounding)', points, usd: points * pointRate });
    }
    return result;
  };

  const readRows = async () => {
    const earnings = [];
    const withdrawals = [];
    const seen = new Set();
    const rows = Array.from(document.querySelectorAll('tbody tr,tr.MuiTableRow-root.RaDatagrid-row,[role="row"]'));
    for (const row of rows) {
      const text = norm(row.innerText);
      if (!text || (!/points generated/i.test(text) && !/fulfilled|withdraw|redeem/i.test(text))) continue;
      const cells = Array.from(row.querySelectorAll('td,[role="cell"],[role="gridcell"]'));
      let date = null;
      for (const cell of cells) {
        const el = cell.querySelector('time,[datetime],[data-date],[data-datetime]') || cell;
        date = parseDate(el.getAttribute?.('datetime') || el.getAttribute?.('data-date') || el.getAttribute?.('data-datetime') || el.getAttribute?.('title') || el.textContent);
        if (date) break;
      }
      if (!date || date.getTime() < cutoff) continue;

      const pointCell = row.querySelector('td.column-points,[class*="points" i]') || cells.find((cell) => /^\s*-?[\d,.]+\s*$/.test(norm(cell.textContent)));
      let points = toNumber(pointCell?.textContent);
      if (points == null) {
        const match = text.match(/(-?[\d,.]+)\s*points?/i);
        points = match ? toNumber(match[1]) : null;
      }
      if (points == null) continue;

      const key = `${date.toISOString()}|${text}|${points}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (/points generated/i.test(text) && points > 0) {
        const projects = await parseExpandedProjects(row, points);
        earnings.push({ timestamp: date.toISOString(), points, usd: points * pointRate, details: text, projects });
      } else if ((/fulfilled|withdraw|redeem/i.test(text) && points < 0) || /withdraw|redeem/i.test(text)) {
        withdrawals.push({ timestamp: date.toISOString(), points, usd: Math.abs(points) * pointRate, details: text });
      }
    }
    return { earnings, withdrawals };
  };

  const readCapturedTransactions = () => {
    const earnings = [];
    const withdrawals = [];
    const seen = new Set();
    const visit = (value, path = '', depth = 0) => {
      if (depth > 14 || value == null) return;
      if (Array.isArray(value)) {
        value.forEach((child, index) => visit(child, `${path}[${index}]`, depth + 1));
        return;
      }
      if (typeof value !== 'object') return;
      const entries = Object.entries(value);
      const dateEntry = entries.find(([key]) => /dateCreated|createdAt|timestamp|date|created/i.test(key));
      const pointsEntry = entries.find(([key, val]) => /points|rewardAmount|amount/i.test(key) && toNumber(val) != null);
      if (dateEntry && pointsEntry && /transaction|reward|point|earning|withdraw/i.test(path)) {
        const date = parseDate(dateEntry[1]);
        const points = toNumber(pointsEntry[1]);
        const type = norm(value.type ?? value.transactionType ?? value.description ?? value.name ?? '');
        const status = norm(value.status ?? value.transactionStatus ?? '');
        if (date && date.getTime() >= cutoff && points != null) {
          const key = `${date.toISOString()}|${points}|${type}|${status}`;
          if (!seen.has(key)) {
            seen.add(key);
            if ((/generated|earned|reward/i.test(type) || points > 0) && points > 0) {
              earnings.push({ timestamp: date.toISOString(), points, usd: points * pointRate, details: type || path, projects: [] });
            } else if (/fulfilled|withdraw|redeem|payout/i.test(`${status} ${type}`) && points < 0) {
              withdrawals.push({ timestamp: date.toISOString(), points, usd: Math.abs(points) * pointRate, details: `${type} ${status}`.trim() });
            }
          }
        }
      }
      for (const [key, child] of entries) visit(child, path ? `${path}.${key}` : key, depth + 1);
    };
    for (const capture of captures()) visit(capture.value, capture.url, 0);
    return { earnings, withdrawals };
  };

  const loggedOut = () => {
    const body = norm(document.body?.innerText);
    return /sign in|log in|continue with google/i.test(body) && !/transactions|points generated|rewards|dashboard/i.test(body);
  };

  const run = async () => {
    for (let i = 0; i < 24; i++) {
      if (loggedOut()) {
        window.__FODRINTH_CF_TX_RESULT__ = { needsLogin: true, rewardPoints: null, earnings: [], withdrawals: [] };
        return;
      }
      if (norm(document.body?.innerText).length > 100) break;
      await sleep(250);
    }

    const dom = await readRows();
    const captured = readCapturedTransactions();
    const merge = (left, right) => {
      const map = new Map();
      for (const item of [...left, ...right]) {
        const key = `${item.timestamp}|${item.points}|${item.details || ''}`;
        if (!map.has(key)) map.set(key, item);
      }
      return Array.from(map.values()).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    };
    const earnings = merge(dom.earnings, captured.earnings);
    const withdrawals = merge(dom.withdrawals, captured.withdrawals);
    const rewardPoints = parseBalance();

    window.__FODRINTH_CF_TX_RESULT__ = {
      needsLogin: false,
      rewardPoints,
      rewardBalanceUsd: Number.isFinite(rewardPoints) ? rewardPoints * pointRate : null,
      earnings,
      withdrawals,
      capturesSeen: captures().length,
    };
  };

  run().catch((error) => {
    window.__FODRINTH_CF_TX_RESULT__ = {
      needsLogin: false,
      rewardPoints: null,
      rewardBalanceUsd: null,
      earnings: [],
      withdrawals: [],
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
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err(format!("Timed out waiting for {global_name}"))
}

async fn wait_for_document<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_secs(18) {
        let state = eval_json(
            window,
            "JSON.stringify({ready: document.readyState, body: document.body?.innerText?.length || 0})"
                .to_string(),
        )
        .await;
        if let Ok(value) = state {
            let ready = value.get("ready").and_then(Value::as_str).unwrap_or("");
            let body = value.get("body").and_then(Value::as_u64).unwrap_or(0);
            if ready != "loading" && body > 40 {
                tokio::time::sleep(Duration::from_millis(1400)).await;
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Ok(())
}

async fn ensure_author_window<R: Runtime>(
    app: &AppHandle<R>,
    visible: bool,
) -> Result<WebviewWindow<R>, String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        if visible {
            let url = Url::parse(DASHBOARD_URL).map_err(|error| error.to_string())?;
            window
                .navigate(url)
                .map_err(|error| format!("Could not open CurseForge Authors: {error}"))?;
            window.show().map_err(|error| error.to_string())?;
            window.set_focus().map_err(|error| error.to_string())?;
        }
        return Ok(window);
    }

    let url = Url::parse(DASHBOARD_URL).map_err(|error| error.to_string())?;
    let window = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(url))
        .title("CurseForge Authors")
        .inner_size(1180.0, 820.0)
        .min_inner_size(900.0, 640.0)
        .visible(visible)
        .initialization_script(CAPTURE_SCRIPT)
        .build()
        .map_err(|error| format!("Could not create CurseForge Authors session: {error}"))?;
    if visible {
        window.set_focus().map_err(|error| error.to_string())?;
    }
    Ok(window)
}

async fn navigate_and_wait<R: Runtime>(
    window: &WebviewWindow<R>,
    url: &str,
) -> Result<(), String> {
    let parsed = Url::parse(url).map_err(|error| error.to_string())?;
    window
        .navigate(parsed)
        .map_err(|error| format!("Could not navigate CurseForge Authors: {error}"))?;
    wait_for_document(window).await
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
pub async fn curseforge_open_author_portal<R: Runtime>(
    app: AppHandle<R>,
) -> Result<(), String> {
    let _ = ensure_author_window(&app, true).await?;
    Ok(())
}

#[tauri::command]
pub async fn curseforge_get_author_projects<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Value, String> {
    let window = ensure_author_window(&app, false).await?;
    navigate_and_wait(&window, PROJECTS_URL).await?;
    window
        .eval(PROJECTS_SCRAPER)
        .map_err(|error| format!("Could not start CurseForge project reader: {error}"))?;
    poll_global(
        &window,
        "__FODRINTH_CF_PROJECTS_RESULT__",
        Duration::from_secs(28),
    )
    .await
}

async fn scrape_transactions<R: Runtime>(
    window: &WebviewWindow<R>,
    period_days: u32,
) -> Result<Value, String> {
    navigate_and_wait(window, TRANSACTIONS_URL).await?;
    let script = TRANSACTION_SCRAPER.replace("__PERIOD_DAYS__", &period_days.to_string());
    window
        .eval(script)
        .map_err(|error| format!("Could not start CurseForge rewards reader: {error}"))?;
    poll_global(window, "__FODRINTH_CF_TX_RESULT__", Duration::from_secs(35)).await
}

async fn scrape_downloads<R: Runtime>(
    window: &WebviewWindow<R>,
    period_days: u32,
) -> Result<Value, String> {
    navigate_and_wait(window, DASHBOARD_URL).await?;
    let script = DOWNLOAD_SCRAPER.replace("__PERIOD_DAYS__", &period_days.to_string());
    window
        .eval(script)
        .map_err(|error| format!("Could not start CurseForge downloads reader: {error}"))?;
    poll_global(
        window,
        "__FODRINTH_CF_DOWNLOAD_RESULT__",
        Duration::from_secs(30),
    )
    .await
}

#[tauri::command]
pub async fn curseforge_get_author_analytics<R: Runtime>(
    app: AppHandle<R>,
    period_days: u32,
) -> Result<Value, String> {
    let period_days = period_days.clamp(1, 365);
    let window = ensure_author_window(&app, false).await?;

    let transactions = match scrape_transactions(&window, period_days).await {
        Ok(value) => value,
        Err(error) => json!({
            "needsLogin": false,
            "rewardPoints": null,
            "rewardBalanceUsd": null,
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
        return Ok(portal_status_fallback());
    }

    Ok(json!({
        "connected": true,
        "needsLogin": false,
        "pointsUsdRate": USD_PER_POINT,
        "rewardPoints": transactions.get("rewardPoints").cloned().unwrap_or(Value::Null),
        "rewardBalanceUsd": transactions.get("rewardBalanceUsd").cloned().unwrap_or(Value::Null),
        "earnings": transactions.get("earnings").cloned().unwrap_or_else(|| json!([])),
        "withdrawals": transactions.get("withdrawals").cloned().unwrap_or_else(|| json!([])),
        "downloads": downloads,
        "transactionsError": transactions.get("error").cloned().unwrap_or(Value::Null),
        "downloadsError": downloads.get("error").cloned().unwrap_or(Value::Null),
    }))
}
