import { invoke } from '@tauri-apps/api/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

import { config } from '@/config'
import { getCurseForgeAuthorAnalytics } from '@/helpers/curseforge-analytics.js'
import { get as getModrinthCredentials } from '@/helpers/mr_auth.ts'
import { get_user_projects } from '@/helpers/users'

export const CREATOR_ANALYTICS_CACHE_UPDATED_EVENT = 'fodrinth:creator-analytics-cache-updated'

const STORAGE_KEY = 'fodrinth.creator.analytics-cache.v2'
const CACHE_VERSION = 2
const DEFAULT_PERIODS = [30, 90, 7]
const FRESH_FOR_MS = 15 * 60 * 1000
const PERIODIC_CHECK_MS = 5 * 60 * 1000
const LOW_LOAD_INTERACTION_MS = 12 * 1000
const STARTUP_DELAY_MS = 1200
const RETRY_DELAY_MS = 45 * 1000
const CURSEFORGE_TIMEOUT_MS = 60 * 1000

const refreshes = new Map()
let curseForgeQueue = Promise.resolve()
let backgroundStarted = false
let periodicTimer = null
let lastInteractionAt = Date.now()
let startupWarmupFinished = false

function blankRoot() {
	return {
		version: CACHE_VERSION,
		periods: {},
	}
}

function readRoot() {
	try {
		const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
		if (!parsed || parsed.version !== CACHE_VERSION || typeof parsed.periods !== 'object') return blankRoot()
		return parsed
	} catch {
		return blankRoot()
	}
}

function writeRoot(root) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(root))
	} catch (error) {
		console.warn('[Fodrinth] Could not persist creator analytics cache', error)
	}
}

function normalizePeriod(periodDays) {
	const days = Number(periodDays)
	return Number.isFinite(days) ? Math.max(1, Math.min(365, Math.round(days))) : 30
}

function clone(value) {
	if (value == null) return value
	try {
		return structuredClone(value)
	} catch {
		try {
			return JSON.parse(JSON.stringify(value))
		} catch {
			return value
		}
	}
}

function emptySnapshot(periodDays) {
	return {
		periodDays,
		updatedAt: null,
		modrinth: null,
		curseforge: null,
	}
}

export function getCreatorAnalyticsSnapshot(periodDays = 30) {
	const days = normalizePeriod(periodDays)
	const root = readRoot()
	const cached = root.periods[String(days)]
	if (!cached) return emptySnapshot(days)
	return clone({
		periodDays: days,
		updatedAt: cached.updatedAt ?? null,
		modrinth: cached.modrinth ?? null,
		curseforge: cached.curseforge ?? null,
	})
}

function persistPeriod(periodDays, patch) {
	const days = normalizePeriod(periodDays)
	const root = readRoot()
	const old = root.periods[String(days)] ?? {}
	const next = {
		...old,
		...patch,
		periodDays: days,
		updatedAt: Date.now(),
	}
	root.periods[String(days)] = next
	writeRoot(root)
	window.dispatchEvent(
		new CustomEvent(CREATOR_ANALYTICS_CACHE_UPDATED_EVENT, {
			detail: { periodDays: days, updatedAt: next.updatedAt },
		}),
	)
	return clone(next)
}

function providerAge(provider) {
	const updatedAt = Number(provider?.updatedAt)
	return Number.isFinite(updatedAt) ? Math.max(0, Date.now() - updatedAt) : Infinity
}

function isProviderFresh(provider) {
	return !!provider && providerAge(provider) < FRESH_FOR_MS
}

function isPeriodFresh(snapshot) {
	return isProviderFresh(snapshot?.modrinth) && isProviderFresh(snapshot?.curseforge)
}

async function cacheMatchesCurrentModrinthUser(snapshot) {
	try {
		const credentials = await getModrinthCredentials()
		const currentUserId = credentials?.user_id ? String(credentials.user_id) : null
		const cachedUserId = snapshot?.modrinth?.authenticated && snapshot?.modrinth?.userId
			? String(snapshot.modrinth.userId)
			: null
		return currentUserId === cachedUserId
	} catch {
		return true
	}
}

async function fetchJson(url, session, options = {}) {
	const response = await tauriFetch(url, {
		...options,
		headers: {
			Accept: 'application/json',
			...(options.body ? { 'Content-Type': 'application/json' } : {}),
			Authorization: `Bearer ${session}`,
			...(options.headers ?? {}),
		},
	})
	if (!response.ok) {
		let detail = ''
		try {
			const body = await response.text()
			detail = body ? `: ${body.slice(0, 400)}` : ''
		} catch {}
		throw new Error(`HTTP ${response.status} ${response.statusText}${detail}`)
	}
	if (response.status === 204 || response.status === 205) return null
	return await response.json()
}

function normalizePayoutBalance(balance) {
	if (!balance || typeof balance !== 'object') return balance ?? null
	return {
		...balance,
		available: Number(balance.available) || 0,
		withdrawn_lifetime: Number(balance.withdrawn_lifetime) || 0,
		withdrawn_ytd: Number(balance.withdrawn_ytd) || 0,
		pending: Number(balance.pending) || 0,
		dates: Object.fromEntries(
			Object.entries(balance.dates ?? {}).map(([date, amount]) => [date, Number(amount) || 0]),
		),
	}
}

function normalizePayoutHistory(history) {
	return (Array.isArray(history) ? history : []).map((transaction) => ({
		...transaction,
		amount: Number(transaction?.amount) || 0,
		...(transaction?.fee == null ? {} : { fee: Number(transaction.fee) || 0 }),
	}))
}

async function fetchModrinthAnalytics(periodDays) {
	const attemptedAt = Date.now()
	const credentials = await getModrinthCredentials()
	if (!credentials?.user_id || !credentials?.session) {
		return {
			updatedAt: attemptedAt,
			lastAttemptAt: attemptedAt,
			authenticated: false,
			userId: null,
			projects: [],
			analyticsResponse: null,
			payoutBalance: null,
			payoutHistory: [],
			error: null,
		}
	}

	const projects = await get_user_projects(credentials.user_id)
	const projectIds = projects.map((project) => project?.id).filter(Boolean)
	let analyticsResponse = null
	let payoutBalance = null
	let payoutHistory = []
	let analyticsError = null
	let payoutError = null

	if (projectIds.length > 0) {
		const end = new Date()
		const start = new Date(end.getTime() - periodDays * 2 * 24 * 60 * 60 * 1000)
		const request = {
			time_range: {
				start: start.toISOString(),
				end: end.toISOString(),
				resolution: { slices: periodDays * 2 },
			},
			project_ids: projectIds,
			return_metrics: {
				project_downloads: { bucket_by: ['project_id'] },
				project_revenue: { bucket_by: ['project_id'] },
			},
		}

		const [analytics, balance, history] = await Promise.allSettled([
			fetchJson(`${config.labrinthBaseUrl}/v3/analytics`, credentials.session, {
				method: 'POST',
				body: JSON.stringify(request),
			}),
			fetchJson(`${config.labrinthBaseUrl}/v3/payout/balance`, credentials.session),
			fetchJson(`${config.labrinthBaseUrl}/v3/payout/history`, credentials.session),
		])

		if (analytics.status === 'fulfilled') analyticsResponse = analytics.value
		else analyticsError = analytics.reason
		if (balance.status === 'fulfilled') payoutBalance = normalizePayoutBalance(balance.value)
		else payoutError = balance.reason
		if (history.status === 'fulfilled') payoutHistory = normalizePayoutHistory(history.value)
		else payoutError = payoutError ?? history.reason
	}

	if (analyticsError) throw analyticsError

	return {
		updatedAt: Date.now(),
		lastAttemptAt: attemptedAt,
		authenticated: true,
		userId: credentials.user_id,
		projects,
		analyticsResponse,
		payoutBalance,
		payoutHistory,
		error: payoutError ? `Payout data: ${payoutError instanceof Error ? payoutError.message : String(payoutError)}` : null,
	}
}

function withTimeout(promise, timeoutMs, label) {
	let timer = null
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)
	})
	return Promise.race([promise, timeout]).finally(() => {
		if (timer != null) clearTimeout(timer)
	})
}

function enqueueCurseForge(periodDays) {
	const job = curseForgeQueue
		.catch(() => undefined)
		.then(async () => {
			const attemptedAt = Date.now()
			const analytics = await withTimeout(
				getCurseForgeAuthorAnalytics(periodDays),
				CURSEFORGE_TIMEOUT_MS,
				`CurseForge ${periodDays}d analytics`,
			)
			return {
				updatedAt: Date.now(),
				lastAttemptAt: attemptedAt,
				analytics,
				error: null,
			}
		})
	curseForgeQueue = job
	return job
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error)
}

function failedProvider(previous, error) {
	return {
		...(previous ?? {}),
		updatedAt: Number(previous?.updatedAt) || 0,
		lastAttemptAt: Date.now(),
		error: errorMessage(error),
	}
}

export async function refreshCreatorAnalyticsPeriod(periodDays = 30, { force = false } = {}) {
	const days = normalizePeriod(periodDays)
	const existingPromise = refreshes.get(days)
	if (existingPromise) return await existingPromise

	const cached = getCreatorAnalyticsSnapshot(days)
	if (!force && isPeriodFresh(cached) && await cacheMatchesCurrentModrinthUser(cached)) return cached

	const promise = (async () => {
		const previous = getCreatorAnalyticsSnapshot(days)

		const modrinthTask = fetchModrinthAnalytics(days)
			.then((modrinth) => {
				persistPeriod(days, { modrinth })
				return modrinth
			})
			.catch((error) => {
				persistPeriod(days, { modrinth: failedProvider(previous.modrinth, error) })
				throw error
			})

		const curseForgeTask = enqueueCurseForge(days)
			.then((curseforge) => {
				persistPeriod(days, { curseforge })
				return curseforge
			})
			.catch((error) => {
				persistPeriod(days, { curseforge: failedProvider(previous.curseforge, error) })
				throw error
			})

		// Providers are intentionally committed independently. The UI can show Modrinth as soon
		// as it arrives instead of being held hostage by the slower hidden CurseForge webview.
		// We still wait here so startup keeps the requested 30d -> 90d -> 7d ordering.
		await Promise.allSettled([modrinthTask, curseForgeTask])
		return getCreatorAnalyticsSnapshot(days)
	})()

	refreshes.set(days, promise)
	try {
		return await promise
	} finally {
		if (refreshes.get(days) === promise) refreshes.delete(days)
	}
}

async function hasActiveInstallJobs() {
	try {
		const jobs = await invoke('plugin:install|install_job_list', { includeFinished: false })
		return Array.isArray(jobs) && jobs.some((job) => job?.status === 'queued' || job?.status === 'running')
	} catch {
		return false
	}
}

function runWhenBrowserIdle(callback, timeout = 5000) {
	if (typeof window.requestIdleCallback === 'function') {
		window.requestIdleCallback(() => void callback(), { timeout })
	} else {
		setTimeout(() => void callback(), Math.min(timeout, 1500))
	}
}

async function lowLoadEnough({ ignoreInteraction = false } = {}) {
	if (!navigator.onLine) return false
	if (await hasActiveInstallJobs()) return false
	if (!ignoreInteraction && document.visibilityState === 'visible' && Date.now() - lastInteractionAt < LOW_LOAD_INTERACTION_MS) return false
	return true
}

async function warmPeriod(periodDays, options = {}) {
	if (!(await lowLoadEnough(options))) return false
	try {
		await refreshCreatorAnalyticsPeriod(periodDays, { force: false })
		return isPeriodFresh(getCreatorAnalyticsSnapshot(periodDays))
	} catch (error) {
		if (import.meta.env.DEV) console.debug(`[Fodrinth] Background analytics ${periodDays}d refresh failed`, error)
		return false
	}
}

function scheduleStartupWarmup(delay = STARTUP_DELAY_MS) {
	setTimeout(() => {
		runWhenBrowserIdle(async () => {
			for (const periodDays of DEFAULT_PERIODS) {
				if (!(await lowLoadEnough({ ignoreInteraction: true }))) {
					scheduleStartupWarmup(RETRY_DELAY_MS)
					return
				}
				await refreshCreatorAnalyticsPeriod(periodDays, { force: false })
			}
		}, 6000)
	}, delay)
}

async function refreshOneStalePeriod() {
	if (!(await lowLoadEnough())) return
	const candidates = DEFAULT_PERIODS
		.map((periodDays) => ({ periodDays, snapshot: getCreatorAnalyticsSnapshot(periodDays) }))
		.map((item) => ({
			...item,
			age: Math.max(providerAge(item.snapshot.modrinth), providerAge(item.snapshot.curseforge)),
		}))
		.filter((item) => !isPeriodFresh(item.snapshot))
		.sort((a, b) => b.age - a.age)
	if (candidates.length === 0) return
	await warmPeriod(candidates[0].periodDays)
}

function noteInteraction() {
	lastInteractionAt = Date.now()
}

export function startCreatorAnalyticsBackground() {
	if (backgroundStarted) return
	backgroundStarted = true

	for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
		window.addEventListener(event, noteInteraction, { passive: true })
	}

	// Warm startup analytics sequentially in the requested priority order 30d -> 90d -> 7d.
	// Each provider streams into the cache independently, while the next period waits for the
	// current period to resolve or hit the bounded CurseForge timeout.
	scheduleStartupWarmup()

	periodicTimer = window.setInterval(() => {
		runWhenBrowserIdle(refreshOneStalePeriod, 8000)
	}, PERIODIC_CHECK_MS)

	window.addEventListener('online', () => runWhenBrowserIdle(refreshOneStalePeriod, 5000))
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') runWhenBrowserIdle(refreshOneStalePeriod, 4000)
	})

	startupWarmupFinished = true
}

export function isCreatorAnalyticsBackgroundStarted() {
	return backgroundStarted && startupWarmupFinished
}

export function stopCreatorAnalyticsBackgroundForTests() {
	if (periodicTimer != null) clearInterval(periodicTimer)
	periodicTimer = null
	backgroundStarted = false
	startupWarmupFinished = false
}
