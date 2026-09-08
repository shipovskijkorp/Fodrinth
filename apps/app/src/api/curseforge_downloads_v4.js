(() => {
  window.__FODRINTH_CF_DOWNLOAD_V4_RESULT__ = null;
  window.__FODRINTH_CF_DOWNLOAD_STAGE__ = 'boot';

  const periodDays = Math.max(1, Math.min(365, Number('__PERIOD_DAYS__') || 30));
  const DAY = 86400000;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const setStage = (value) => { window.__FODRINTH_CF_DOWNLOAD_STAGE__ = value; };

  const toNumber = (value) => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value == null) return null;
    if (typeof value === 'object') {
      return toNumber(
        value.value ?? value.count ?? value.total ?? value.downloads ?? value.downloadCount ??
        value.download_count ?? value.totalDownloads ?? value.total_downloads ?? value.y,
      );
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
    const parsed = Number(text.replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
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

  const startDate = new Date();
  startDate.setHours(0, 0, 0, 0);
  startDate.setDate(startDate.getDate() - (periodDays - 1));
  const rangeStart = startDate.getTime();
  const rangeEnd = Date.now() + DAY;

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

  const clearCaptures = () => {
    if (Array.isArray(window.__FODRINTH_CF_CAPTURES__)) window.__FODRINTH_CF_CAPTURES__.length = 0;
    else window.__FODRINTH_CF_CAPTURES__ = [];
  };

  const captures = () => (window.__FODRINTH_CF_CAPTURES__ || [])
    .map((entry) => {
      try {
        return {
          url: String(entry?.url || ''),
          at: Number(entry?.at) || 0,
          value: JSON.parse(entry?.text || ''),
        };
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);

  const openDownloads = async () => {
    for (let attempt = 0; attempt < 28; attempt++) {
      const body = norm(document.body?.innerText);
      if (/downloads over time/i.test(body) && /total project downloads|last 30 days|last 7 days/i.test(body)) return true;
      if (loggedOut()) return false;
      if (attempt === 1) await clickExact('Statistics');
      if (attempt >= 1) await clickExact('Downloads');
      await sleep(500);
    }
    return /downloads over time/i.test(norm(document.body?.innerText));
  };

  const findChartSections = () => Array.from(document.querySelectorAll('body *'))
    .filter((element) => element.children.length <= 4 && /downloads over time/i.test(norm(element.textContent)))
    .map((heading) => {
      let node = heading;
      for (let depth = 0; depth < 10 && node; depth++, node = node.parentElement) {
        if (node.querySelector?.('svg,canvas') && node.querySelector?.('select,button,[role="button"]')) return node;
      }
      return null;
    })
    .filter(Boolean)
    .filter((section, index, sections) => sections.indexOf(section) === index);

  const findChartSection = (perProject) => {
    const sections = findChartSections();
    const preferred = sections.find((section) => /per project/i.test(norm(section.innerText || section.textContent)) === perProject);
    return preferred ?? sections[0] ?? null;
  };

  const wakeCharts = async () => {
    for (const section of findChartSections()) {
      try { section.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}
      window.dispatchEvent(new Event('resize'));
      await sleep(450);
    }
    try { window.scrollTo(0, 0); } catch (_) {}
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
      }
      await sleep(periodDays === 90 ? 2800 : 1400);
      return true;
    }

    let controls = Array.from(root.querySelectorAll('button,[role="button"],[role="option"],[role="menuitem"]'));
    const direct = controls.find((element) => aliases.includes(norm(element.textContent).toLowerCase()));
    if (direct) {
      direct.click();
      await sleep(periodDays === 90 ? 2800 : 1400);
      return true;
    }

    const picker = controls.find((element) => /last \d+ days|\b\d+ days\b|\b\d+d\b|months?/i.test(norm(element.textContent)));
    if (!picker) return false;
    picker.click();
    await sleep(300);
    controls = Array.from(document.querySelectorAll('[role="option"],[role="menuitem"],button'));
    const option = controls.find((element) => aliases.includes(norm(element.textContent).toLowerCase()));
    if (!option) return false;
    option.click();
    await sleep(periodDays === 90 ? 2800 : 1400);
    return true;
  };

  const selectPeriod = async () => {
    const perProject = findChartSection(true);
    if (await selectPeriodIn(perProject)) return true;
    const allProjects = findChartSection(false);
    if (await selectPeriodIn(allProjects)) return true;
    return await selectPeriodIn(document.body);
  };

  const selectTotal = async () => {
    const section = findChartSection(true);
    if (!section) return false;
    const buttons = Array.from(section.querySelectorAll('button,[role="button"],[role="tab"]'));
    const total = buttons.find((element) => /^total$/i.test(norm(element.textContent)));
    if (!total) return false;
    const selected = total.getAttribute('aria-selected') === 'true' || total.getAttribute('aria-pressed') === 'true' || /active|selected/i.test(total.className || '');
    if (!selected) {
      total.click();
      await sleep(1400);
    }
    return true;
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
        let rect;
        try { rect = node.getBoundingClientRect(); } catch (_) { continue; }
        if (!rect || rect.width < 80 || rect.width > 900 || rect.height < 35 || rect.height > 400) continue;
        const text = norm(node.innerText || node.textContent);
        if (text.length > 600) continue;
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

  const genericSeriesName = /^(?:total|unique|downloads?|total downloads|unique downloads|all projects|minecraft|minecraft java|data|series)$/i;
  const explicitProjectMeta = (value, inherited = {}, context = '') => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return inherited;
    const project = value.project && typeof value.project === 'object' ? value.project : null;
    let id = norm(
      value.projectId ?? value.project_id ?? value.sourceProject ?? value.source_project ??
      project?.id ?? project?.projectId ?? inherited.id ?? '',
    );
    let name = norm(
      value.projectName ?? value.project_name ?? project?.name ?? project?.title ??
      inherited.name ?? '',
    );
    const pointArray = Array.isArray(value.data) ? value.data
      : Array.isArray(value.values) ? value.values
        : Array.isArray(value.points) ? value.points
          : null;
    const label = norm(value.seriesName ?? value.label ?? value.name ?? value.title ?? '');
    if (!name && pointArray && label && !genericSeriesName.test(label) && !/unique/i.test(label)) name = label;
    if (!id && name) id = name;
    if (!id && !name && /per.?project|project.*download/i.test(context)) {
      const candidateName = norm(value.name ?? value.title ?? value.label ?? '');
      if (candidateName && !genericSeriesName.test(candidateName)) {
        name = candidateName;
        id = candidateName;
      }
    }
    return { id, name };
  };

  const projectDays = new Map();
  const projectNames = new Map();
  const aggregateDays = new Map();
  const projectPeriodCandidates = new Map();

  const rememberProjectPoint = (project, dateValue, amountValue, context) => {
    if (!project?.id || /unique|file|loader|version/i.test(context || '')) return;
    const day = dayKey(dateValue);
    const amount = toNumber(amountValue);
    if (!day || amount == null || amount < 0) return;
    const time = new Date(`${day}T12:00:00`).getTime();
    if (!Number.isFinite(time) || time < rangeStart - DAY || time > rangeEnd) return;
    if (project.name) projectNames.set(project.id, project.name);
    const key = `${project.id}\u0000${day}`;
    const old = projectDays.get(key);
    if (old == null || amount > old) projectDays.set(key, amount);
  };

  const rememberAggregatePoint = (dateValue, amountValue, context) => {
    if (/unique|file|loader|version|per.?project/i.test(context || '')) return;
    const day = dayKey(dateValue);
    const amount = toNumber(amountValue);
    if (!day || amount == null || amount < 0) return;
    const time = new Date(`${day}T12:00:00`).getTime();
    if (!Number.isFinite(time) || time < rangeStart - DAY || time > rangeEnd) return;
    const old = aggregateDays.get(day);
    if (old == null || amount > old) aggregateDays.set(day, amount);
  };

  const rememberProjectTotal = (project, amountValue, context) => {
    if (!project?.id || /unique|file|loader|version|all.?time|lifetime|total project downloads/i.test(context || '')) return;
    const amount = toNumber(amountValue);
    if (amount == null || amount < 0) return;
    let score = 0;
    if (/per.?project|project.*download|downloads.*project/i.test(context || '')) score += 120;
    if (/download|stat|analytic|metric|chart/i.test(context || '')) score += 50;
    if (new RegExp(`(?:^|\\D)${periodDays}(?:\\D|$)`).test(context || '')) score += 60;
    const old = projectPeriodCandidates.get(project.id);
    if (!old || score > old.score) {
      projectPeriodCandidates.set(project.id, { id: project.id, name: project.name || project.id, period: amount, current: amount, score });
    }
  };

  const readPointArray = (items, project, context, inheritedDates = null) => {
    if (!Array.isArray(items) || items.length < 2) return;
    if (inheritedDates && inheritedDates.length === items.length && items.every((item) => toNumber(item) != null)) {
      for (let index = 0; index < items.length; index++) {
        if (project?.id) rememberProjectPoint(project, inheritedDates[index], items[index], context);
        else rememberAggregatePoint(inheritedDates[index], items[index], context);
      }
      return;
    }
    for (let index = 0; index < items.length; index++) {
      const point = items[index];
      let date = null;
      let value = null;
      if (Array.isArray(point) && point.length >= 2) {
        date = point[0];
        value = point[1];
      } else if (point && typeof point === 'object') {
        date = point.date ?? point.day ?? point.time ?? point.timestamp ?? point.bucket ?? point.x;
        value = point.totalDownloads ?? point.total_downloads ?? point.downloads ?? point.downloadCount ?? point.download_count ?? point.total ?? point.count ?? point.value ?? point.y;
      }
      if (date == null || value == null) continue;
      if (project?.id) rememberProjectPoint(project, date, value, context);
      else rememberAggregatePoint(date, value, context);
    }
  };

  const seen = new WeakSet();
  const scan = (value, inherited = {}, depth = 0, context = '') => {
    if (depth > 12 || value == null || typeof value === 'function') return;
    if (typeof value === 'object') {
      if (seen.has(value)) return;
      seen.add(value);
    }
    if (Array.isArray(value)) {
      for (const child of value) scan(child, inherited, depth + 1, context);
      return;
    }
    if (typeof value !== 'object') return;

    const label = norm(value.metricName ?? value.metric ?? value.seriesName ?? value.label ?? value.name ?? value.title ?? '');
    const localContext = `${context} ${label}`.trim();
    const project = explicitProjectMeta(value, inherited, localContext);

    const directDate = value.date ?? value.day ?? value.time ?? value.timestamp ?? value.bucket ?? value.x;
    const directValue = value.totalDownloads ?? value.total_downloads ?? value.downloads ?? value.downloadCount ?? value.download_count ?? value.total ?? value.count ?? value.value ?? value.y;
    if (directDate != null && directValue != null && !/unique/i.test(localContext)) {
      if (project.id) rememberProjectPoint(project, directDate, directValue, localContext);
      else rememberAggregatePoint(directDate, directValue, localContext);
    }

    const dates = Array.isArray(value.dates) ? value.dates
      : Array.isArray(value.days) ? value.days
        : Array.isArray(value.labels) && value.labels.filter((item) => toDate(item)).length >= 2 ? value.labels
          : Array.isArray(value.categories) && value.categories.filter((item) => toDate(item)).length >= 2 ? value.categories
            : Array.isArray(value.timestamps) ? value.timestamps
              : null;

    for (const key of ['data', 'values', 'points', 'downloads', 'totalDownloads', 'totals', 'counts']) {
      const items = value[key];
      if (!Array.isArray(items) || items.length < 2) continue;
      if (/unique/i.test(`${localContext}.${key}`)) continue;
      readPointArray(items, project, `${localContext}.${key}`, dates);
    }

    for (const key of ['datasets', 'series']) {
      const datasets = value[key];
      if (!Array.isArray(datasets)) continue;
      for (const dataset of datasets) {
        if (!dataset || typeof dataset !== 'object') continue;
        const datasetContext = `${localContext}.${key}`;
        const datasetProject = explicitProjectMeta(dataset, project, datasetContext);
        const datasetLabel = norm(dataset.seriesName ?? dataset.label ?? dataset.name ?? dataset.title ?? '');
        const effectiveContext = `${datasetContext} ${datasetLabel}`.trim();
        if (/unique/i.test(effectiveContext)) continue;
        const points = Array.isArray(dataset.data) ? dataset.data
          : Array.isArray(dataset.values) ? dataset.values
            : Array.isArray(dataset.points) ? dataset.points
              : Array.isArray(dataset.downloads) ? dataset.downloads
                : null;
        if (points) readPointArray(points, datasetProject, effectiveContext, dates);
      }
    }

    if (project.id && directDate == null) {
      const totalValue = value.periodDownloads ?? value.period_downloads ?? value.downloadsInPeriod ?? value.downloads_in_period ?? value.totalDownloads ?? value.total_downloads ?? value.downloadCount ?? value.download_count;
      if (totalValue != null && !Array.isArray(totalValue)) rememberProjectTotal(project, totalValue, localContext);
    }

    const nextInherited = project.id || project.name ? project : inherited;
    for (const [key, child] of Object.entries(value)) {
      if (child == null || typeof child !== 'object') continue;
      scan(child, nextInherited, depth + 1, `${localContext}.${key}`);
    }
  };

  const fitYAxis = (svg, plotBox) => {
    const ticks = Array.from(svg.querySelectorAll('text')).map((element) => {
      const value = toNumber(norm(element.textContent));
      if (value == null) return null;
      try {
        const box = element.getBBox();
        const y = box.y + box.height / 2;
        if (box.x > plotBox.x + Math.max(40, plotBox.width * 0.1)) return null;
        return { y, value };
      } catch (_) { return null; }
    }).filter(Boolean);
    if (ticks.length < 2) return null;
    const meanY = ticks.reduce((sum, tick) => sum + tick.y, 0) / ticks.length;
    const meanV = ticks.reduce((sum, tick) => sum + tick.value, 0) / ticks.length;
    let covariance = 0;
    let variance = 0;
    for (const tick of ticks) {
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
      if (!Number.isFinite(length) || !box || length < 45 || box.width < 80 || box.height < 1) return null;
      const stroke = String(style.stroke || element.getAttribute?.('stroke') || '').trim();
      if (!stroke || stroke === 'none' || stroke === 'transparent' || stroke === 'rgba(0, 0, 0, 0)') return null;
      return { element, length, box, style, stroke };
    } catch (_) {
      return null;
    }
  };

  const sampleGeometry = (info, plotBox, yToValue) => {
    const buckets = Array.from({ length: periodDays }, () => []);
    const steps = Math.max(1000, periodDays * 20);
    for (let index = 0; index <= steps; index++) {
      try {
        const point = info.element.getPointAtLength((info.length * index) / steps);
        const ratio = (point.x - plotBox.x) / Math.max(plotBox.width, 1);
        if (ratio < -0.02 || ratio > 1.02) continue;
        const bucket = Math.max(0, Math.min(periodDays - 1, Math.round(ratio * (periodDays - 1))));
        buckets[bucket].push(point.y);
      } catch (_) {}
    }
    const values = buckets.map((ys) => {
      if (!ys.length) return null;
      const y = ys.reduce((sum, value) => sum + value, 0) / ys.length;
      return yToValue ? yToValue(y) : Math.max(0, plotBox.y + plotBox.height - y);
    });
    for (let index = 0; index < values.length; index++) {
      if (values[index] != null) continue;
      let left = index - 1;
      while (left >= 0 && values[left] == null) left--;
      let right = index + 1;
      while (right < values.length && values[right] == null) right++;
      if (left >= 0 && right < values.length) {
        values[index] = values[left] + ((values[right] - values[left]) * (index - left)) / (right - left);
      } else if (left >= 0) values[index] = values[left];
      else if (right < values.length) values[index] = values[right];
      else values[index] = 0;
    }
    return values.map((value) => Math.max(0, Math.round(value || 0)));
  };

  const renderedProjectFallback = () => {
    const section = findChartSection(true);
    if (!section) return null;
    const svgs = Array.from(section.querySelectorAll('svg'));
    let best = null;
    for (const svg of svgs) {
      const geometries = Array.from(svg.querySelectorAll('path[d],polyline[points]')).map(geometryInfo).filter(Boolean);
      if (!geometries.length) continue;
      const maxWidth = Math.max(...geometries.map((item) => item.box.width));
      const wide = geometries.filter((item) => item.box.width >= Math.max(80, maxWidth * 0.35));
      if (!wide.length) continue;
      const byColor = new Map();
      for (const item of wide) {
        const old = byColor.get(item.stroke);
        if (!old || item.length > old.length) byColor.set(item.stroke, item);
      }
      const lines = Array.from(byColor.values());
      if (!lines.length) continue;
      const minX = Math.min(...lines.map((item) => item.box.x));
      const maxX = Math.max(...lines.map((item) => item.box.x + item.box.width));
      const minY = Math.min(...lines.map((item) => item.box.y));
      const maxY = Math.max(...lines.map((item) => item.box.y + item.box.height));
      const plotBox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
      const score = plotBox.width * 4 + lines.length * 450 + plotBox.height;
      if (!best || score > best.score) best = { svg, lines, plotBox, score };
    }
    if (!best) return null;

    const yToValue = fitYAxis(best.svg, best.plotBox);
    const lineValues = best.lines.map((line) => ({
      color: line.stroke,
      values: sampleGeometry(line, best.plotBox, yToValue),
    }));
    const lineColors = new Set(lineValues.map((line) => line.color));
    const ignoredLegend = /^(?:all projects|7 days|30 days|90 days|last 7 days|last 30 days|last 90 days|7d|30d|90d|downloads|total|unique|statistics|minecraft|minecraft java|total\/unique downloads over time(?: \(per project\))?)$/i;
    const legends = [];
    for (const leaf of leafElements(section)) {
      const name = norm(leaf.textContent);
      if (!name || name.length > 140 || ignoredLegend.test(name) || toNumber(name) != null || toDate(name)) continue;
      let markerColor = null;
      let parent = leaf.parentElement;
      for (let depth = 0; depth < 4 && parent && !markerColor; depth++, parent = parent.parentElement) {
        const candidates = [parent, ...Array.from(parent.querySelectorAll('span,div,svg')).slice(0, 30)];
        for (const candidate of candidates) {
          if (candidate === leaf) continue;
          let rect;
          try { rect = candidate.getBoundingClientRect(); } catch (_) { continue; }
          if (!rect || rect.width < 3 || rect.height < 3 || rect.width > 30 || rect.height > 30) continue;
          const style = getComputedStyle(candidate);
          for (const color of [style.backgroundColor, style.borderTopColor, style.borderLeftColor, style.color, style.fill, style.stroke]) {
            const normalized = String(color || '').trim();
            if (lineColors.has(normalized)) { markerColor = normalized; break; }
          }
          if (markerColor) break;
        }
      }
      if (markerColor && !legends.some((entry) => entry.color === markerColor)) legends.push({ name, color: markerColor });
    }

    const projects = [];
    const aggregate = Array(periodDays).fill(0);
    for (let index = 0; index < lineValues.length; index++) {
      const line = lineValues[index];
      for (let day = 0; day < line.values.length; day++) aggregate[day] += line.values[day] || 0;
      const legend = legends.find((entry) => entry.color === line.color) ?? legends[index] ?? null;
      const name = legend?.name || `CurseForge project ${index + 1}`;
      const period = line.values.reduce((sum, value) => sum + Math.max(0, value || 0), 0);
      projects.push({ id: name, name, period, current: period });
    }
    return { projects, aggregate, lines: lineValues.length, legends: legends.length };
  };

  const aggregateSeries = () => {
    const values = Array(periodDays).fill(0);
    const keys = Array.from({ length: periodDays }, (_, index) => {
      const date = new Date(startDate.getTime() + index * DAY);
      return dayKey(date);
    });
    let found = 0;
    for (let index = 0; index < keys.length; index++) {
      const value = aggregateDays.get(keys[index]);
      if (value != null) {
        values[index] = value;
        found++;
      }
    }
    return found >= Math.min(5, periodDays) ? values : [];
  };

  const projectSeriesResult = () => {
    const perProject = new Map();
    const perDay = new Map();
    for (const [key, value] of projectDays) {
      const separator = key.indexOf('\u0000');
      if (separator < 0) continue;
      const id = key.slice(0, separator);
      const day = key.slice(separator + 1);
      perProject.set(id, (perProject.get(id) ?? 0) + value);
      perDay.set(day, (perDay.get(day) ?? 0) + value);
    }
    const projects = Array.from(perProject, ([id, period]) => ({
      id,
      name: projectNames.get(id) || id,
      period,
      current: period,
    }));
    const values = Array(periodDays).fill(0);
    let found = 0;
    for (let index = 0; index < periodDays; index++) {
      const day = dayKey(new Date(startDate.getTime() + index * DAY));
      const value = perDay.get(day);
      if (value != null) {
        values[index] = value;
        found++;
      }
    }
    return { projects, values: found >= Math.min(5, periodDays) ? values : [], dayCount: found };
  };

  const run = async () => {
    for (let attempt = 0; attempt < 28; attempt++) {
      if (loggedOut()) {
        window.__FODRINTH_CF_DOWNLOAD_V4_RESULT__ = {
          connected: false,
          needsLogin: true,
          current: null,
          previous: null,
          allTime: null,
          uniqueCurrent: null,
          uniquePrevious: null,
          series: [],
          projects: [],
        };
        return;
      }
      if (norm(document.body?.innerText).length > 80) break;
      await sleep(250);
    }

    setStage('open-downloads');
    clearCaptures();
    const opened = await openDownloads();
    if (!opened && loggedOut()) {
      window.__FODRINTH_CF_DOWNLOAD_V4_RESULT__ = {
        connected: false,
        needsLogin: true,
        current: null,
        previous: null,
        allTime: null,
        uniqueCurrent: null,
        uniquePrevious: null,
        series: [],
        projects: [],
      };
      return;
    }

    setStage('wake-charts');
    await wakeCharts();
    setStage('select-period');
    await selectPeriod();
    setStage('select-total');
    await selectTotal();
    await wakeCharts();

    setStage('wait-network');
    let previousCaptureCount = -1;
    let stable = 0;
    for (let attempt = 0; attempt < 36; attempt++) {
      await sleep(300);
      const count = (window.__FODRINTH_CF_CAPTURES__ || []).length;
      if (count === previousCaptureCount) stable++;
      else stable = 0;
      previousCaptureCount = count;
      if (stable >= 6 && attempt >= 10) break;
    }

    const yesterdayCard = kpiMetric([/^yesterday(?:\s+vs\.?\s+same day last week)?$/i, /^yesterday$/i]);
    const sevenCard = kpiMetric([/^last 7 days$/i]);
    const thirtyCard = kpiMetric([/^last 30 days$/i]);
    const allTimeCard = kpiMetric([/^total project downloads$/i, /^all[- ]time downloads$/i, /^total downloads$/i]);
    const uniqueCard = kpiMetric([/^unique downloads$/i, /^total unique downloads$/i]);
    const periodCard = periodDays === 7 ? sevenCard : periodDays === 30 ? thirtyCard : null;

    setStage('parse-captures');
    const captured = captures();
    const relevant = captured.filter((capture) => /download|stat|analytic|metric|chart|project/i.test(capture.url));
    const selected = (relevant.length ? relevant : captured).slice(-140);
    for (const capture of selected) scan(capture.value, {}, 0, capture.url || 'capture');

    let projectResult = projectSeriesResult();
    let source = projectResult.values.length ? 'network-project-series' : null;
    let values = projectResult.values;
    let projects = projectResult.projects;

    if (!values.length) {
      const aggregate = aggregateSeries();
      if (aggregate.length) {
        values = aggregate;
        source = 'network-aggregate-series';
      }
    }

    if (!projects.length && projectPeriodCandidates.size) {
      projects = Array.from(projectPeriodCandidates.values()).map(({ score, ...project }) => project);
      if (!source) source = 'network-project-totals';
    }

    if (!values.length || !projects.length) {
      setStage('render-fallback');
      const rendered = renderedProjectFallback();
      if (rendered) {
        if (!values.length && rendered.aggregate.some((value) => value > 0)) {
          values = rendered.aggregate;
          source = 'rendered-project-series';
        }
        if (!projects.length && rendered.projects.length) projects = rendered.projects;
      }
    }

    const series = values.length
      ? values.map((value, index) => ({
        date: new Date(startDate.getTime() + index * DAY).toISOString(),
        total: Math.max(0, value || 0),
        unique: null,
      }))
      : [];

    const seriesTotal = values.reduce((sum, value) => sum + Math.max(0, toNumber(value) ?? 0), 0);
    const projectTotal = projects.reduce((sum, project) => sum + Math.max(0, toNumber(project.period) ?? 0), 0);
    const current = periodCard?.value ?? (series.length ? seriesTotal : projects.length ? projectTotal : null);
    let previous = null;
    if (current != null && Number.isFinite(periodCard?.percent) && Math.abs(100 + periodCard.percent) > 0.0001) {
      previous = current / (1 + periodCard.percent / 100);
    }

    setStage('done');
    window.__FODRINTH_CF_DOWNLOAD_V4_RESULT__ = {
      connected: true,
      needsLogin: false,
      current,
      previous,
      allTime: allTimeCard?.value ?? null,
      uniqueCurrent: uniqueCard?.value ?? null,
      uniquePrevious: null,
      yesterday: yesterdayCard?.value ?? null,
      yesterdayChangePercent: Number.isFinite(yesterdayCard?.percent) ? yesterdayCard.percent : null,
      series,
      projects,
      debug: {
        periodDays,
        source,
        capturesSeen: captured.length,
        capturesParsed: selected.length,
        projectPoints: projectDays.size,
        aggregatePoints: aggregateDays.size,
        projectCount: projects.length,
        seriesPoints: series.length,
        periodCandidates: projectPeriodCandidates.size,
        captureUrls: Array.from(new Set(selected.map((capture) => capture.url))).slice(0, 30),
      },
    };
  };

  run().catch((error) => {
    window.__FODRINTH_CF_DOWNLOAD_STAGE__ = 'error';
    window.__FODRINTH_CF_DOWNLOAD_V4_RESULT__ = {
      connected: true,
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
