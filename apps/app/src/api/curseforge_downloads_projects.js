(() => {
  window.__FODRINTH_CF_DOWNLOAD_PROJECTS_AUGMENTED__ = false;

  const knownProjects = Array.isArray(__KNOWN_PROJECTS__) ? __KNOWN_PROJECTS__ : [];
  const periodDays = Math.max(1, Math.min(365, Number('__PERIOD_DAYS__') || 30));
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
    if (!text || !/^[+-]?\d+(?:\.\d+)?$/.test(text)) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const colorKey = (value) => String(value || '').toLowerCase().replace(/\s+/g, '');

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

  const findPerProjectSection = () => {
    const nodes = Array.from(document.querySelectorAll('body *')).filter((element) => {
      if (element.children.length > 5) return false;
      const text = norm(element.textContent);
      return /downloads over time/i.test(text) && /per project/i.test(text);
    });
    for (const heading of nodes) {
      let node = heading;
      for (let depth = 0; depth < 10 && node; depth++, node = node.parentElement) {
        if (node.querySelector?.('svg')) return node;
      }
    }
    return null;
  };

  const geometryInfo = (element) => {
    try {
      const length = element.getTotalLength?.();
      const box = element.getBBox?.();
      const style = getComputedStyle(element);
      const stroke = colorKey(style.stroke || element.getAttribute?.('stroke'));
      if (!Number.isFinite(length) || !box || length < 45 || box.width < 70 || box.height < 1) return null;
      if (!stroke || stroke === 'none' || stroke.includes('rgba(0,0,0,0)') || stroke === 'transparent') return null;
      return { element, length, box, stroke };
    } catch (_) {
      return null;
    }
  };

  const fitYAxis = (svg, plotBox) => {
    const ticks = Array.from(svg.querySelectorAll('text')).map((element) => {
      const value = number(element.textContent);
      if (value == null) return null;
      try {
        const box = element.getBBox();
        const y = box.y + box.height / 2;
        if (box.x > plotBox.x + Math.max(40, plotBox.width * 0.1)) return null;
        return { y, value };
      } catch (_) {
        return null;
      }
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

  const sampleLine = (info, plotBox, yToValue) => {
    const buckets = Array.from({ length: periodDays }, () => []);
    const steps = Math.max(900, periodDays * 18);
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
      const y = ys.reduce((sum, value) => sum + value, 0) / ys.length;
      return yToValue ? yToValue(y) : null;
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
    return values.map((value) => Math.max(0, Number(value) || 0));
  };

  const candidateColors = (element) => {
    const colors = new Set();
    let root = element;
    for (let depth = 0; depth < 5 && root; depth++, root = root.parentElement) {
      const candidates = [root, ...Array.from(root.querySelectorAll('span,div,svg,circle,rect,path')).slice(0, 50)];
      for (const candidate of candidates) {
        try {
          const rect = candidate.getBoundingClientRect();
          if (rect.width > 40 || rect.height > 40 || rect.width < 2 || rect.height < 2) continue;
          const style = getComputedStyle(candidate);
          for (const color of [style.backgroundColor, style.borderTopColor, style.borderLeftColor, style.color, style.fill, style.stroke]) {
            const normalized = colorKey(color);
            if (normalized && normalized !== 'transparent' && !normalized.includes('rgba(0,0,0,0)')) colors.add(normalized);
          }
        } catch (_) {}
      }
    }
    return colors;
  };

  const renderedPeriods = () => {
    const section = findPerProjectSection();
    if (!section || known.length === 0) return { projects: [], lines: 0, mapped: 0 };
    const svgs = Array.from(section.querySelectorAll('svg'));
    let best = null;
    for (const svg of svgs) {
      const geometries = Array.from(svg.querySelectorAll('path[d],polyline[points]')).map(geometryInfo).filter(Boolean);
      if (!geometries.length) continue;
      const maxWidth = Math.max(...geometries.map((item) => item.box.width));
      const wide = geometries.filter((item) => item.box.width >= Math.max(70, maxWidth * 0.35));
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
      const score = plotBox.width * 4 + lines.length * 400 + plotBox.height;
      if (!best || score > best.score) best = { svg, lines, plotBox, score };
    }
    if (!best) return { projects: [], lines: 0, mapped: 0 };

    const lineByColor = new Map(best.lines.map((line) => [line.stroke, line]));
    const leaves = Array.from(section.querySelectorAll('*')).filter((element) => element.children.length === 0);
    const legend = [];
    for (const project of known) {
      const projectKey = key(project.name);
      if (!projectKey) continue;
      const element = leaves.find((leaf) => {
        const text = key(leaf.textContent);
        if (!text) return false;
        return text === projectKey || (Math.min(text.length, projectKey.length) >= 10 && (text.startsWith(projectKey) || projectKey.startsWith(text)));
      });
      if (!element) continue;
      const colors = candidateColors(element);
      const color = [...colors].find((candidate) => lineByColor.has(candidate)) ?? null;
      legend.push({ project, element, color });
    }

    const yToValue = fitYAxis(best.svg, best.plotBox);
    const mapped = [];
    const usedColors = new Set();
    for (const entry of legend) {
      if (!entry.color || usedColors.has(entry.color)) continue;
      const line = lineByColor.get(entry.color);
      if (!line) continue;
      const values = sampleLine(line, best.plotBox, yToValue);
      const period = values.reduce((sum, value) => sum + value, 0);
      if (!(period >= 0)) continue;
      mapped.push({ id: entry.project.id || entry.project.name, name: entry.project.name, period, current: period });
      usedColors.add(entry.color);
    }

    if (mapped.length === 0 && legend.length === best.lines.length && yToValue) {
      for (let index = 0; index < legend.length; index++) {
        const values = sampleLine(best.lines[index], best.plotBox, yToValue);
        const period = values.reduce((sum, value) => sum + value, 0);
        mapped.push({
          id: legend[index].project.id || legend[index].project.name,
          name: legend[index].project.name,
          period,
          current: period,
        });
      }
    }

    return { projects: mapped, lines: best.lines.length, mapped: mapped.length };
  };

  const run = async () => {
    for (let attempt = 0; attempt < 900; attempt++) {
      const result = window.__FODRINTH_CF_DOWNLOAD_V3_RESULT__;
      if (result != null) {
        const rawProjects = Array.isArray(result.projects) ? result.projects : [];
        const exact = new Map();
        for (const raw of rawProjects) {
          const project = matchKnown(raw?.id, raw?.name);
          if (!project) continue;
          const period = number(raw?.period ?? raw?.current);
          if (period == null) continue;
          exact.set(project.id || project.name, {
            id: project.id || project.name,
            name: project.name,
            period,
            current: period,
          });
        }

        const rendered = renderedPeriods();
        for (const project of rendered.projects) {
          const id = project.id || project.name;
          if (!exact.has(id)) exact.set(id, project);
        }

        const projects = Array.from(exact.values());
        const target = number(result.current);
        const sum = projects.reduce((total, project) => total + Math.max(0, number(project.period) ?? 0), 0);
        if (target != null && target >= 0 && sum > 0 && rendered.mapped === rendered.lines && rendered.lines > 0) {
          const ratio = target / sum;
          for (const project of projects) {
            project.period = Math.max(0, project.period * ratio);
            project.current = project.period;
          }
        }

        result.projects = projects;
        result.debug = {
          ...(result.debug ?? {}),
          knownProjects: known.length,
          matchedProjectPeriods: projects.length,
          renderedProjectLines: rendered.lines,
          renderedProjectsMapped: rendered.mapped,
        };
        window.__FODRINTH_CF_DOWNLOAD_PROJECTS_AUGMENTED__ = true;
        return;
      }
      await sleep(100);
    }
    window.__FODRINTH_CF_DOWNLOAD_PROJECTS_AUGMENTED__ = true;
  };

  void run();
})();
