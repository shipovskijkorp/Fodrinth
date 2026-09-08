(() => {
  window.__FODRINTH_CF_DOWNLOAD_PROJECTS_AUGMENTED__ = false;

  const knownProjects = Array.isArray(__KNOWN_PROJECTS__) ? __KNOWN_PROJECTS__ : [];
  const periodDays = Math.max(1, Math.min(365, Number('__PERIOD_DAYS__') || 30));
  const DAY = 86400000;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const key = (value) => norm(value)
    .toLowerCase()
    .replace(/\u2026|\.{3,}$/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const number = (value) => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = norm(value).replace(/\s/g, '').replace(/,/g, '');
    if (!text) return null;
    const compact = text.match(/^([+-]?[\d.]+)([kmb])$/i);
    if (compact) {
      const base = Number(compact[1]);
      const factor = { k: 1e3, m: 1e6, b: 1e9 }[compact[2].toLowerCase()];
      return Number.isFinite(base) ? base * factor : null;
    }
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const known = knownProjects.map((project) => ({
    id: norm(project?.id),
    name: norm(project?.name ?? project?.title ?? project?.slug ?? project?.id),
  })).filter((project) => project.id || project.name);
  const byId = new Map(known.filter((project) => project.id).map((project) => [project.id, project]));
  const byName = new Map(known.filter((project) => project.name).map((project) => [key(project.name), project]));

  const matchKnown = (idValue, nameValue) => {
    const id = norm(idValue);
    if (id && byId.has(id)) return byId.get(id);
    const name = key(nameValue);
    if (name && byName.has(name)) return byName.get(name);
    if (!name) return null;
    let best = null;
    let bestLength = 0;
    for (const [candidate, project] of byName) {
      const shared = candidate.startsWith(name) ? name.length : name.startsWith(candidate) ? candidate.length : 0;
      if (shared >= 10 && shared > bestLength) {
        best = project;
        bestLength = shared;
      }
    }
    return best;
  };

  const periodAliases = () => periodDays === 7
    ? ['last 7 days', '7 days', '7d']
    : periodDays === 30
      ? ['last 30 days', '30 days', '30d']
      : periodDays === 90
        ? ['last 90 days', '90 days', '90d', 'last 3 months', '3 months']
        : [`last ${periodDays} days`, `${periodDays} days`, `${periodDays}d`];

  const sectionForHeading = (pattern, reject = null) => {
    const headings = Array.from(document.querySelectorAll('body *')).filter((element) => {
      if (element.children.length > 5) return false;
      const value = norm(element.textContent);
      return pattern.test(value) && (!reject || !reject.test(value));
    });
    for (const heading of headings) {
      let node = heading;
      for (let depth = 0; depth < 11 && node; depth++, node = node.parentElement) {
        if (node.querySelector?.('svg,canvas') && node.querySelector?.('select,button,[role="button"]')) return node;
      }
    }
    return null;
  };

  const perProjectTimeSection = () => sectionForHeading(/downloads over time/i, null);
  const downloadsPerProjectSection = () => sectionForHeading(/downloads per project/i, /over time/i);

  const selectPeriodIn = async (root) => {
    if (!root) return false;
    const aliases = periodAliases();
    for (const select of root.querySelectorAll('select')) {
      const option = Array.from(select.options || []).find((item) => aliases.includes(norm(item.textContent).toLowerCase()));
      if (!option) continue;
      if (select.value !== option.value) {
        select.value = option.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(1500);
      }
      return true;
    }
    let controls = Array.from(root.querySelectorAll('button,[role="button"],[role="option"],[role="menuitem"]'));
    const direct = controls.find((element) => aliases.includes(norm(element.textContent).toLowerCase()));
    if (direct) {
      direct.click();
      await sleep(1500);
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
    await sleep(1500);
    return true;
  };

  const selectTotalIn = async (root) => {
    if (!root) return;
    const total = Array.from(root.querySelectorAll('button,[role="button"],[role="tab"]'))
      .find((element) => /^total$/i.test(norm(element.textContent)));
    if (!total) return;
    const selected = total.getAttribute('aria-selected') === 'true'
      || total.getAttribute('aria-pressed') === 'true'
      || /active|selected/i.test(total.className || '');
    if (!selected) {
      total.click();
      await sleep(1000);
    }
  };

  const wake = async (root) => {
    if (!root) return;
    try { root.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}
    try { window.dispatchEvent(new Event('resize')); } catch (_) {}
    await sleep(800);
  };

  const fitYAxis = (svg, plotBox) => {
    const ticks = Array.from(svg.querySelectorAll('text')).map((element) => {
      const value = number(element.textContent);
      if (value == null) return null;
      try {
        const box = element.getBBox();
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        if (x > plotBox.x + Math.max(45, plotBox.width * 0.12)) return null;
        if (y < plotBox.y - 30 || y > plotBox.y + plotBox.height + 30) return null;
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
    return Number.isFinite(slope) && slope < 0
      ? (y) => Math.max(0, slope * y + intercept)
      : null;
  };

  const matchLabel = (value) => {
    const textKey = key(value);
    if (!textKey) return null;
    if (byName.has(textKey)) return byName.get(textKey);
    let best = null;
    let bestLength = 0;
    for (const [projectKey, project] of byName) {
      const shared = projectKey.startsWith(textKey) ? textKey.length : textKey.startsWith(projectKey) ? projectKey.length : 0;
      if (shared >= 8 && shared > bestLength) {
        best = project;
        bestLength = shared;
      }
    }
    return best;
  };

  const shapeInfo = (element) => {
    try {
      const box = element.getBBox?.();
      if (!box || box.width < 1.5 || box.height < 0.5) return null;
      const style = getComputedStyle(element);
      const fill = String(style.fill || element.getAttribute?.('fill') || '').toLowerCase();
      const stroke = String(style.stroke || element.getAttribute?.('stroke') || '').toLowerCase();
      const visiblePaint = (fill && fill !== 'none' && !fill.includes('rgba(0, 0, 0, 0)') && fill !== 'transparent')
        || (stroke && stroke !== 'none' && !stroke.includes('rgba(0, 0, 0, 0)') && stroke !== 'transparent');
      if (!visiblePaint) return null;
      return { element, box };
    } catch (_) { return null; }
  };

  const extractBarPeriods = () => {
    const section = downloadsPerProjectSection();
    if (!section) return { projects: [], recognized: false, labels: 0, bars: 0, reason: 'section-not-found' };
    let best = null;
    for (const svg of section.querySelectorAll('svg')) {
      const labels = Array.from(svg.querySelectorAll('text')).map((element) => {
        const project = matchLabel(element.textContent);
        if (!project) return null;
        try {
          const box = element.getBBox();
          return { project, element, box, x: box.x + box.width / 2 };
        } catch (_) { return null; }
      }).filter(Boolean);
      const deduped = [];
      const seen = new Set();
      for (const label of labels) {
        const id = label.project.id || label.project.name;
        if (seen.has(id)) continue;
        seen.add(id);
        deduped.push(label);
      }
      if (!deduped.length) continue;
      const shapes = Array.from(svg.querySelectorAll('rect,path')).map(shapeInfo).filter(Boolean)
        .filter((shape) => shape.box.width < 180 && shape.box.height > 0.5);
      if (!shapes.length) continue;
      const labelXs = deduped.map((label) => label.x).sort((a, b) => a - b);
      const gaps = [];
      for (let index = 1; index < labelXs.length; index++) {
        const gap = labelXs[index] - labelXs[index - 1];
        if (gap > 4) gaps.push(gap);
      }
      gaps.sort((a, b) => a - b);
      const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : Math.max(30, svg.viewBox?.baseVal?.width / Math.max(known.length, 1));
      const radius = Math.max(12, medianGap * 0.46);
      const candidateShapes = shapes.filter((shape) => deduped.some((label) => Math.abs((shape.box.x + shape.box.width / 2) - label.x) <= radius));
      if (!candidateShapes.length) continue;
      const minX = Math.min(...candidateShapes.map((shape) => shape.box.x));
      const maxX = Math.max(...candidateShapes.map((shape) => shape.box.x + shape.box.width));
      const minY = Math.min(...candidateShapes.map((shape) => shape.box.y));
      const maxY = Math.max(...candidateShapes.map((shape) => shape.box.y + shape.box.height));
      const plotBox = { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
      const yToValue = fitYAxis(svg, plotBox);
      const score = deduped.length * 1000 + candidateShapes.length * 40 + (yToValue ? 500 : 0);
      if (!best || score > best.score) best = { svg, labels: deduped, shapes: candidateShapes, plotBox, yToValue, radius, score };
    }
    if (!best || !best.yToValue) {
      return { projects: [], recognized: !!best, labels: best?.labels?.length ?? 0, bars: best?.shapes?.length ?? 0, reason: best ? 'y-axis-not-readable' : 'svg-not-mapped' };
    }

    const values = new Map();
    for (const label of best.labels) {
      const id = label.project.id || label.project.name;
      const nearby = best.shapes.filter((shape) => Math.abs((shape.box.x + shape.box.width / 2) - label.x) <= best.radius);
      if (!nearby.length) {
        values.set(id, 0);
        continue;
      }
      // Total downloads are always >= unique downloads, so the tallest bar in a project group
      // is the Total series when both are rendered.
      const totalBar = nearby.sort((left, right) => right.box.height - left.box.height)[0];
      const value = best.yToValue(totalBar.box.y);
      values.set(id, Math.max(0, Math.round(value)));
    }

    const projects = known.map((project) => {
      const id = project.id || project.name;
      return values.has(id)
        ? { id, name: project.name, period: values.get(id), current: values.get(id) }
        : null;
    }).filter(Boolean);
    return {
      projects,
      recognized: best.labels.length >= Math.max(1, Math.ceil(Math.min(known.length, 4) / 2)),
      labels: best.labels.length,
      bars: best.shapes.length,
      reason: null,
    };
  };

  const lineInfo = (element) => {
    try {
      const length = element.getTotalLength?.();
      const box = element.getBBox?.();
      const style = getComputedStyle(element);
      const stroke = String(style.stroke || element.getAttribute?.('stroke') || '').toLowerCase().replace(/\s+/g, '');
      if (!Number.isFinite(length) || !box || length < 45 || box.width < 70 || box.height < 1) return null;
      if (!stroke || stroke === 'none' || stroke === 'transparent' || stroke.includes('rgba(0,0,0,0)')) return null;
      return { element, length, box, stroke };
    } catch (_) { return null; }
  };

  const sampleLine = (info, plotBox, yToValue) => {
    if (!yToValue) return [];
    const buckets = Array.from({ length: periodDays }, () => []);
    const steps = Math.max(700, periodDays * 12);
    for (let index = 0; index <= steps; index++) {
      try {
        const point = info.element.getPointAtLength((info.length * index) / steps);
        const ratio = (point.x - plotBox.x) / Math.max(1, plotBox.width);
        if (ratio < -0.02 || ratio > 1.02) continue;
        const bucket = Math.max(0, Math.min(periodDays - 1, Math.round(ratio * (periodDays - 1))));
        buckets[bucket].push(point.y);
      } catch (_) {}
    }
    const values = buckets.map((ys) => {
      if (!ys.length) return null;
      return yToValue(ys.reduce((sum, value) => sum + value, 0) / ys.length);
    });
    for (let index = 0; index < values.length; index++) {
      if (values[index] != null) continue;
      let left = index - 1;
      while (left >= 0 && values[left] == null) left--;
      let right = index + 1;
      while (right < values.length && values[right] == null) right++;
      if (left >= 0 && right < values.length) values[index] = values[left] + ((values[right] - values[left]) * (index - left)) / (right - left);
      else if (left >= 0) values[index] = values[left];
      else if (right < values.length) values[index] = values[right];
      else values[index] = 0;
    }
    return values.map((value) => Math.max(0, Number(value) || 0));
  };

  const extractLinePeriodsByOrder = () => {
    const section = perProjectTimeSection();
    if (!section) return { projects: [], lines: 0, labels: 0, reason: 'section-not-found' };
    const legendProjects = [];
    const leaves = Array.from(section.querySelectorAll('*')).filter((element) => element.children.length === 0);
    for (const leaf of leaves) {
      const project = matchLabel(leaf.textContent);
      if (!project) continue;
      const id = project.id || project.name;
      if (!legendProjects.some((item) => (item.id || item.name) === id)) legendProjects.push(project);
    }
    let best = null;
    for (const svg of section.querySelectorAll('svg')) {
      const geometries = Array.from(svg.querySelectorAll('path[d],polyline[points]')).map(lineInfo).filter(Boolean);
      if (!geometries.length) continue;
      const maxWidth = Math.max(...geometries.map((item) => item.box.width));
      const lines = geometries.filter((item) => item.box.width >= Math.max(70, maxWidth * 0.5));
      if (!lines.length) continue;
      const uniqueByStroke = new Map();
      for (const line of lines) {
        const old = uniqueByStroke.get(line.stroke);
        if (!old || line.length > old.length) uniqueByStroke.set(line.stroke, line);
      }
      const unique = Array.from(uniqueByStroke.values());
      const minX = Math.min(...unique.map((item) => item.box.x));
      const maxX = Math.max(...unique.map((item) => item.box.x + item.box.width));
      const minY = Math.min(...unique.map((item) => item.box.y));
      const maxY = Math.max(...unique.map((item) => item.box.y + item.box.height));
      const plotBox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
      const yToValue = fitYAxis(svg, plotBox);
      const score = unique.length * 500 + plotBox.width + (yToValue ? 400 : 0);
      if (!best || score > best.score) best = { lines: unique, plotBox, yToValue, score };
    }
    if (!best || !best.yToValue || !legendProjects.length || legendProjects.length !== best.lines.length) {
      return { projects: [], lines: best?.lines?.length ?? 0, labels: legendProjects.length, reason: 'order-not-safe' };
    }
    return {
      projects: legendProjects.map((project, index) => {
        const values = sampleLine(best.lines[index], best.plotBox, best.yToValue);
        const period = Math.round(values.reduce((sum, value) => sum + value, 0));
        return { id: project.id || project.name, name: project.name, period, current: period };
      }),
      lines: best.lines.length,
      labels: legendProjects.length,
      reason: null,
    };
  };

  const sanitizeExistingProjects = (rawProjects) => {
    const found = new Map();
    for (const raw of rawProjects ?? []) {
      const project = matchKnown(raw?.id, raw?.name);
      if (!project) continue;
      const period = number(raw?.period ?? raw?.current);
      if (period == null) continue;
      const id = project.id || project.name;
      found.set(id, { id, name: project.name, period: Math.max(0, Math.round(period)), current: Math.max(0, Math.round(period)) });
    }
    return found;
  };

  const normalizeSeriesToTotal = (result, target) => {
    if (!Number.isFinite(target) || target < 0 || !Array.isArray(result?.series) || result.series.length === 0) return;
    const now = Date.now();
    const start = now - (periodDays + 1) * DAY;
    let sum = 0;
    const indexes = [];
    for (let index = 0; index < result.series.length; index++) {
      const row = result.series[index];
      const time = new Date(row?.date ?? row?.timestamp ?? row?.time).getTime();
      const value = number(row?.total ?? row?.value);
      if (!Number.isFinite(time) || time < start || time > now + DAY || value == null) continue;
      sum += Math.max(0, value);
      indexes.push(index);
    }
    if (!(sum > 0) || !indexes.length) return;
    const ratio = target / sum;
    for (const index of indexes) {
      const row = result.series[index];
      const value = number(row?.total ?? row?.value) ?? 0;
      row.total = Math.max(0, value * ratio);
      if ('value' in row) row.value = row.total;
    }
  };

  const run = async () => {
    const result = window.__FODRINTH_CF_DOWNLOAD_V3_RESULT__;
    if (result == null) {
      window.__FODRINTH_CF_DOWNLOAD_PROJECTS_AUGMENTED__ = true;
      return;
    }

    const timeSection = perProjectTimeSection();
    const barSection = downloadsPerProjectSection();
    await selectPeriodIn(timeSection);
    await selectTotalIn(timeSection);
    await wake(timeSection);
    await selectPeriodIn(barSection);
    await selectTotalIn(barSection);
    await wake(barSection);

    // Give MUI/Recharts enough time to finish the lazy chart render after the hidden WebView is shown.
    for (let attempt = 0; attempt < 18; attempt++) {
      const hasBarSvg = !!downloadsPerProjectSection()?.querySelector?.('svg');
      const hasLineSvg = !!perProjectTimeSection()?.querySelector?.('svg');
      if (hasBarSvg || hasLineSvg) break;
      await sleep(500);
      try { window.dispatchEvent(new Event('resize')); } catch (_) {}
    }

    const exact = sanitizeExistingProjects(result.projects);
    let source = 'captured';
    let mapped = null;

    const bars = extractBarPeriods();
    if (bars.recognized && bars.projects.length > 0) {
      mapped = bars.projects;
      source = 'downloads-per-project-bars';
    } else {
      const lines = extractLinePeriodsByOrder();
      if (lines.projects.length > 0) {
        mapped = lines.projects;
        source = 'per-project-lines-by-order';
      }
      result.debug = {
        ...(result.debug ?? {}),
        projectBars: bars,
        projectLines: lines,
      };
    }

    if (mapped) {
      exact.clear();
      for (const project of mapped) exact.set(project.id || project.name, project);
    }

    const projects = known.map((project) => {
      const id = project.id || project.name;
      const periodProject = exact.get(id);
      if (!periodProject) return null;
      return {
        id,
        name: project.name,
        period: Math.max(0, Math.round(number(periodProject.period) ?? 0)),
        current: Math.max(0, Math.round(number(periodProject.current ?? periodProject.period) ?? 0)),
      };
    }).filter(Boolean);

    const complete = projects.length === known.length && known.length > 0;
    if (complete) {
      const total = projects.reduce((sum, project) => sum + (number(project.period) ?? 0), 0);
      result.current = total;
      normalizeSeriesToTotal(result, total);
    }

    result.projects = projects;
    result.debug = {
      ...(result.debug ?? {}),
      knownProjects: known.length,
      matchedProjectPeriods: projects.length,
      projectPeriodSource: source,
      projectPeriodsComplete: complete,
      ...(result.debug?.projectBars ? {} : { projectBars: bars }),
    };
    window.__FODRINTH_CF_DOWNLOAD_PROJECTS_AUGMENTED__ = true;
  };

  void run().catch((error) => {
    const result = window.__FODRINTH_CF_DOWNLOAD_V3_RESULT__;
    if (result && typeof result === 'object') {
      result.debug = { ...(result.debug ?? {}), projectPeriodMapperError: String(error?.stack || error?.message || error) };
    }
    window.__FODRINTH_CF_DOWNLOAD_PROJECTS_AUGMENTED__ = true;
  });
})();
