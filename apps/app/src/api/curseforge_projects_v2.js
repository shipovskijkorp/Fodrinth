(() => {
  window.__FODRINTH_CF_PROJECTS_V2_RESULT__ = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const toNumber = (value) => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value == null) return null;
    const text = String(value).replace(/\s/g, '').replace(/,/g, '');
    const match = text.match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const statusLabel = (value) => {
    const raw = norm(value);
    if (!raw) return null;
    const numeric = Number(raw);
    const known = {
      1: 'New',
      2: 'Changes required',
      3: 'Under soft review',
      4: 'Approved',
      5: 'Rejected',
      6: 'Changes made',
      7: 'Inactive',
      8: 'Abandoned',
      9: 'Deleted',
      10: 'Under review',
    };
    return Number.isInteger(numeric) && known[numeric] ? known[numeric] : raw;
  };

  const projects = new Map();
  const keep = (candidate) => {
    if (!candidate) return;
    const id = norm(candidate.id);
    const name = norm(candidate.name);
    if (!id || !name) return;
    const old = projects.get(id) || {};
    projects.set(id, {
      id,
      name: name || old.name || `Project ${id}`,
      slug: norm(candidate.slug) || old.slug || null,
      summary: norm(candidate.summary) || old.summary || '',
      description: norm(candidate.description) || old.description || '',
      icon: norm(candidate.icon) || old.icon || null,
      downloads: toNumber(candidate.downloads) ?? old.downloads ?? null,
      status: statusLabel(candidate.status) || old.status || null,
      sourceUrl: norm(candidate.sourceUrl) || old.sourceUrl || null,
      issuesUrl: norm(candidate.issuesUrl) || old.issuesUrl || null,
      license: norm(candidate.license) || old.license || null,
      dateCreated: norm(candidate.dateCreated) || old.dateCreated || null,
      dateModified: norm(candidate.dateModified) || old.dateModified || null,
      url: norm(candidate.url) || old.url || `https://authors.curseforge.com/#/projects/${encodeURIComponent(id)}`,
    });
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
    const id = explicitId || readString(value, ['id']);
    const name = readString(value, ['projectName', 'project_name', 'name', 'title']);
    const slug = readString(value, ['slug', 'projectSlug', 'project_slug']);
    const summary = readString(value, ['summary', 'shortDescription', 'short_description', 'tagline']);
    const description = readString(value, ['description', 'projectDescription', 'project_description']);
    const downloads =
      toNumber(value.downloadCount) ?? toNumber(value.download_count) ?? toNumber(value.downloads) ??
      toNumber(value.totalDownloads) ?? toNumber(value.total_downloads);
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

    for (const [key, child] of Object.entries(value)) {
      inspect(child, path ? `${path}.${key}` : key, depth + 1);
    }
  };

  const captures = () => (window.__FODRINTH_CF_CAPTURES__ || [])
    .map((entry) => {
      try { return { url: String(entry?.url || ''), value: JSON.parse(entry?.text || '') }; }
      catch (_) { return null; }
    })
    .filter(Boolean);

  const readDom = () => {
    const links = Array.from(document.querySelectorAll('a[href]'));
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/(?:#\/|\/)projects\/(\d+)/i);
      if (!match) continue;
      const id = match[1];
      const card = link.closest('tr,[role="row"],article,li,[class*="card" i],[class*="paper" i]') || link.parentElement;
      if (!card) continue;
      const heading = card.querySelector?.('h1,h2,h3,h4,[class*="title" i],[class*="name" i]');
      const image = card.querySelector?.('img[src]');
      let name = norm(heading?.textContent || image?.getAttribute?.('alt') || link.getAttribute('aria-label') || link.textContent);
      if (!name || name.length > 180 || /^(edit|manage|files|project|view)$/i.test(name)) continue;
      const text = norm(card.innerText || card.textContent || '');
      const downloadsMatch = text.match(/([\d,.]+)\s+downloads?/i);
      const statusMatch = text.match(/\b(New|Approved|Rejected|Inactive|Abandoned|Deleted|Under review|Under soft review|Changes required|Changes made)\b/i);
      keep({
        id,
        name,
        icon: image?.src || '',
        downloads: downloadsMatch ? toNumber(downloadsMatch[1]) : null,
        status: statusMatch ? statusMatch[1] : null,
        url: new URL(href, location.href).href,
      });
    }
  };

  const loggedOut = () => {
    const body = norm(document.body?.innerText);
    return /sign in|log in|continue with google/i.test(body) && !/projects|dashboard|statistics|rewards/i.test(body);
  };

  const run = async () => {
    let stableRounds = 0;
    let lastSize = -1;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (loggedOut()) {
        window.__FODRINTH_CF_PROJECTS_V2_RESULT__ = { connected: false, needsLogin: true, projects: [] };
        return;
      }

      for (const capture of captures()) inspect(capture.value, capture.url, 0);
      readDom();

      if (projects.size > 0 && projects.size === lastSize) stableRounds += 1;
      else stableRounds = 0;
      lastSize = projects.size;
      if (projects.size > 0 && stableRounds >= 3) break;
      await sleep(300);
    }

    window.__FODRINTH_CF_PROJECTS_V2_RESULT__ = {
      connected: true,
      needsLogin: false,
      projects: Array.from(projects.values()).sort((a, b) => a.name.localeCompare(b.name)),
      capturesSeen: captures().length,
    };
  };

  run().catch((error) => {
    window.__FODRINTH_CF_PROJECTS_V2_RESULT__ = {
      connected: true,
      needsLogin: false,
      projects: [],
      error: String(error?.stack || error?.message || error),
    };
  });

  return true;
})();
