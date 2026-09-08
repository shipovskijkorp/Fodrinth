(() => {
  window.__FODRINTH_CF_DOWNLOAD_PROJECTS_AUGMENTED__ = false;

  const projects = Array.isArray(__KNOWN_PROJECTS__) ? __KNOWN_PROJECTS__ : [];
  const periodDays = Math.max(1, Math.min(365, Number('__PERIOD_DAYS__') || 30));
  const DAY = 86400000;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const projectKey = (value) => norm(value)
    .toLowerCase()
    .replace(/\u2026|\.{3,}$/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const toNumber = (value) => {
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
    const valueNumber = Number(text);
    return Number.isFinite(valueNumber) ? valueNumber : null;
  };

  const known = projects.map((project) => ({
    id: norm(project?.id),
    name: norm(project?.name ?? project?.title ?? project?.slug ?? project?.id),
  })).filter((project) => project.id || project.name);
  const byName = new Map(known.filter((project) => project.name).map((project) => [projectKey(project.name), project]));

  const matchProject = (value) => {
    const key = projectKey(value);
    if (!key) return null;
    if (byName.has(key)) return byName.get(key);
    let best = null;
    let bestLength = 0;
    for (const [candidate, project] of byName) {
      const shared = candidate.startsWith(key) ? key.length : key.startsWith(candidate) ? candidate.length : 0;
      if (shared >= 7 && shared > bestLength) {
        best = project;
        bestLength = shared;
      }
    }
    return best;
  };

  const periodAliases = periodDays === 7
    ? ['last 7 days', '7 days', '7d']
    : periodDays === 30
      ? ['last 30 days', '30 days', '30d']
      : periodDays === 90
        ? ['last 90 days', '90 days', '90d', 'last 3 months', '3 months']
        : [`last ${periodDays} days`, `${periodDays} days`, `${periodDays}d`];

  const findSection = () => {
    const headings = Array.from(document.querySelectorAll('body *')).filter((element) => {
      if (element.children.length > 4) return false;
      const text = norm(element.textContent);
      return /downloads per project/i.test(text) && !/over time/i.test(text);
    });
    for (const heading of headings) {
      let node = heading;
      for (let depth = 0; depth < 12 && node; depth++, node = node.parentElement) {
        if (node.querySelector?.('svg') && node.querySelector?.('select,button,[role="button"]')) return node;
      }
    }
    return null;
  };

  const selectPeriod = async (root) => {
    if (!root) return false;
    for (const select of root.querySelectorAll('select')) {
      const option = Array.from(select.options || []).find((item) => periodAliases.includes(norm(item.textContent).toLowerCase()));
      if (!option) continue;
      if (select.value !== option.value) {
        select.value = option.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(1400);
      }
      return true;
    }
    let controls = Array.from(root.querySelectorAll('button,[role="button"],[role="option"],[role="menuitem"]'));
    const direct = controls.find((element) => periodAliases.includes(norm(element.textContent).toLowerCase()));
    if (direct) {
      direct.click();
      await sleep(1400);
      return true;
    }
    const picker = controls.find((element) => /last \d+ days|\b\d+ days\b|\b\d+d\b|months?/i.test(norm(element.textContent)));
    if (!picker) return false;
    picker.click();
    await sleep(250);
    controls = Array.from(document.querySelectorAll('[role="option"],[role="menuitem"],button'));
    const option = controls.find((element) => periodAliases.includes(norm(element.textContent).toLowerCase()));
    if (!option) return false;
    option.click();
    await sleep(1400);
    return true;
  };

  const selectTotal = async (root) => {
    if (!root) return;
    const total = Array.from(root.querySelectorAll('button,[role="button"],[role="tab"]'))
      .find((element) => /^total$/i.test(norm(element.textContent)));
    if (!total) return;
    const selected = total.getAttribute('aria-selected') === 'true'
      || total.getAttribute('aria-pressed') === 'true'
      || /active|selected/i.test(total.className || '');
    if (!selected) {
      total.click();
      await sleep(900);
    }
  };

  const transformedBox = (element) => {
    try {
      const box = element.getBBox();
      const matrix = element.getCTM();
      const svg = element.ownerSVGElement;
      if (!matrix || !svg) return box;
      const corners = [
        [box.x, box.y],
        [box.x + box.width, box.y],
        [box.x, box.y + box.height],
        [box.x + box.width, box.y + box.height],
      ].map(([x, y]) => {
        const point = svg.createSVGPoint();
        point.x = x;
        point.y = y;
        return point.matrixTransform(matrix);
      });
      const xs = corners.map((point) => point.x);
      const ys = corners.map((point) => point.y);
      return {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      };
    } catch (_) {
      return null;
    }
  };

  const filledShape = (element) => {
    const box = transformedBox(element);
    if (!box || box.width < 1.5 || box.height < 0.5 || box.width > 180) return null;
    try {
      const style = getComputedStyle(element);
      const fill = String(style.fill || element.getAttribute('fill') || '').toLowerCase();
      const opacity = Number.parseFloat(style.opacity || style.fillOpacity || '1');
      if (!fill || fill === 'none' || fill === 'transparent' || fill.includes('rgba(0, 0, 0, 0)')) return null;
      if (Number.isFinite(opacity) && opacity < 0.05) return null;
    } catch (_) {
      return null;
    }
    return { element, box, centerX: box.x + box.width / 2 };
  };

  const fitYAxis = (svg, plotBox) => {
    const ticks = Array.from(svg.querySelectorAll('text')).map((element) => {
      const value = toNumber(element.textContent);
      if (value == null) return null;
      const box = transformedBox(element);
      if (!box) return null;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      if (x > plotBox.x + Math.max(45, plotBox.width * 0.12)) return null;
      if (y < plotBox.y - 40 || y > plotBox.y + plotBox.height + 40) return null;
      return { y, value };
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

  const readChart = (section) => {
    if (!section) return { projects: [], debug: { reason: 'section-not-found' } };
    let best = null;
    for (const svg of section.querySelectorAll('svg')) {
      const shapes = Array.from(svg.querySelectorAll('rect,path')).map(filledShape).filter(Boolean);
      if (shapes.length < 1) continue;
      const rawLabels = Array.from(svg.querySelectorAll('text')).map((element) => {
        const project = matchProject(element.textContent);
        if (!project) return null;
        const box = transformedBox(element);
        if (!box) return null;
        return { project, box, centerX: box.x + box.width / 2, centerY: box.y + box.height / 2 };
      }).filter(Boolean);
      if (!rawLabels.length) continue;

      // The project axis labels sit below the bars. Prefer the lowest occurrence for every
      // project so legend labels cannot be confused with X-axis labels.
      const labelsByProject = new Map();
      for (const label of rawLabels) {
        const id = label.project.id || label.project.name;
        const old = labelsByProject.get(id);
        if (!old || label.centerY > old.centerY) labelsByProject.set(id, label);
      }
      const labels = Array.from(labelsByProject.values());
      if (!labels.length) continue;

      const labelXs = labels.map((label) => label.centerX).sort((a, b) => a - b);
      const gaps = [];
      for (let index = 1; index < labelXs.length; index++) {
        const gap = labelXs[index] - labelXs[index - 1];
        if (gap > 3) gaps.push(gap);
      }
      gaps.sort((a, b) => a - b);
      const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 70;
      const radius = Math.max(12, medianGap * 0.46);
      const nearbyShapes = shapes.filter((shape) => labels.some((label) => Math.abs(shape.centerX - label.centerX) <= radius));
      if (!nearbyShapes.length) continue;

      const minX = Math.min(...nearbyShapes.map((shape) => shape.box.x));
      const maxX = Math.max(...nearbyShapes.map((shape) => shape.box.x + shape.box.width));
      const minY = Math.min(...nearbyShapes.map((shape) => shape.box.y));
      const maxY = Math.max(...nearbyShapes.map((shape) => shape.box.y + shape.box.height));
      const plotBox = { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
      const yToValue = fitYAxis(svg, plotBox);
      const score = labels.length * 1000 + nearbyShapes.length * 30 + (yToValue ? 1000 : 0);
      if (!best || score > best.score) best = { svg, labels, shapes: nearbyShapes, radius, plotBox, yToValue, score };
    }

    if (!best || !best.yToValue) {
      return { projects: [], debug: { reason: best ? 'y-axis-not-readable' : 'chart-svg-not-mapped', labels: best?.labels?.length ?? 0, bars: best?.shapes?.length ?? 0 } };
    }

    const mapped = [];
    for (const label of best.labels) {
      const nearby = best.shapes.filter((shape) => Math.abs(shape.centerX - label.centerX) <= best.radius);
      if (!nearby.length) {
        mapped.push({ id: label.project.id || label.project.name, name: label.project.name, period: 0, current: 0 });
        continue;
      }
      // The chart renders Total and Unique side by side. Total cannot be smaller than Unique,
      // therefore the tallest bar in the project slot is the total-download bar.
      const totalBar = [...nearby].sort((left, right) => right.box.height - left.box.height)[0];
      const value = Math.max(0, Math.round(best.yToValue(totalBar.box.y)));
      mapped.push({ id: label.project.id || label.project.name, name: label.project.name, period: value, current: value });
    }

    return {
      projects: mapped,
      debug: {
        reason: null,
        labels: best.labels.length,
        bars: best.shapes.length,
        mapped: mapped.length,
      },
    };
  };

  const scaleSeries = (result, target) => {
    if (!Array.isArray(result?.series) || !result.series.length || !(target >= 0)) return;
    const now = Date.now();
    const start = now - (periodDays + 1) * DAY;
    let sum = 0;
    const indexes = [];
    for (let index = 0; index < result.series.length; index++) {
      const row = result.series[index];
      const timestamp = new Date(row?.date ?? row?.timestamp ?? row?.time).getTime();
      const value = toNumber(row?.total ?? row?.value);
      if (!Number.isFinite(timestamp) || timestamp < start || timestamp > now + DAY || value == null) continue;
      sum += Math.max(0, value);
      indexes.push(index);
    }
    if (!(sum > 0) || !indexes.length) return;
    const ratio = target / sum;
    for (const index of indexes) {
      const row = result.series[index];
      const value = toNumber(row?.total ?? row?.value) ?? 0;
      row.total = Math.max(0, value * ratio);
      if ('value' in row) row.value = row.total;
    }
  };

  const run = async () => {
    const result = window.__FODRINTH_CF_DOWNLOAD_V3_RESULT__;
    if (!result || known.length === 0) {
      window.__FODRINTH_CF_DOWNLOAD_PROJECTS_AUGMENTED__ = true;
      return;
    }

    let section = findSection();
    if (section) {
      await selectPeriod(section);
      await selectTotal(section);
      try { section.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}
      try { window.dispatchEvent(new Event('resize')); } catch (_) {}
    }

    let reading = { projects: [], debug: { reason: 'not-rendered' } };
    for (let attempt = 0; attempt < 30; attempt++) {
      section = findSection();
      if (section) reading = readChart(section);
      if (reading.projects.length > 0) break;
      await sleep(400);
      try { window.dispatchEvent(new Event('resize')); } catch (_) {}
    }

    const byId = new Map(reading.projects.map((project) => [String(project.id), project]));
    const normalized = known.map((project) => byId.get(project.id || project.name)).filter(Boolean);
    const complete = normalized.length === known.length && known.length > 0;
    if (complete) {
      const total = normalized.reduce((sum, project) => sum + Math.max(0, toNumber(project.period) ?? 0), 0);
      result.projects = normalized;
      result.current = total;
      scaleSeries(result, total);
    } else if (normalized.length > 0) {
      result.projects = normalized;
    } else {
      // Do not leak generic series names from the broad capture parser into the public project
      // table. If the exact project chart cannot be read, expose no fake period rows and let the
      // frontend mark the snapshot incomplete/retry it later.
      result.projects = [];
    }

    result.debug = {
      ...(result.debug ?? {}),
      knownProjects: known.length,
      matchedProjectPeriods: normalized.length,
      projectPeriodsComplete: complete,
      projectPeriodSource: complete ? 'downloads-per-project-bars' : null,
      projectBars: reading.debug,
    };
    window.__FODRINTH_CF_DOWNLOAD_PROJECTS_AUGMENTED__ = true;
  };

  void run().catch((error) => {
    const result = window.__FODRINTH_CF_DOWNLOAD_V3_RESULT__;
    if (result && typeof result === 'object') {
      result.projects = [];
      result.debug = { ...(result.debug ?? {}), projectBarReaderError: String(error?.stack || error?.message || error) };
    }
    window.__FODRINTH_CF_DOWNLOAD_PROJECTS_AUGMENTED__ = true;
  });
})();
