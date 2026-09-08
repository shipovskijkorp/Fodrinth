import { invoke } from '@tauri-apps/api/core'

import { getCurseForgeAuthorProjects } from '@/helpers/creator-projects.js'

export const CURSEFORGE_USD_PER_POINT = 0.05

export async function openCurseForgeAuthorPortal() {
	return await invoke('plugin:utils|curseforge_open_author_portal')
}

function finiteOrNull(value) {
	const number = Number(value)
	return Number.isFinite(number) ? number : null
}

function normalizeProject(project) {
	const id = String(project?.id ?? '').trim()
	const name = String(project?.name ?? project?.title ?? project?.slug ?? id).trim()
	if (!id && !name) return null
	return {
		id: id || name,
		name: name || id,
		icon: project?.icon ?? project?.icon_url ?? project?.logo?.thumbnailUrl ?? null,
		period: finiteOrNull(project?.period) ?? finiteOrNull(project?.current),
		current: finiteOrNull(project?.current) ?? finiteOrNull(project?.period),
		allTime:
			finiteOrNull(project?.allTime) ??
			finiteOrNull(project?.downloads) ??
			finiteOrNull(project?.downloadCount) ??
			finiteOrNull(project?.download_count),
		unique: finiteOrNull(project?.unique),
	}
}

function mergeDownloadProjects(downloadProjects, authorProjects) {
	const byId = new Map()
	const byName = new Map()

	for (const raw of downloadProjects ?? []) {
		const project = normalizeProject(raw)
		if (!project) continue
		byId.set(project.id, project)
		byName.set(project.name.toLowerCase(), project)
	}

	const merged = []
	const used = new Set()
	for (const raw of authorProjects ?? []) {
		const fallback = normalizeProject(raw)
		if (!fallback) continue
		const analytics = byId.get(fallback.id) ?? byName.get(fallback.name.toLowerCase()) ?? null
		const project = analytics
			? {
				...fallback,
				...analytics,
				icon: analytics.icon ?? fallback.icon,
				allTime: fallback.allTime ?? analytics.allTime,
			}
			: fallback
		merged.push(project)
		used.add(analytics?.id ?? fallback.id)
	}

	for (const project of byId.values()) {
		if (!used.has(project.id)) merged.push(project)
	}
	return merged
}

export async function getCurseForgeAuthorAnalytics(periodDays = 30) {
	const base = await invoke('plugin:utils|curseforge_get_author_analytics', {
		periodDays,
	})
	if (base?.needsLogin || base?.connected === false) return base

	let freshDownloads = null
	let downloadsError = ''
	try {
		freshDownloads = await invoke('plugin:utils|curseforge_get_author_downloads', {
			periodDays,
		})
	} catch (error) {
		downloadsError = error instanceof Error ? error.message : String(error)
	}

	let authorProjects = []
	try {
		const response = await getCurseForgeAuthorProjects()
		if (response?.needsLogin) {
			return {
				...base,
				connected: false,
				needsLogin: true,
				downloads: null,
				downloadsError,
			}
		}
		authorProjects = Array.isArray(response?.projects) ? response.projects : []
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		downloadsError = downloadsError ? `${downloadsError}; projects: ${message}` : `projects: ${message}`
	}

	const projects = mergeDownloadProjects(freshDownloads?.projects, authorProjects)
	const projectAllTimeValues = projects.map((project) => finiteOrNull(project.allTime)).filter((value) => value != null)
	const projectAllTime = projectAllTimeValues.length
		? projectAllTimeValues.reduce((total, value) => total + value, 0)
		: null

	const downloads = {
		current: finiteOrNull(freshDownloads?.current),
		previous: finiteOrNull(freshDownloads?.previous),
		allTime: projectAllTime ?? finiteOrNull(freshDownloads?.allTime),
		uniqueCurrent: finiteOrNull(freshDownloads?.uniqueCurrent),
		uniquePrevious: finiteOrNull(freshDownloads?.uniquePrevious),
		yesterday: finiteOrNull(freshDownloads?.yesterday),
		yesterdayChangePercent: finiteOrNull(freshDownloads?.yesterdayChangePercent),
		series: Array.isArray(freshDownloads?.series) ? freshDownloads.series : [],
		projects,
		debug: freshDownloads?.debug ?? null,
	}

	if (freshDownloads?.error) {
		downloadsError = downloadsError ? `${downloadsError}; ${freshDownloads.error}` : String(freshDownloads.error)
	}

	return {
		...base,
		connected: true,
		needsLogin: !!freshDownloads?.needsLogin,
		downloads,
		downloadsError: downloadsError || null,
	}
}
