(() => {
  window.__FODRINTH_CF_DOWNLOAD_V3_RESULT__ = null;

  const periodDays = Math.max(1, Number('__PERIOD_DAYS__') || 30);
  const DAY = 86400000;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

  const toNumber = (value) => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value == null) return null;
    if (typeof value === 'object') {
      return toNumber(value.value ?? value.count ?? value.total ?? value.downloads ?? value.downloadCount ?? value.y);
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
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
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

  const dayKey = (value) => {
    const date = toDate(value);
    if (!date) return null;
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };

  const loggedOut = () => {
    const body = norm(document.body?.innerText);
    return /sign in|log in|continue with google/i.test(body) && !/statistics|downloads|dashboard|projects/i.test(body);
  };

  const clickExact = async (label, root = document) => {
    const candidates = Array.from(root.querySelectorAll('a[href],button,[role="button"],[role="tab"],[role="option"],[role="menuitem"]'));
    const target = candidates.find((element) => norm(element.textContent).toLowerCase() === label.toLowerCase());
    if (!target) return false;
    target.click();
    await sleep(700);
    return true;
  };

  const openDownloads = async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const body = norm(document.body?.innerText);
      if (/total project downloads/i.test(body) && /downloads over time/i.test(body)) return true;
      if (loggedOut()) return false;
      if (attempt === 1) await clickExact('Statistics');
      if (attempt >= 1) await clickExact('Downloads');
      await sleep(450);
    }
    return /downloads over time/i.test(norm(document.body?.innerText));
  };

  const findChartSection = (preferPerProject = true) => {
    const headings = Array.from(document.querySelectorAll('body *')).filter((element) => {
      if (element.children.length > 3) return false;
      return /downloads over time/i.test(norm(element.textContent));
    });
    headings.sort((a, b) => {
      const aText = norm(a.textContent);
      const bText = norm(b.textContent);
      const aScore = preferPerProject && /per project/i.test(aText) ? 100 : 0;
      const bScore = preferPerProject && /per project/i.test(bText) ? 100 : 0;
      return bScore - aScore;
    });
    for (const heading of headings) {
      let node = heading;
      for (let depth = 0; depth < 10 && node; depth++, node = node.parentElement) {
        if (node.querySelector?.('svg,canvas') && node.querySelector?.('select,button,[role="button"]')) return node;
      }
    }
    return null;
  };

  const periodAliases = () => periodDays === 7
    ? ['last 7 days', '7 days', '7d']
    : periodDays === 30
      ? ['last 30 days', '30 days', '30d']
      : periodDays === 90
        ? ['last 90 days', '90 days', '90d', 'last 3 months', '3 months']
        : [`last ${periodDays} days`, `${periodDays} days`, `${periodDays}d`];

  const selectPeriodIn = async (root) => {
    if (!root) return false;
    const aliases = periodAliases();
    const selects = Array.from(root.querySelectorAll('select'));
    for (const select of selects) {
      const option = Array.from(select.options || []).find((item) => aliases.includes(norm(item.textContent).toLowerCase()));
      if (!option) continue;
      if (select.value !== option.value) {
        select.value = option.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(1600);
      }
      return true;
    }

    let controls = Array.from(root.querySelectorAll('button,[role="button"],[role="option"],[role="menuitem"]'));
    const direct = controls.find((element) => aliases.includes(norm(element.textContent).toLowerCase()));
    if (direct) {
      direct.click();
      await sleep(1600);
      return true;
    }

    const picker = controls.find((element) => /last \d+ days|\b\d+ days\b|\b\d+d\b|months?/i.test(norm(element.textContent)));
    if (!picker) return false;
    picker.click();
    await sleep(250);
    controls = Array.from(document.querySelectorAll('[role="option"],[role="menuitem"],button'));
    const option = controls.find((element) => aliases.includes(norm(element.textContent).toLowerCase()));
    if (!option) return false;
    option.click();
    await sleep(1600);
    return true;
  };

  const selectPeriod = async () => {
    const section = findChartSection(true) ?? findChartSection(false);
    if (await selectPeriodIn(section)) return;
    await selectPeriodIn(document.body);
  };

  const selectTotal = async () => {
    const section = findChartSection(true);
    if (!section) return;
    const buttons = Array.from(section.querySelectorAll('button,[role="button"],[role="tab"]'));
    const total = buttons.find((element) => /^total$/i.test(norm(element.textContent)));
    if (!total) return;
    const selected = total.getAttribute('aria-selected') === 'true' || total.getAttribute('aria-pressed') === 'true' || /active|selected/i.test(total.className || '');
    if (!selected) {
      total.click();
      await sleep(1200);
    }
  };

  const leafElements = (root) => Array.from(root.querySelectorAll('*')).filter((element) => element.children.length === 0);
  const kpiMetric = (labels) => {
    const labelNodes = Array.from(document.querySelectorAll('body *')).filter((element) => {
      const text = norm(element.textContent);
      return text && text.length < 100 && labels.some((pattern) => pattern.test(text));
    });
    let best = null;
    for (const labelNode of labelNodes) {
      let node = labelNode;
      for (let depth = 0; depth < 6 && node; depth++, node = node.parentElement) {
        const rect = node.getBoundingClientRect?.();
        if (!rect || rect.width < 80 || rect.width > 820 || rect.height < 40 || rect.height > 380) continue;
        const text = norm(node.innerText || node.textContent);
        if (text.length > 500) continue;
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
        const score = valueLeaf.fontSize * 10 - depth;
        if (!best || score > best.score) best = { value: valueLeaf.value, percent, score };
      }
    }
    return best;
  };

  const captures = () => (window.__FODRINTH_CF_CAPTURES__ || [])
    .map((entry) => {
      try { return { url: String(entry?.url || ''), value: JSON.parse(entry?.text || '') }; }
      catch (_) { return null; }
    })
    .filter(Boolean);

  const flatten = (value, prefix = '', depth = 0, out = []) => {
    if (depth > 7 || value == null || typeof value === 'function') return out;
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
      ? [/unique.*download|download.*unique/i, /(^|\.)(unique|uniqueDownloads|unique_downloads)$/i]
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
    const grouped = new Map();
    for (const row of rows ?? []) {
      const key = dayKey(row?.date);
      const value = toNumber(row?.value);
      if (!key || value == null) continue;
      const old = grouped.get(key) ?? 0;
      grouped.set(key, old + value);
    }
    const normalized = Array.from(grouped, ([key, value]) => ({
      date: new Date(`${key}T12:00:00`).toISOString(),
      value,
    })).sort((a, b) => new Date(a.date) - new Date(b.date));
    if (normalized.length < 2) return;
    const recent = normalized.filter((row) => Math.abs(Date.now() - new Date(row.date).getTime()) <= periodDays * 4 * DAY).length;
    let score = normalized.length * 12 + recent * 8 + bonus;
    if (/download/i.test(context)) score += 100;
    if (/chart|trend|history|time|daily|stat/i.test(context)) score += 40;
    if (/project/i.test(context)) score += 20;
    if (kind === 'unique' && /unique/i.test(context)) score += 60;
    if (kind === 'total' && /total|download/i.test(context) && !/unique/i.test(context)) score += 40;
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
    addCandidate(totalRows, 'total', context, 20);
    addCandidate(uniqueRows, 'unique', context, 20);
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
      addCandidate(dates.map((date, index) => ({ date, value: toNumber(values[index]) })), kind, named, 60);
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
    addCandidate(rows, kind, name, 45);
  };

  const considerDateMap = (object, context) => {
    if (!object || typeof object !== 'object' || Array.isArray(object) || !/download|unique|total/i.test(context)) return;
    const rows = [];
    for (const [key, raw] of Object.entries(object)) {
      const date = toDate(key);
      if (!date) continue;
      const value = toNumber(raw?.value ?? raw?.count ?? raw?.total ?? raw?.downloads ?? raw);
      if (value != null) rows.push({ date, value });
    }
    if (rows.length >= 2) addCandidate(rows, /unique/i.test(context) ? 'unique' : 'total', context, 25);
  };

  const seenObjects = new WeakSet();
  const visit = (value, path = '', depth = 0) => {
    if (depth > 17 || value == null || typeof value === 'function') return;
    if (typeof value === 'object') {
      if (seenObjects.has(value)) return;
      seenObjects.add(value);
    }
    if (Array.isArray(value)) {
      considerObjectRows(value, path);
      value.forEach((child, index) => visit(child, `${path}[${index}]`, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;
    const context = contextName(value, path);
    considerParallelArrays(value, context);
    considerDateMap(value, context);
    for (const [key, child] of Object.entries(value)) {
      if (/series|datasets|data|values|points/i.test(key) && Array.isArray(child)) {
        for (const dataset of child) considerDataset(dataset, `${context}.${key}`);
      }
      visit(child, path ? `${path}.${key}` : key, depth + 1);
    }
  };

  const inspectReactChartProps = () => {
    const section = findChartSection(true) ?? findChartSection(false);
    const roots = section ? [section] : [document.body];
    let inspected = 0;
    for (const root of roots) {
      const elements = [root, ...Array.from(root.querySelectorAll('*')).slice(0, 2400)];
      for (const element of elements) {
        for (const key of Object.getOwnPropertyNames(element)) {
          if (!key.startsWith('__reactProps$') && !key.startsWith('__reactFiber$')) continue;
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
        if (box.x > plotBox.x + Math.max(30, plotBox.width * 0.08)) return null;
        return { y, value };
      } catch (_) { return null; }
    }).filter(Boolean);
    const unique = [];
    for (const tick of ticks) {
      if (!unique.some((item) => Math.abs(item.y - tick.y) < 1.5 && item.value === tick.value)) unique.push(tick);
    }
    if (unique.length < 2) return null;
    const meanY = unique.reduce((sum, tick) => sum + tick.y, 0) / unique.length;
    const meanV = unique.reduce((sum, tick) => sum + tick.value, 0) / unique.length;
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

  const geometryInfo = (element) => {
    try {
      const length = element.getTotalLength?.();
      const box = element.getBBox?.();
      const style = getComputedStyle(element);
      if (!Number.isFinite(length) || !box || length < 45 || box.width < 70 || box.height < 1) return null;
      if (!style.stroke || style.stroke === 'none' || style.stroke === 'rgba(0, 0, 0, 0)' || style.stroke === 'transparent') return null;
      const opacity = Number.parseFloat(style.opacity || style.strokeOpacity || '1');
      if (Number.isFinite(opacity) && opacity <= 0.05) return null;
      return { element, length, box, style };
    } catch (_) {
      return null;
    }
  };

  const sampleGeometry = (info, plotBox, yToValue) => {
    const buckets = Array.from({ length: periodDays }, () => []);
    const steps = Math.max(800, periodDays * 16);
    for (let i = 0; i <= steps; i++) {
      try {
        const point = info.element.getPointAtLength((info.length * i) / steps);
        const ratio = (point.x - plotBox.x) / Math.max(plotBox.width, 1);
        if (ratio < -0.02 || ratio > 1.02) continue;
        const index = Math.max(0, Math.min(periodDays - 1, Math.round(ratio * (periodDays - 1))));
        buckets[index].push(point.y);
      } catch (_) {}
    }
    const values = buckets.map((ys) => {
      if (!ys.length) return null;
      const y = ys.reduce((sum, value) => sum + value, 0) / ys.length;
      return yToValue ? yToValue(y) : Math.max(0, plotBox.y + plotBox.height - y);
    });
    for (let i = 0; i < values.length; i++) {
      if (values[i] != null) continue;
      let left = i - 1;
      while (left >= 0 && values[left] == null) left--;
      let right = i + 1;
      while (right < values.length && values[right] == null) right++;
      if (left >= 0 && right < values.length) {
        values[i] = values[left] + ((values[right] - values[left]) * (i - left)) / (right - left);
      } else {
        values[i] = 0;
      }
    }
    return values.map((value) => Math.max(0, value || 0));
  };

  let renderedDebug = null;
  const extractRenderedSeries = (expectedTotal) => {
    const section = findChartSection(true) ?? findChartSection(false);
    const scope = section ?? document.body;
    const svgs = Array.from(scope.querySelectorAll('svg'));
    let best = null;

    for (const svg of svgs) {
      const geometries = Array.from(svg.querySelectorAll('path[d],polyline[points]')).map(geometryInfo).filter(Boolean);
      if (!geometries.length) continue;
      const maxWidth = Math.max(...geometries.map((item) => item.box.width));
      const lines = geometries.filter((item) => item.box.width >= Math.max(70, maxWidth * 0.18));
      if (!lines.length) continue;
      const minX = Math.min(...lines.map((item) => item.box.x));
      const maxX = Math.max(...lines.map((item) => item.box.x + item.box.width));
      const minY = Math.min(...lines.map((item) => item.box.y));
      const maxY = Math.max(...lines.map((item) => item.box.y + item.box.height));
      const plotBox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
      const score = plotBox.width * 3 + lines.length * 250 + plotBox.height;
      if (!best || score > best.score) best = { svg, lines, plotBox, score };
    }

    if (!best) {
      renderedDebug = { found: false, section: section ? norm(section.innerText).slice(0, 160) : null, svgCount: svgs.length };
      return [];
    }

    const yToValue = fitYAxis(best.svg, best.plotBox);
    const seriesValues = best.lines.map((line) => sampleGeometry(line, best.plotBox, yToValue));
    let values = Array.from({ length: periodDays }, (_, index) =>
      seriesValues.reduce((sum, line) => sum + (line[index] ?? 0), 0),
    );

    let sum = values.reduce((total, value) => total + Math.max(0, value || 0), 0);
    if (Number.isFinite(expectedTotal) && expectedTotal >= 0 && sum > 0) {
      const ratio = expectedTotal / sum;
      values = values.map((value) => value * ratio);
      sum = expectedTotal;
    }

    const start = new Date();
    start.setHours(12, 0, 0, 0);
    start.setDate(start.getDate() - (periodDays - 1));
    renderedDebug = {
      found: true,
      svgCount: svgs.length,
      lineCount: best.lines.length,
      yAxisRead: !!yToValue,
      normalizedTotal: sum,
      heading: section ? norm(section.innerText).slice(0, 180) : null,
    };
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
      const key = dayKey(row.date);
      if (!key) continue;
      const old = map.get(key) || { date: row.date, total: null, unique: null };
      old.total = row.value;
      map.set(key, old);
    }
    for (const row of uniqueRows || []) {
      const key = dayKey(row.date);
      if (!key) continue;
      const old = map.get(key) || { date: row.date, total: null, unique: null };
      old.unique = row.value;
      map.set(key, old);
    }
    return Array.from(map.values()).sort((a, b) => new Date(a.date) - new Date(b.date));
  };

  const run = async () => {
    for (let attempt = 0; attempt < 28; attempt++) {
      if (loggedOut()) {
        window.__FODRINTH_CF_DOWNLOAD_V3_RESULT__ = { needsLogin: true, current: null, previous: null, allTime: null, uniqueCurrent: null, uniquePrevious: null, series: [], projects: [] };
        return;
      }
      if (norm(document.body?.innerText).length > 80) break;
      await sleep(250);
    }

    await openDownloads();
    if (loggedOut()) {
      window.__FODRINTH_CF_DOWNLOAD_V3_RESULT__ = { needsLogin: true, current: null, previous: null, allTime: null, uniqueCurrent: null, uniquePrevious: null, series: [], projects: [] };
      return;
    }

    if (Array.isArray(window.__FODRINTH_CF_CAPTURES__)) window.__FODRINTH_CF_CAPTURES__.length = 0;
    await selectPeriod();
    await selectTotal();

    let lastCaptureCount = -1;
    let stablePasses = 0;
    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(300);
      const count = (window.__FODRINTH_CF_CAPTURES__ || []).length;
      if (count === lastCaptureCount) stablePasses++;
      else stablePasses = 0;
      lastCaptureCount = count;
      if (stablePasses >= 5 && attempt >= 8) break;
    }

    const yesterdayCard = kpiMetric([/^yesterday(?:\s+vs\.?\s+same day last week)?$/i, /^yesterday$/i]);
    const sevenCard = kpiMetric([/^last 7 days$/i]);
    const thirtyCard = kpiMetric([/^last 30 days$/i]);
    const allTimeCard = kpiMetric([/^total project downloads$/i, /^all[- ]time downloads$/i, /^total downloads$/i]);
    const uniqueCard = kpiMetric([/^unique downloads$/i, /^total unique downloads$/i]);
    const periodCard = periodDays === 7 ? sevenCard : periodDays === 30 ? thirtyCard : null;

    const captured = captures();
    for (const capture of captured) visit(capture.value, capture.url, 0);
    const reactPropsInspected = inspectReactChartProps();

    const total = bestCandidate(totalCandidates);
    const unique = bestCandidate(uniqueCandidates);
    let series = mergeSeries(total?.rows, unique?.rows);

    const currentStart = Date.now() - periodDays * DAY;
    const currentSeriesPoints = series.filter((row) => {
      const time = new Date(row.date).getTime();
      return Number.isFinite(time) && time >= currentStart - DAY && Number.isFinite(row.total);
    }).length;
    if (currentSeriesPoints < Math.min(periodDays, 5)) {
      const rendered = extractRenderedSeries(periodCard?.value ?? null);
      if (rendered.length) series = rendered;
    }

    const now = Date.now();
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
      totalSeriesSource: total?.context ?? (renderedDebug?.found ? 'rendered-per-project-chart' : null),
      uniqueSeriesSource: unique?.context ?? null,
      totalSeriesCandidates: totalCandidates.length,
      uniqueSeriesCandidates: uniqueCandidates.length,
      seriesPoints: series.length,
      rendered: renderedDebug,
      kpi: {
        yesterday: yesterdayCard?.value ?? null,
        seven: sevenCard?.value ?? null,
        thirty: thirtyCard?.value ?? null,
        allTime: allTimeCard?.value ?? null,
        unique: uniqueCard?.value ?? null,
      },
      captureUrls: Array.from(new Set(captured.map((capture) => capture.url))).slice(0, 32),
    };

    window.__FODRINTH_CF_DOWNLOAD_V3_RESULT__ = {
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
    window.__FODRINTH_CF_DOWNLOAD_V3_RESULT__ = {
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
