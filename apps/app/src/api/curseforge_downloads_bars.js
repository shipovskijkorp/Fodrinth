(() => {
  window.__FODRINTH_CF_DOWNLOAD_PROJECTS_AUGMENTED__ = false;

  const projects = Array.isArray(__KNOWN_PROJECTS__) ? __KNOWN_PROJECTS__ : [];
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
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const known = projects.map((project) => ({
    id: norm(project?.id),
    name: norm(project?.name ?? project?.title ?? project?.slug ?? project?.id),
    allTime: toNumber(project?.allTime ?? project?.downloads ?? project?.downloadCount ?? project?.download_count),
  })).filter((project) => project.id || project.name);

  const periodAliases = periodDays === 7
    ? ['last 7 days', '7 days', '7d']
    : periodDays === 30
      ? ['last 30 days', '30 days', '30d']
      : periodDays === 90
        ? ['last 90 days', '90 days', '90d', 'last 3 months', '3 months']
        : [`last ${periodDays} days`, `${periodDays} days`, `${periodDays}d`];

  const visible = (element) => {
    if (!element) return false;
    try {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    } catch (_) {
      return true;
    }
  };

  const matchLabel = (candidate, wanted) => {
    const a = key(candidate);
    const b = key(wanted);
    if (!a || !b) return false;
    if (a === b) return true;
    const shared = a.startsWith(b) ? b.length : b.startsWith(a) ? a.length : 0;
    return shared >= 8;
  };

  const findPerProjectSection = () => {
    const nodes = Array.from(document.querySelectorAll('body *')).filter((element) => {
      if (element.children.length > 5) return false;
      const text = norm(element.textContent);
      return /downloads over time/i.test(text) && /per project/i.test(text);
    });
    for (const heading of nodes) {
      let node = heading;
      for (let depth = 0; depth < 12 && node; depth++, node = node.parentElement) {
        if (node.querySelector?.('svg') && node.querySelector?.('select,[role="combobox"],button,[role="button"]')) return node;
      }
    }
    return null;
  };

  const findProjectNativeSelect = (section) => {
    if (!section) return null;
    for (const select of section.querySelectorAll('select')) {
      const labels = Array.from(select.options || []).map((option) => norm(option.textContent));
      const matchesProjects = known.filter((project) => labels.some((label) => matchLabel(label, project.name))).length;
      if (labels.some((label) => /all projects/i.test(label)) || matchesProjects >= Math.min(2, known.length)) return select;
    }
    return null;
  };

  const findProjectCustomPicker = (section) => {
    if (!section) return null;
    const controls = Array.from(section.querySelectorAll('[role="combobox"],button,[role="button"]')).filter(visible);
    let best = null;
    let bestScore = -1;
    for (const control of controls) {
      const label = norm(control.textContent || control.getAttribute('aria-label'));
      let score = 0;
      if (/all projects/i.test(label)) score += 100;
      if (known.some((project) => matchLabel(label, project.name))) score += 80;
      if (control.getAttribute('role') === 'combobox') score += 40;
      if (/listbox|menu/i.test(control.getAttribute('aria-haspopup') || '')) score += 20;
      const rect = control.getBoundingClientRect();
      if (rect.width > 120 && rect.width < 500) score += 10;
      if (score > bestScore) {
        best = control;
        bestScore = score;
      }
    }
    return bestScore >= 40 ? best : null;
  };

  const selectProject = async (section, projectName) => {
    const native = findProjectNativeSelect(section);
    if (native) {
      const option = Array.from(native.options || []).find((item) => matchLabel(item.textContent, projectName));
      if (!option) return false;
      if (native.value !== option.value) {
        native.value = option.value;
        native.dispatchEvent(new Event('input', { bubbles: true }));
        native.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await sleep(650);
      return true;
    }

    const picker = findProjectCustomPicker(section);
    if (!picker) return false;
    const current = norm(picker.textContent || picker.getAttribute('aria-label'));
    if (matchLabel(current, projectName)) return true;
    picker.click();
    await sleep(180);
    const candidates = Array.from(document.querySelectorAll('[role="option"],[role="menuitem"],li,button')).filter(visible);
    const option = candidates.find((element) => matchLabel(element.textContent, projectName));
    if (!option) {
      try { document.body.click(); } catch (_) {}
      return false;
    }
    option.click();
    await sleep(700);
    return true;
  };

  const restoreAllProjects = async (section) => {
    const native = findProjectNativeSelect(section);
    if (native) {
      const option = Array.from(native.options || []).find((item) => /all projects/i.test(norm(item.textContent)));
      if (option && native.value !== option.value) {
        native.value = option.value;
        native.dispatchEvent(new Event('input', { bubbles: true }));
        native.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(300);
      }
      return;
    }
    const picker = findProjectCustomPicker(section);
    if (!picker || /all projects/i.test(norm(picker.textContent))) return;
    picker.click();
    await sleep(150);
    const option = Array.from(document.querySelectorAll('[role="option"],[role="menuitem"],li,button'))
      .filter(visible)
      .find((element) => /all projects/i.test(norm(element.textContent)));
    if (option) option.click();
  };

  const selectPeriod = async (section) => {
    if (!section) return false;
    for (const select of section.querySelectorAll('select')) {
      if (select === findProjectNativeSelect(section)) continue;
      const option = Array.from(select.options || []).find((item) => periodAliases.includes(norm(item.textContent).toLowerCase()));
      if (!option) continue;
      if (select.value !== option.value) {
        select.value = option.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(periodDays === 90 ? 1800 : 1100);
      }
      return true;
    }

    let controls = Array.from(section.querySelectorAll('button,[role="button"],[role="combobox"]')).filter(visible);
    const direct = controls.find((element) => periodAliases.includes(norm(element.textContent).toLowerCase()));
    if (direct) {
      direct.click();
      await sleep(periodDays === 90 ? 1800 : 1100);
      return true;
    }
    const picker = controls.find((element) => /last \d+ days|\b\d+ days\b|\b\d+d\b|months?/i.test(norm(element.textContent)));
    if (!picker) return false;
    picker.click();
    await sleep(180);
    const option = Array.from(document.querySelectorAll('[role="option"],[role="menuitem"],li,button'))
      .filter(visible)
      .find((element) => periodAliases.includes(norm(element.textContent).toLowerCase()));
    if (!option) return false;
    option.click();
    await sleep(periodDays === 90 ? 1800 : 1100);
    return true;
  };

  const selectTotal = async (section) => {
    if (!section) return;
    const total = Array.from(section.querySelectorAll('button,[role="button"],[role="tab"]'))
      .find((element) => /^total$/i.test(norm(element.textContent)));
    if (!total) return;
    const selected = total.getAttribute('aria-selected') === 'true'
      || total.getAttribute('aria-pressed') === 'true'
      || /active|selected/i.test(total.className || '');
    if (!selected) {
      total.click();
      await sleep(650);
    }
  };

  const transformedBox = (element) => {
    try {
      const box = element.getBBox();
      const matrix = element.getCTM();
      const svg = element.ownerSVGElement;
      if (!matrix || !svg) return box;
      const corners = [
        [box.x, box.y], [box.x + box.width, box.y],
        [box.x, box.y + box.height], [box.x + box.width, box.y + box.height],
      ].map(([x, y]) => {
        const point = svg.createSVGPoint();
        point.x = x;
        point.y = y;
        return point.matrixTransform(matrix);
      });
      const xs = corners.map((point) => point.x);
      const ys = corners.map((point) => point.y);
      return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    } catch (_) {
      return null;
    }
  };

  const transformedPoint = (element, point) => {
    try {
      const matrix = element.getCTM();
      const svg = element.ownerSVGElement;
      if (!matrix || !svg) return point;
      const value = svg.createSVGPoint();
      value.x = point.x;
      value.y = point.y;
      return value.matrixTransform(matrix);
    } catch (_) {
      return point;
    }
  };

  const lineInfo = (element) => {
    try {
      const length = element.getTotalLength?.();
      const box = transformedBox(element);
      if (!Number.isFinite(length) || !box || length < 80 || box.width < 90) return null;
      const style = getComputedStyle(element);
      const stroke = String(style.stroke || element.getAttribute('stroke') || '').toLowerCase();
      const fill = String(style.fill || element.getAttribute('fill') || '').toLowerCase();
      if (!stroke || stroke === 'none' || stroke === 'transparent' || stroke.includes('rgba(0, 0, 0, 0)')) return null;
      if (fill && fill !== 'none' && !fill.includes('rgba(0, 0, 0, 0)')) return null;
      return { element, length, box, stroke };
    } catch (_) {
      return null;
    }
  };

  const fitYAxis = (svg, plotBox) => {
    const ticks = Array.from(svg.querySelectorAll('text')).map((element) => {
      const value = toNumber(element.textContent);
      if (value == null) return null;
      const box = transformedBox(element);
      if (!box) return null;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      if (x > plotBox.x - 4) return null;
      if (y < plotBox.y - 80 || y > plotBox.y + plotBox.height + 80) return null;
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

  const sampleCandidate = (candidate, yToValue) => {
    const dense = [];
    const steps = Math.max(900, periodDays * 22);
    for (let index = 0; index <= steps; index++) {
      try {
        const local = candidate.element.getPointAtLength((candidate.length * index) / steps);
        dense.push(transformedPoint(candidate.element, local));
      } catch (_) {}
    }
    if (dense.length < 10) return null;
    dense.sort((a, b) => a.x - b.x);
    const minX = dense[0].x;
    const maxX = dense[dense.length - 1].x;
    if (!(maxX > minX)) return null;
    const values = [];
    let cursor = 0;
    for (let day = 0; day < periodDays; day++) {
      const x = periodDays === 1 ? (minX + maxX) / 2 : minX + ((maxX - minX) * day) / (periodDays - 1);
      while (cursor + 1 < dense.length && Math.abs(dense[cursor + 1].x - x) <= Math.abs(dense[cursor].x - x)) cursor++;
      values.push(Math.max(0, Math.round(yToValue(dense[cursor].y))));
    }
    return values;
  };

  const readSelectedProjectSeries = (section) => {
    if (!section) return null;
    let best = null;
    for (const svg of section.querySelectorAll('svg')) {
      const lines = Array.from(svg.querySelectorAll('path[d],polyline[points]')).map(lineInfo).filter(Boolean);
      if (!lines.length) continue;
      for (const line of lines) {
        const yToValue = fitYAxis(svg, line.box);
        if (!yToValue) continue;
        const values = sampleCandidate(line, yToValue);
        if (!values) continue;
        const total = values.reduce((sum, value) => sum + value, 0);
        const score = line.box.width * 10 + line.length + total * 0.01;
        if (!best || score > best.score) best = { values, total, score, lineCount: lines.length };
      }
    }
    return best;
  };

  const waitForSeries = async (section, previousSignature = '') => {
    let latest = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { window.dispatchEvent(new Event('resize')); } catch (_) {}
      latest = readSelectedProjectSeries(section);
      if (latest) {
        const signature = latest.values.join(',');
        if (!previousSignature || signature !== previousSignature || attempt >= 4) return { ...latest, signature };
      }
      await sleep(250);
    }
    return latest ? { ...latest, signature: latest.values.join(',') } : null;
  };

  const dateRows = (totals) => {
    const end = new Date();
    end.setHours(12, 0, 0, 0);
    const start = new Date(end.getTime() - (periodDays - 1) * DAY);
    return totals.map((total, index) => {
      const date = new Date(start.getTime() + index * DAY);
      return { date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`, total };
    });
  };

  const run = async () => {
    const result = window.__FODRINTH_CF_DOWNLOAD_V3_RESULT__;
    if (!result || known.length === 0) {
      window.__FODRINTH_CF_DOWNLOAD_PROJECTS_AUGMENTED__ = true;
      return;
    }

    let section = findPerProjectSection();
    if (!section) {
      result.projects = [];
      result.debug = { ...(result.debug ?? {}), projectPeriodSource: null, projectPeriodError: 'per-project-chart-not-found' };
      window.__FODRINTH_CF_DOWNLOAD_PROJECTS_AUGMENTED__ = true;
      return;
    }

    try { section.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}
    try { window.dispatchEvent(new Event('resize')); } catch (_) {}
    await selectPeriod(section);
    await selectTotal(section);
    await sleep(450);

    const mapped = [];
    const aggregate = Array(periodDays).fill(0);
    const failures = [];
    let previousSignature = '';

    for (const project of known) {
      section = findPerProjectSection() ?? section;
      const selected = await selectProject(section, project.name);
      if (!selected) {
        failures.push({ project: project.name, reason: 'project-option-not-found' });
        continue;
      }
      const reading = await waitForSeries(section, previousSignature);
      if (!reading) {
        failures.push({ project: project.name, reason: 'series-not-readable' });
        continue;
      }
      previousSignature = reading.signature;
      const total = reading.total;
      if (project.allTime != null && total > project.allTime + Math.max(2, project.allTime * 0.03)) {
        failures.push({ project: project.name, reason: `period-exceeds-lifetime:${total}>${project.allTime}` });
        continue;
      }
      mapped.push({ id: project.id || project.name, name: project.name, period: total, current: total });
      for (let index = 0; index < aggregate.length; index++) aggregate[index] += reading.values[index] ?? 0;
    }

    await restoreAllProjects(section);

    const complete = mapped.length === known.length;
    if (complete) {
      const total = mapped.reduce((sum, project) => sum + Math.max(0, toNumber(project.period) ?? 0), 0);
      result.projects = mapped;
      result.current = total;
      result.series = dateRows(aggregate);
      if (periodDays === 90) result.previous = null;
    } else {
      result.projects = mapped;
    }

    result.debug = {
      ...(result.debug ?? {}),
      knownProjects: known.length,
      matchedProjectPeriods: mapped.length,
      projectPeriodsComplete: complete,
      projectPeriodSource: complete ? 'per-project-selector-series' : null,
      projectPeriodFailures: failures,
      aggregateSeriesPoints: complete ? aggregate.length : 0,
    };
    window.__FODRINTH_CF_DOWNLOAD_PROJECTS_AUGMENTED__ = true;
  };

  void run().catch((error) => {
    const result = window.__FODRINTH_CF_DOWNLOAD_V3_RESULT__;
    if (result && typeof result === 'object') {
      result.projects = [];
      result.debug = { ...(result.debug ?? {}), projectPeriodReaderError: String(error?.stack || error?.message || error) };
    }
    window.__FODRINTH_CF_DOWNLOAD_PROJECTS_AUGMENTED__ = true;
  });
})();
