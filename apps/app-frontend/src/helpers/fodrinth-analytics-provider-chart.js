import {
	CREATOR_ANALYTICS_CACHE_UPDATED_EVENT,
	getCreatorAnalyticsSnapshot,
} from '@/helpers/creator-analytics-cache.js'
import router from '@/routes'

const SVG_NS = 'http://www.w3.org/2000/svg'
const DAY_MS = 24 * 60 * 60 * 1000

let observer = null
let scheduled = false

function isAnalyticsRoute() {
	return router.currentRoute.value?.path === '/analytics'
}

function text(element) {
	return element?.textContent?.trim() ?? ''
}

function activeButton(label) {
	return [...document.querySelectorAll('button')].find((button) =>
		text(button) === label && (button.classList.contains('border-brand') || button.classList.contains('bg-surface-5')),
	)
}

function isCombinedDownloads() {
	return !!activeButton('Combined') && !!activeButton('Downloads')
}

function selectedPeriod() {
	for (const select of document.querySelectorAll('select')) {
		const labels = [...select.options].map((option) => text(option))
		if (!labels.some((label) => /^Last (7|30|90) days$/.test(label))) continue
		const value = Number(select.value)
		if (Number.isFinite(value)) return value
	}
	return 30
}

function findChartSection() {
	for (const section of document.querySelectorAll('section')) {
		if (text(section.querySelector('h2')) === 'Downloads over time') return section
	}
	return null
}

function splitModrinthMetrics(response) {
	const slices = Array.isArray(response?.metrics) ? response.metrics : []
	if (!slices.length) return []
	return slices.slice(Math.floor(slices.length / 2))
}

function modrinthSeries(snapshot) {
	return splitModrinthMetrics(snapshot?.modrinth?.analyticsResponse).map((slice) =>
		(Array.isArray(slice) ? slice : []).reduce((total, point) =>
			point?.metric_kind === 'downloads' ? total + (Number(point.downloads) || 0) : total,
		0,
	))
}

function curseForgeSeries(snapshot, periodDays) {
	const rows = snapshot?.curseforge?.analytics?.downloads?.series
	if (!Array.isArray(rows) || !rows.length) return []
	const values = Array(periodDays).fill(0)
	const end = new Date()
	const start = new Date(end.getTime() - periodDays * DAY_MS)
	start.setHours(0, 0, 0, 0)
	let found = false
	for (const row of rows) {
		const timestamp = new Date(row?.date ?? row?.timestamp ?? row?.time).getTime()
		const value = Number(row?.total ?? row?.value)
		if (!Number.isFinite(timestamp) || !Number.isFinite(value)) continue
		if (timestamp < start.getTime() || timestamp >= end.getTime() + DAY_MS) continue
		const index = Math.min(periodDays - 1, Math.max(0, Math.floor((timestamp - start.getTime()) / DAY_MS)))
		values[index] += value
		found = true
	}
	return found ? values : []
}

function mergedSeries(left, right) {
	const size = Math.max(left.length, right.length)
	return Array.from({ length: size }, (_, index) => (left[index] ?? 0) + (right[index] ?? 0))
}

function points(values, max) {
	if (!values.length || max <= 0) return ''
	const width = 760
	const height = 220
	return values.map((value, index) => {
		const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width
		const y = height - ((Number(value) || 0) / max) * (height - 20)
		return `${x.toFixed(1)},${y.toFixed(1)}`
	}).join(' ')
}

function makeOverlay(className, color, linePoints, fillOpacity) {
	const svg = document.createElementNS(SVG_NS, 'svg')
	svg.setAttribute('viewBox', '0 0 760 220')
	svg.setAttribute('preserveAspectRatio', 'none')
	svg.setAttribute('aria-hidden', 'true')
	svg.setAttribute('data-fodrinth-provider-chart', className)
	svg.classList.add('absolute', 'inset-0', 'h-full', 'w-full', 'overflow-visible')
	svg.style.color = color
	svg.style.pointerEvents = 'none'

	const area = document.createElementNS(SVG_NS, 'polygon')
	area.setAttribute('points', linePoints ? `0,220 ${linePoints} 760,220` : '')
	area.setAttribute('fill', 'currentColor')
	area.setAttribute('opacity', String(fillOpacity))
	svg.appendChild(area)

	const line = document.createElementNS(SVG_NS, 'polyline')
	line.setAttribute('points', linePoints)
	line.setAttribute('fill', 'none')
	line.setAttribute('stroke', 'currentColor')
	line.setAttribute('stroke-width', '3')
	line.setAttribute('vector-effect', 'non-scaling-stroke')
	svg.appendChild(line)
	return svg
}

function restore(section = findChartSection()) {
	if (!section) return
	section.querySelectorAll('[data-fodrinth-provider-chart]').forEach((element) => element.remove())
	const native = section.querySelector('svg:not([data-fodrinth-provider-chart])')
	if (native) native.style.display = ''
	delete section.dataset.fodrinthProviderChartFingerprint
}

function fingerprint(periodDays, modrinth, curseforge) {
	return JSON.stringify([periodDays, modrinth, curseforge])
}

function patch() {
	scheduled = false
	if (!isAnalyticsRoute()) return
	const section = findChartSection()
	if (!section) return
	if (!isCombinedDownloads()) {
		restore(section)
		return
	}

	const periodDays = selectedPeriod()
	const snapshot = getCreatorAnalyticsSnapshot(periodDays)
	const modrinth = modrinthSeries(snapshot)
	const curseforge = curseForgeSeries(snapshot, periodDays)
	if (!modrinth.length && !curseforge.length) {
		restore(section)
		return
	}

	const nextFingerprint = fingerprint(periodDays, modrinth, curseforge)
	const expectedOverlays = Number(modrinth.length > 0) + Number(curseforge.length > 0)
	const overlays = section.querySelectorAll('[data-fodrinth-provider-chart]')
	const native = section.querySelector('svg:not([data-fodrinth-provider-chart])')
	if (
		section.dataset.fodrinthProviderChartFingerprint === nextFingerprint &&
		overlays.length === expectedOverlays &&
		native?.style.display === 'none'
	) return

	if (!native?.parentElement) return
	const host = native.parentElement
	const combined = mergedSeries(modrinth, curseforge)
	// Analytics.vue still owns the native axis labels. Its Combined series is Modrinth +
	// CurseForge, so scale both provider overlays against that same maximum and never mutate
	// Vue-owned axis text. This keeps source/period switching deterministic.
	const max = Math.max(...combined, ...modrinth, ...curseforge, 1)

	native.style.display = 'none'
	overlays.forEach((element) => element.remove())
	if (modrinth.length) {
		host.appendChild(makeOverlay('modrinth', 'var(--color-brand, #1bd96a)', points(modrinth, max), 0.07))
	}
	if (curseforge.length) {
		host.appendChild(makeOverlay('curseforge', '#ff7849', points(curseforge, max), 0.045))
	}
	section.dataset.fodrinthProviderChartFingerprint = nextFingerprint
}

function schedulePatch() {
	if (scheduled) return
	scheduled = true
	requestAnimationFrame(patch)
}

function beforeUiMutation() {
	if (!isAnalyticsRoute()) return
	// Restore the Vue-owned SVG before source/period/view controls trigger a render. Otherwise
	// Vue can patch a node that our helper has hidden from under it and the graph occasionally
	// stays blank or carries the previous provider after switching.
	restore()
	requestAnimationFrame(schedulePatch)
}

export function initFodrinthAnalyticsProviderChart() {
	if (observer) return
	observer = new MutationObserver(schedulePatch)
	observer.observe(document.body, { childList: true, subtree: true, characterData: true })
	document.addEventListener('click', beforeUiMutation, true)
	document.addEventListener('change', beforeUiMutation, true)
	router.beforeEach(() => {
		restore()
		return true
	})
	router.afterEach(schedulePatch)
	window.addEventListener(CREATOR_ANALYTICS_CACHE_UPDATED_EVENT, () => {
		restore()
		schedulePatch()
	})
	schedulePatch()
}
