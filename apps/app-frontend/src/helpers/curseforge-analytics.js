import { invoke } from '@tauri-apps/api/core'

import { getCurseForgeAuthorProjects } from '@/helpers/creator-projects.js'

export const CURSEFORGE_USD_PER_POINT = 0.05

export async function openCurseForgeAuthorPortal() {
	return await invoke('plugin:utils|curseforge_open_author_portal')
}

function finiteOrNull(value) {
	if (value == null || value === '') return null
	const number = Number(value)
	return Number.isFinite(number) ? number : null
}

function optionalNumber(value) {
	const number = finiteOrNull(value)
	return number == null ? undefined : number
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

function errorText(error) {
	return error instanceof Error ? error.message : String(error)
}

function hasDownloadPayload(downloads) {
	if (!downloads || typeof downloads !== 'object') return false
	return (
		finiteOrNull(downloads.current) != null ||
		finiteOrNull(downloads.previous) != null ||
		finiteOrNull(downloads.allTime) != null ||
		(downloads.series?.length ?? 0) > 0 ||
		(downloads.projects?.length ?? 0) > 0
	)
}

async function settle(promise) {
	try {
		return { value: await promise, error: '' }
	} catch (error) {
		return { value: null, error: errorText(error) }
	}
}

export async function getCurseForgeAuthorAnalytics(periodDays = 30) {
	// Rewards, downloads and projects have independent hidden WebViews/readers. Run them
	// concurrently so a slow or broken dashboard surface cannot serialize the whole refresh.
	const [baseResult, freshResult, projectsResult] = await Promise.all([
		settle(invoke('plugin:utils|curseforge_get_author_analytics', { periodDays })),
		settle(invoke('plugin:utils|curseforge_get_author_downloads', { periodDays })),
		settle(getCurseForgeAuthorProjects()),
	])

	const base = baseResult.value ?? {
		connected: false,
		needsLogin: false,
		rewardPoints: null,
		rewardBalanceUsd: null,
		earnings: [],
		withdrawals: [],
		downloads: null,
	}
	const baseError = baseResult.error
	const freshDownloads = freshResult.value
	let downloadsError = freshResult.error

	if (import.meta.env.DEV && freshDownloads?.debug) {
		console.info('[Fodrinth] CurseForge download analytics', freshDownloads.debug)
	}

	const projectResponse = projectsResult.value
	const projectsConnected = projectResponse?.connected !== false && !!projectResponse
	const projectsNeedLogin = !!projectResponse?.needsLogin
	const authorProjects = Array.isArray(projectResponse?.projects) ? projectResponse.projects : []
	if (projectsResult.error) {
		downloadsError = downloadsError
			? `${downloadsError}; projects: ${projectsResult.error}`
			: `projects: ${projectsResult.error}`
	} else if (projectResponse?.error && authorProjects.length === 0) {
		const message = String(projectResponse.error)
		downloadsError = downloadsError ? `${downloadsError}; projects: ${message}` : `projects: ${message}`
	}

	const freshDownloadsHealthy = hasDownloadPayload(freshDownloads) && !freshDownloads?.error
	const primaryDownloads = freshDownloadsHealthy ? freshDownloads : null
	const projects = mergeDownloadProjects(
		Array.isArray(freshDownloads?.projects) ? freshDownloads.projects : [],
		authorProjects,
	)
	const projectAllTimeValues = projects.map((project) => finiteOrNull(project.allTime)).filter((value) => value != null)
	const projectAllTime = projectAllTimeValues.length
		? projectAllTimeValues.reduce((total, value) => total + value, 0)
		: null

	const series = Array.isArray(freshDownloads?.series) ? freshDownloads.series : []

	const downloads = {
		current: optionalNumber(primaryDownloads?.current),
		previous: optionalNumber(primaryDownloads?.previous),
		allTime: optionalNumber(projectAllTime ?? primaryDownloads?.allTime),
		uniqueCurrent: optionalNumber(primaryDownloads?.uniqueCurrent),
		uniquePrevious: optionalNumber(primaryDownloads?.uniquePrevious),
		yesterday: optionalNumber(primaryDownloads?.yesterday),
		yesterdayChangePercent: optionalNumber(primaryDownloads?.yesterdayChangePercent),
		series,
		projects,
		debug: freshDownloads?.debug ?? null,
	}

	if (freshDownloads?.error) {
		downloadsError = downloadsError ? `${downloadsError}; ${String(freshDownloads.error)}` : String(freshDownloads.error)
	}

	const hasDownloads = hasDownloadPayload(downloads)
	const hasRewards =
		(base?.earnings?.length ?? 0) > 0 ||
		(base?.withdrawals?.length ?? 0) > 0 ||
		finiteOrNull(base?.rewardPoints) != null ||
		finiteOrNull(base?.rewardBalanceUsd) != null
	const connected =
		hasDownloads ||
		authorProjects.length > 0 ||
		projectsConnected ||
		hasRewards ||
		base?.connected === true ||
		freshDownloads?.connected === true
	const needsLogin = !connected && (
		!!base?.needsLogin ||
		!!freshDownloads?.needsLogin ||
		projectsNeedLogin
	)

	return {
		...base,
		connected,
		needsLogin,
		rewardPoints: optionalNumber(base?.rewardPoints),
		rewardBalanceUsd: optionalNumber(base?.rewardBalanceUsd),
		earnings: Array.isArray(base?.earnings) ? base.earnings : [],
		withdrawals: Array.isArray(base?.withdrawals) ? base.withdrawals : [],
		downloads,
		downloadsError: downloadsError || null,
		baseError: baseError || null,
	}
}
