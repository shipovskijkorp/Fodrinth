use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::Url;

const WINDOW_LABEL: &str = "curseforge-authors";
const DASHBOARD_URL: &str = "https://authors.curseforge.com/dashboard";

const CAPTURE_SCRIPT: &str = r###"
(() => {
  if (location.hostname !== 'authors.curseforge.com') return;
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
        text: text.length > 2000000 ? text.slice(0, 2000000) : text,
        at: Date.now(),
      });
      if (bucket.length > 240) bucket.splice(0, bucket.length - 240);
    } catch (_) {}
  };

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function(...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const clone = response.clone();
        clone.text().then((text) => record(
          clone.url || args[0]?.url || args[0] || '',
          text,
          clone.headers?.get?.('content-type') || '',
        )).catch(() => {});
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
        if (typeof this.responseText === 'string') {
          record(
            this.responseURL || this.__fodrinthUrl || '',
            this.responseText,
            this.getResponseHeader('content-type') || '',
          );
        }
      } catch (_) {}
    }, { once: true });
    return originalSend.apply(this, args);
  };
})();
"###;

const DOWNLOAD_SCRAPER: &str = r###"
(() => {
  window.__FODRINTH_CF_DOWNLOAD_V2_RESULT__ = null;
  const periodDays = Math.max(1, Number('__PERIOD_DAYS__') || 30);
  const DAY = 86400000;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

  const toNumber = (value) => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value == null) return null;
    if (typeof value === 'object') {
      return toNumber(value.value ?? value.count ?? value.total ?? value.downloads ?? value.y);
    }
    const text = String(value).trim().replace(/\s/g, '');
    if (!text) return null;
    const compact = text.match(/^([+-]?[\d,.]+(?:\.\d+)?)\s*([kmb])$/i);
    if (compact) {
      const base = Number(compact[1].replace(/,/g, ''));
      const factor = { k: 1e3, m: 1e6, b: 1e9 }[compact[2].toLowerCase()];
      return Number.isFinite(base) ? base * factor : null;
    }
    if (!/^[+-]?[\d,.]+(?:\.\d+)?$/.test(text)) return null;
    const number = Number(text.replace(/,/g, ''));
    return Number.isFinite(number) ? number : null;
  };

  const toDate = (value) => {
    if (value == null || value === '') return null;
    if (typeof value === 'number') {
      const millis = value > 100000000000 ? value : value > 1000000000 ? value * 1000 : null;
      if (millis == null) return null;
      const date = new Date(millis);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    const text = norm(value);
    if (!text) return null;
    let date = new Date(text);
    if (!Number.isNaN(date.getTime())) return date;
    const iso = text.match(/(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    if (iso) {
      date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    const us = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (us) {
      date = new Date(Number(us[3]), Number(us[1]) - 1, Number(us[2]), 12);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    return null;
  };

  const captures = () => (window.__FODRINTH_CF_CAPTURES__ || [])
    .map((entry) => {
      try { return { url: String(entry?.url || ''), value: JSON.parse(entry?.text || '') }; }
      catch (_) { return null; }
    })
    .filter(Boolean);

  const loggedOut = () => {
    const body = norm(document.body?.innerText);
    return /sign in|log in|continue with google/i.test(body) && !/statistics|downloads|dashboard|projects/i.test(body);
  };

  const clickExact = async (label) => {
    const candidates = Array.from(document.querySelectorAll('a[href],button,[role="button"],[role="tab"]'));
    const target = candidates.find((element) => norm(element.textContent).toLowerCase() === label.toLowerCase());
    if (!target) return false;
    target.click();
    await sleep(900);
    return true;
  };

  const openDownloads = async () => {
    for (let attempt = 0; attempt < 18; attempt++) {
      const body = norm(document.body?.innerText);
      if (/total project downloads/i.test(body) && /last 30 days/i.test(body)) return true;
      if (loggedOut()) return false;
      if (attempt === 1) await clickExact('Statistics');
      if (attempt >= 1) await clickExact('Downloads');
      await sleep(500);
    }
    return /downloads/i.test(norm(document.body?.innerText));
  };

  const selectPeriod = async () => {
    const aliases = periodDays === 7
      ? ['last 7 days', '7 days', '7d']
      : periodDays === 30
        ? ['last 30 days', '30 days', '30d']
        : periodDays === 90
          ? ['last 90 days', '90 days', '90d', 'last 3 months', '3 months']
          : [`last ${periodDays} days`, `${periodDays} days`, `${periodDays}d`];

    const select = Array.from(document.querySelectorAll('select')).find((element) =>
      Array.from(element.options || []).some((option) => aliases.includes(norm(option.textContent).toLowerCase())),
    );
    if (select) {
      const option = Array.from(select.options).find((item) => aliases.includes(norm(item.textContent).toLowerCase()));
      if (option && select.value !== option.value) {
        select.value = option.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(1800);
      }
      return;
    }

    let controls = Array.from(document.querySelectorAll('button,[role="button"],[role="option"],[role="menuitem"]'));
    const direct = controls.find((element) => aliases.includes(norm(element.textContent).toLowerCase()));
    if (direct) {
      direct.click();
      await sleep(1800);
      return;
    }

    const likelyPicker = controls.find((element) => /last \d+ days|\d+d|months?/i.test(norm(element.textContent)));
    if (!likelyPicker) return;
    likelyPicker.click();
    await sleep(300);
    controls = Array.from(document.querySelectorAll('[role="option"],[role="menuitem"],button'));
    const option = controls.find((element) => aliases.includes(norm(element.textContent).toLowerCase()));
    if (option) {
      option.click();
      await sleep(1800);
    }
  };

  const leafElements = (root) => Array.from(root.querySelectorAll('*')).filter((element) => element.children.length === 0);
  const kpiMetric = (labels) => {
    const all = Array.from(document.querySelectorAll('body *'));
    const labelNodes = all.filter((element) => {
      const text = norm(element.textContent);
      return text && text.length < 90 && labels.some((pattern) => pattern.test(text));
    });
    let best = null;
    for (const labelNode of labelNodes) {
      let node = labelNode;
      for (let depth = 0; depth < 6 && node; depth++, node = node.parentElement) {
        const rect = node.getBoundingClientRect?.();
        if (!rect || rect.width < 80 || rect.width > 760 || rect.height < 40 || rect.height > 360) continue;
        const text = norm(node.innerText || node.textContent);
        if (text.length > 460) continue;
        const numericLeaves = leafElements(node).map((element) => {
          const raw = norm(element.textContent);
          if (!raw || raw.includes('%') || labels.some((pattern) => pattern.test(raw))) return null;
          const value = toNumber(raw);
          if (value == null) return null;
          const fontSize = Number.parseFloat(getComputedStyle(element).fontSize || '0') || 0;
          return { value, fontSize, raw };
        }).filter(Boolean);
        if (!numericLeaves.length) continue;
        numericLeaves.sort((a, b) => b.fontSize - a.fontSize || String(b.raw).length - String(a.raw).length);
        const valueLeaf = numericLeaves[0];
        const percentLeaf = leafElements(node)
          .map((element) => norm(element.textContent))
          .find((raw) => /^[+-]?\d+(?:\.\d+)?\s*%$/.test(raw.replace(/\s/g, '')));
        const percent = percentLeaf ? Number(percentLeaf.replace(/[^0-9+\-.]/g, '')) : null;
        const score = valueLeaf.fontSize * 10 - depth + Math.min(rect.width, 500) / 100;
        if (!best || score > best.score) best = { value: valueLeaf.value, percent, score, text };
      }
    }
    return best;
  };

  const flatten = (value, prefix = '', depth = 0, out = []) => {
    if (depth > 6 || value == null || typeof value === 'function') return out;
    if (Array.isArray(value)) return out;
    if (typeof value !== 'object') {
      out.push([prefix, value]);
      return out;
    }
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (child != null && typeof child === 'object' && !Array.isArray(child)) flatten(child, path, depth + 1, out);
      else if (!Array.isArray(child) && typeof child !== 'function') out.push([path, child]);
    }
    return out;
  };

  const contextName = (value, path) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return path;
    const label = norm(value.metric ?? value.metricName ?? value.name ?? value.label ?? value.title ?? value.key ?? value.type ?? value.seriesName ?? '');
    return `${path} ${label}`.trim();
  };

  const dateFromFlat = (flat) => {
    const preferred = flat.filter(([key]) => /(^|\.)(date|day|time|timestamp|bucket|x|createdAt|created_at)$/i.test(key));
    const loose = flat.filter(([key]) => /date|day|time|timestamp|bucket/i.test(key));
    for (const [, value] of [...preferred, ...loose]) {
      const date = toDate(value);
      if (date) return date;
    }
    return null;
  };

  const numberFromFlat = (flat, context, unique) => {
    const tests = unique
      ? [/unique.*download|download.*unique/i, /(^|\.)unique$/i]
      : [/total.*download|download.*total/i, /downloads?|downloadCount|download_count/i];
    for (const test of tests) {
      const entry = flat.find(([key, value]) => test.test(key) && toNumber(value) != null);
      if (entry) return toNumber(entry[1]);
    }
    const kindMatches = unique ? /unique/i.test(context) : /download|total/i.test(context) && !/unique/i.test(context);
    if (kindMatches) {
      const generic = flat.find(([key, value]) => /(^|\.)(value|count|total|y)$/i.test(key) && toNumber(value) != null);
      if (generic) return toNumber(generic[1]);
    }
    return null;
  };

  const totalCandidates = [];
  const uniqueCandidates = [];
  const addCandidate = (rows, kind, context, bonus = 0) => {
    const normalized = rows
      .filter((row) => row?.date && Number.isFinite(row?.value))
      .map((row) => ({ date: new Date(row.date).toISOString(), value: row.value }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    if (normalized.length < 2) return;
    const recent = normalized.filter((row) => Math.abs(Date.now() - new Date(row.date).getTime()) <= periodDays * 4 * DAY).length;
    let score = normalized.length * 10 + recent * 8 + bonus;
    if (/download/i.test(context)) score += 80;
    if (/chart|trend|history|time|daily|stat/i.test(context)) score += 30;
    if (kind === 'unique' && /unique/i.test(context)) score += 50;
    if (kind === 'total' && /total|download/i.test(context) && !/unique/i.test(context)) score += 30;
    (kind === 'unique' ? uniqueCandidates : totalCandidates).push({ rows: normalized, score, context });
  };

  const considerObjectRows = (items, context) => {
    if (!Array.isArray(items) || items.length < 2) return;
    const totalRows = [];
    const uniqueRows = [];
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const flat = flatten(item);
      const date = dateFromFlat(flat);
      if (!date) continue;
      const rowContext = contextName(item, context);
      const total = numberFromFlat(flat, rowContext, false);
      const unique = numberFromFlat(flat, rowContext, true);
      if (total != null) totalRows.push({ date, value: total });
      if (unique != null) uniqueRows.push({ date, value: unique });
    }
    addCandidate(totalRows, 'total', context);
    addCandidate(uniqueRows, 'unique', context);
  };

  const considerParallelArrays = (object, context) => {
    if (!object || typeof object !== 'object' || Array.isArray(object)) return;
    const entries = Object.entries(object);
    const dateEntry = entries.find(([key, value]) =>
      /(^|_)(labels?|categories|dates?|days?|buckets?|timestamps?|x)$/i.test(key) &&
      Array.isArray(value) && value.length >= 2 && value.filter((item) => toDate(item)).length >= 2,
    );
    if (!dateEntry) return;
    const dates = dateEntry[1].map(toDate);
    for (const [key, values] of entries) {
      if (!Array.isArray(values) || values.length !== dates.length || key === dateEntry[0]) continue;
      const named = `${context}.${key}`;
      let kind = /unique/i.test(named) ? 'unique' : /download|total/i.test(named) && !/unique/i.test(named) ? 'total' : null;
      if (!kind && /(^|_)(values?|counts?|y)$/i.test(key) && /download|unique|total/i.test(context)) {
        kind = /unique/i.test(context) ? 'unique' : 'total';
      }
      if (!kind) continue;
      const rows = dates.map((date, index) => ({ date, value: toNumber(values[index]) }));
      addCandidate(rows, kind, named, 55);
    }
  };

  const considerColumns = (items, context) => {
    if (!Array.isArray(items) || items.length < 2) return;
    const columns = items.filter((item) => item && typeof item === 'object' && !Array.isArray(item) && Array.isArray(item.values ?? item.data));
    if (columns.length < 2) return;
    const dateColumn = columns.find((column) => /date|day|time|timestamp|bucket|x/i.test(norm(column.name ?? column.key ?? column.label)));
    if (!dateColumn) return;
    const dates = (dateColumn.values ?? dateColumn.data).map(toDate);
    if (dates.filter(Boolean).length < 2) return;
    for (const column of columns) {
      if (column === dateColumn) continue;
      const name = `${context}.${norm(column.name ?? column.key ?? column.label)}`;
      const kind = /unique/i.test(name) ? 'unique' : /download|total/i.test(name) && !/unique/i.test(name) ? 'total' : null;
      if (!kind) continue;
      const values = column.values ?? column.data;
      if (values.length !== dates.length) continue;
      addCandidate(dates.map((date, index) => ({ date, value: toNumber(values[index]) })), kind, name, 60);
    }
  };

  const considerDataset = (dataset, context) => {
    if (!dataset || typeof dataset !== 'object') return;
    const name = contextName(dataset, context);
    const values = Array.isArray(dataset.data) ? dataset.data
      : Array.isArray(dataset.values) ? dataset.values
        : Array.isArray(dataset.points) ? dataset.points
          : null;
    if (!values || values.length < 2) return;
    const kind = /unique/i.test(name) ? 'unique' : /download|total/i.test(name) && !/unique/i.test(name) ? 'total' : null;
    if (!kind) return;
    const rows = [];
    for (const point of values) {
      let date = null;
      let value = null;
      if (Array.isArray(point) && point.length >= 2) {
        date = toDate(point[0]);
        value = toNumber(point[1]);
      } else if (point && typeof point === 'object') {
        date = toDate(point.x ?? point.date ?? point.time ?? point.timestamp ?? point.day ?? point.bucket);
        value = toNumber(point.y ?? point.value ?? point.count ?? point.total ?? point.downloads);
      }
      if (date && value != null) rows.push({ date, value });
    }
    addCandidate(rows, kind, name, 35);
  };

  const considerLabelsAndSeries = (object, context) => {
    if (!object || typeof object !== 'object' || Array.isArray(object)) return;
    const entries = Object.entries(object);
    const labelsEntry = entries.find(([key, value]) => /labels|categories|dates|buckets|timestamps/i.test(key) && Array.isArray(value) && value.length >= 2);
    if (!labelsEntry) return;
    const labels = labelsEntry[1].map(toDate);
    if (labels.filter(Boolean).length < 2) return;
    const dataEntries = entries.filter(([key, value]) => /series|datasets|lines|data/i.test(key) && Array.isArray(value));
    for (const [, datasets] of dataEntries) {
      for (const dataset of datasets) {
        if (!dataset || typeof dataset !== 'object') continue;
        const name = contextName(dataset, context);
        const values = Array.isArray(dataset.data) ? dataset.data : Array.isArray(dataset.values) ? dataset.values : null;
        if (!values || values.length !== labels.length) continue;
        const kind = /unique/i.test(name) ? 'unique' : /download|total/i.test(name) && !/unique/i.test(name) ? 'total' : null;
        if (!kind) continue;
        addCandidate(labels.map((date, index) => ({ date, value: toNumber(values[index]?.value ?? values[index]?.y ?? values[index]) })), kind, name, 40);
      }
    }
  };

  const considerDateMap = (object, context) => {
    if (!object || typeof object !== 'object' || Array.isArray(object) || !/download|unique|total/i.test(context)) return;
    const entries = Object.entries(object);
    if (entries.length < 2) return;
    const rows = [];
    for (const [key, raw] of entries) {
      const date = toDate(key);
      if (!date) continue;
      const value = toNumber(raw?.value ?? raw?.count ?? raw?.total ?? raw?.downloads ?? raw);
      if (value != null) rows.push({ date, value });
    }
    if (rows.length < 2) return;
    addCandidate(rows, /unique/i.test(context) ? 'unique' : 'total', context, 20);
  };

  const seenObjects = new WeakSet();
  const visit = (value, path = '', depth = 0) => {
    if (depth > 16 || value == null || typeof value === 'function') return;
    if (typeof value === 'object') {
      if (seenObjects.has(value)) return;
      seenObjects.add(value);
    }
    if (Array.isArray(value)) {
      considerObjectRows(value, path);
      considerColumns(value, path);
      value.forEach((child, index) => visit(child, `${path}[${index}]`, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;
    const context = contextName(value, path);
    considerParallelArrays(value, context);
    considerLabelsAndSeries(value, context);
    considerDateMap(value, context);
    for (const [key, child] of Object.entries(value)) {
      if (/series|datasets|data|values|points/i.test(key) && Array.isArray(child)) {
        for (const dataset of child) considerDataset(dataset, `${context}.${key}`);
      }
      visit(child, path ? `${path}.${key}` : key, depth + 1);
    }
  };

  const inspectReactChartProps = () => {
    const labels = Array.from(document.querySelectorAll('body *')).filter((element) => /^downloads over time$/i.test(norm(element.textContent)));
    const roots = [];
    for (const label of labels) {
      let node = label;
      for (let depth = 0; depth < 8 && node; depth++, node = node.parentElement) {
        if (node.querySelector?.('svg,canvas')) { roots.push(node); break; }
      }
    }
    if (!roots.length) roots.push(document.body);
    let inspected = 0;
    for (const root of roots.slice(0, 3)) {
      const elements = [root, ...Array.from(root.querySelectorAll('*')).slice(0, 1500)];
      for (const element of elements) {
        for (const key of Object.getOwnPropertyNames(element)) {
          if (!key.startsWith('__reactProps$')) continue;
          try {
            visit(element[key], `react.${element.tagName?.toLowerCase?.() || 'node'}`, 0);
            inspected++;
          } catch (_) {}
        }
      }
    }
    return inspected;
  };

  const fitYAxis = (svg, plotBox) => {
    const ticks = Array.from(svg.querySelectorAll('text')).map((element) => {
      const value = toNumber(norm(element.textContent));
      if (value == null) return null;
      try {
        const box = element.getBBox();
        const y = box.y + box.height / 2;
        if (box.x > plotBox.x + plotBox.width * 0.2) return null;
        return { y, value };
      } catch (_) { return null; }
    }).filter(Boolean);
    const unique = [];
    for (const tick of ticks) {
      if (!unique.some((item) => Math.abs(item.y - tick.y) < 1 && item.value === tick.value)) unique.push(tick);
    }
    if (unique.length < 2) return null;
    const n = unique.length;
    const meanY = unique.reduce((sum, tick) => sum + tick.y, 0) / n;
    const meanV = unique.reduce((sum, tick) => sum + tick.value, 0) / n;
    let covariance = 0;
    let variance = 0;
    for (const tick of unique) {
      covariance += (tick.y - meanY) * (tick.value - meanV);
      variance += (tick.y - meanY) ** 2;
    }
    if (variance <= 0) return null;
    const slope = covariance / variance;
    const intercept = meanV - slope * meanY;
    return Number.isFinite(slope) && slope < 0 ? (y) => Math.max(0, slope * y + intercept) : null;
  };

  const extractSvgSeries = (expectedTotal) => {
    const labels = Array.from(document.querySelectorAll('body *')).filter((element) => /^downloads over time$/i.test(norm(element.textContent)));
    const svgs = [];
    for (const label of labels) {
      let node = label;
      for (let depth = 0; depth < 8 && node; depth++, node = node.parentElement) {
        const found = Array.from(node.querySelectorAll?.('svg') || []);
        if (found.length) { svgs.push(...found); break; }
      }
    }
    if (!svgs.length) svgs.push(...Array.from(document.querySelectorAll('svg')));

    let best = null;
    for (const svg of svgs) {
      for (const path of Array.from(svg.querySelectorAll('path[d]'))) {
        try {
          const length = path.getTotalLength();
          const box = path.getBBox();
          const style = getComputedStyle(path);
          if (!Number.isFinite(length) || length < 80 || box.width < 120 || box.height < 2) continue;
          if (!style.stroke || style.stroke === 'none' || style.stroke === 'rgba(0, 0, 0, 0)') continue;
          const sample = [];
          for (let i = 0; i <= 40; i++) sample.push(path.getPointAtLength((length * i) / 40));
          const averageY = sample.reduce((sum, point) => sum + point.y, 0) / sample.length;
          const score = box.width * 3 + Math.min(length, 2000) - averageY * 0.05;
          if (!best || score > best.score) best = { svg, path, length, box, score };
        } catch (_) {}
      }
    }
    if (!best) return [];

    const yToValue = fitYAxis(best.svg, best.box);
    const buckets = Array.from({ length: periodDays }, () => []);
    for (let i = 0; i <= 800; i++) {
      try {
        const point = best.path.getPointAtLength((best.length * i) / 800);
        const ratio = (point.x - best.box.x) / Math.max(best.box.width, 1);
        const index = Math.max(0, Math.min(periodDays - 1, Math.round(ratio * (periodDays - 1))));
        buckets[index].push(point.y);
      } catch (_) {}
    }
    let values = buckets.map((ys) => {
      if (!ys.length) return null;
      const y = ys.reduce((sum, value) => sum + value, 0) / ys.length;
      return yToValue ? yToValue(y) : Math.max(0, best.box.y + best.box.height - y);
    });

    for (let i = 0; i < values.length; i++) {
      if (values[i] != null) continue;
      let left = i - 1;
      while (left >= 0 && values[left] == null) left--;
      let right = i + 1;
      while (right < values.length && values[right] == null) right++;
      if (left >= 0 && right < values.length) values[i] = values[left] + ((values[right] - values[left]) * (i - left)) / (right - left);
      else if (left >= 0) values[i] = values[left];
      else if (right < values.length) values[i] = values[right];
      else values[i] = 0;
    }

    const sum = values.reduce((total, value) => total + Math.max(0, value || 0), 0);
    if (Number.isFinite(expectedTotal) && expectedTotal >= 0 && sum > 0) {
      const ratio = expectedTotal / sum;
      const shouldNormalize = !yToValue || ratio < 0.7 || ratio > 1.3;
      if (shouldNormalize) values = values.map((value) => value * ratio);
    }

    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (periodDays - 1));
    return values.map((value, index) => ({
      date: new Date(start.getTime() + index * DAY).toISOString(),
      total: Math.max(0, value || 0),
      unique: null,
    }));
  };

  const bestCandidate = (candidates) => candidates.sort((a, b) => b.score - a.score)[0] || null;
  const mergeSeries = (totalRows, uniqueRows) => {
    const map = new Map();
    for (const row of totalRows || []) {
      const key = row.date.slice(0, 10);
      const old = map.get(key) || { date: row.date, total: null, unique: null };
      old.total = row.value;
      map.set(key, old);
    }
    for (const row of uniqueRows || []) {
      const key = row.date.slice(0, 10);
      const old = map.get(key) || { date: row.date, total: null, unique: null };
      old.unique = row.value;
      map.set(key, old);
    }
    return Array.from(map.values()).sort((a, b) => new Date(a.date) - new Date(b.date));
  };

  const run = async () => {
    for (let attempt = 0; attempt < 24; attempt++) {
      if (loggedOut()) {
        window.__FODRINTH_CF_DOWNLOAD_V2_RESULT__ = { needsLogin: true, current: null, previous: null, allTime: null, uniqueCurrent: null, uniquePrevious: null, series: [], projects: [] };
        return;
      }
      if (norm(document.body?.innerText).length > 80) break;
      await sleep(250);
    }

    if (Array.isArray(window.__FODRINTH_CF_CAPTURES__)) window.__FODRINTH_CF_CAPTURES__.length = 0;
    await openDownloads();
    if (loggedOut()) {
      window.__FODRINTH_CF_DOWNLOAD_V2_RESULT__ = { needsLogin: true, current: null, previous: null, allTime: null, uniqueCurrent: null, uniquePrevious: null, series: [], projects: [] };
      return;
    }
    await selectPeriod();

    let lastCaptureCount = -1;
    let stablePasses = 0;
    for (let attempt = 0; attempt < 28; attempt++) {
      await sleep(350);
      const count = (window.__FODRINTH_CF_CAPTURES__ || []).length;
      if (count === lastCaptureCount) stablePasses++;
      else stablePasses = 0;
      lastCaptureCount = count;
      if (stablePasses >= 5 && attempt >= 8) break;
    }

    const captured = captures();
    for (const capture of captured) visit(capture.value, capture.url, 0);
    const reactPropsInspected = inspectReactChartProps();

    const yesterdayCard = kpiMetric([/^yesterday(?:\s+vs\.?\s+same day last week)?$/i, /^yesterday$/i]);
    const sevenCard = kpiMetric([/^last 7 days$/i]);
    const thirtyCard = kpiMetric([/^last 30 days$/i]);
    const allTimeCard = kpiMetric([/^total project downloads$/i, /^all[- ]time downloads$/i, /^total downloads$/i]);
    const uniqueCard = kpiMetric([/^unique downloads$/i, /^total unique downloads$/i]);
    const periodCard = periodDays === 7 ? sevenCard : periodDays === 30 ? thirtyCard : null;

    const total = bestCandidate(totalCandidates);
    const unique = bestCandidate(uniqueCandidates);
    let series = mergeSeries(total?.rows, unique?.rows);
    if (!series.some((row) => Number.isFinite(row.total))) {
      series = extractSvgSeries(periodCard?.value ?? null);
    }

    const now = Date.now();
    const currentStart = now - periodDays * DAY;
    const previousStart = now - periodDays * 2 * DAY;
    const sumRange = (field, start, end) => series.reduce((sum, row) => {
      const time = new Date(row.date).getTime();
      const value = row[field];
      return Number.isFinite(time) && time >= start && time < end && Number.isFinite(value) ? sum + value : sum;
    }, 0);
    const countRange = (field, start, end) => series.filter((row) => {
      const time = new Date(row.date).getTime();
      return Number.isFinite(time) && time >= start && time < end && Number.isFinite(row[field]);
    }).length;

    const enoughCurrentSeries = countRange('total', currentStart - DAY, now + DAY) >= Math.min(periodDays, 5);
    const enoughPreviousSeries = countRange('total', previousStart, currentStart) >= Math.min(periodDays, 5);
    const enoughUniqueSeries = countRange('unique', currentStart - DAY, now + DAY) >= Math.min(periodDays, 5);

    const current = periodCard?.value ?? (enoughCurrentSeries ? sumRange('total', currentStart - DAY, now + DAY) : null);
    let previous = enoughPreviousSeries ? sumRange('total', previousStart, currentStart) : null;
    if (previous == null && current != null && Number.isFinite(periodCard?.percent) && Math.abs(100 + periodCard.percent) > 0.0001) {
      previous = current / (1 + periodCard.percent / 100);
    }
    const uniqueCurrent = uniqueCard?.value ?? (enoughUniqueSeries ? sumRange('unique', currentStart - DAY, now + DAY) : null);
    const uniquePrevious = countRange('unique', previousStart, currentStart) >= Math.min(periodDays, 5)
      ? sumRange('unique', previousStart, currentStart)
      : null;

    const debug = {
      capturesSeen: captured.length,
      reactPropsInspected,
      totalSeriesSource: total?.context ?? (series.length ? 'rendered-svg-fallback' : null),
      uniqueSeriesSource: unique?.context ?? null,
      totalSeriesCandidates: totalCandidates.length,
      uniqueSeriesCandidates: uniqueCandidates.length,
      seriesPoints: series.length,
      kpi: {
        yesterday: yesterdayCard?.value ?? null,
        seven: sevenCard?.value ?? null,
        thirty: thirtyCard?.value ?? null,
        allTime: allTimeCard?.value ?? null,
        unique: uniqueCard?.value ?? null,
      },
      captureUrls: Array.from(new Set(captured.map((capture) => capture.url))).slice(0, 24),
    };

    window.__FODRINTH_CF_DOWNLOAD_V2_RESULT__ = {
      needsLogin: false,
      current,
      previous,
      allTime: allTimeCard?.value ?? null,
      uniqueCurrent,
      uniquePrevious,
      yesterday: yesterdayCard?.value ?? null,
      yesterdayChangePercent: Number.isFinite(yesterdayCard?.percent) ? yesterdayCard.percent : null,
      series,
      projects: [],
      debug,
    };
  };

  run().catch((error) => {
    window.__FODRINTH_CF_DOWNLOAD_V2_RESULT__ = {
      needsLogin: false,
      current: null,
      previous: null,
      allTime: null,
      uniqueCurrent: null,
      uniquePrevious: null,
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
    while started.elapsed() < Duration::from_secs(45) {
        let value = eval_json(
            window,
            "JSON.stringify(window.__FODRINTH_CF_DOWNLOAD_V2_RESULT__ ?? null)".to_string(),
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

    let script = DOWNLOAD_SCRAPER.replace("__PERIOD_DAYS__", &period_days.to_string());
    window
        .eval(script)
        .map_err(|error| format!("Could not start CurseForge download analytics reader: {error}"))?;
    poll_result(&window).await
}
