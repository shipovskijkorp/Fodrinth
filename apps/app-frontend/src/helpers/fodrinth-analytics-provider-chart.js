import {
	CREATOR_ANALYTICS_CACHE_UPDATED_EVENT,
	getCreatorAnalyticsSnapshot,
} from '@/helpers/creator-analytics-cache.js'
import router from '@/routes'

const SVG_NS = 'http://www.w3.org/2000/svg'
const DAY_MS = 24 * 60 * 60 * 1000
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

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

function axisLabels(section) {
	const chartBody = [...section.querySelectorAll('div')].find((element) =>
		element.classList.contains('grid') && String(element.className).includes('grid-cols-[64px_1fr]'),
	)
	if (!chartBody) return []
	const axis = chartBody.firstElementChild
	return axis ? [...axis.querySelectorAll('span')].slice(0, 3) : []
}

function patchAxis(section, max) {
	const labels = axisLabels(section)
	if (labels.length < 3) return
	const desired = [compact.format(max), compact.format(max / 2), '0']
	labels.forEach((label, index) => {
		if (!label.dataset.fodrinthOriginalValue) label.dataset.fodrinthOriginalValue = label.textContent
		if (label.textContent !== desired[index]) label.textContent = desired[index]
		label.dataset.fodrinthPatchedValue = desired[index]
	})
}

function restore(section) {
	const overlays = section.querySelectorAll('[data-fodrinth-provider-chart]')
	const native = section.querySelector('svg:not([data-fodrinth-provider-chart])')
	const wasPatched = !!section.dataset.fodrinthProviderChartFingerprint || overlays.length > 0 || native?.style.display === 'none'
	if (!wasPatched) return

	overlays.forEach((element) => element.remove())
	if (native) native.style.display = ''
	for (const label of axisLabels(section)) {
		if (label.dataset.fodrinthOriginalValue) label.textContent = label.dataset.fodrinthOriginalValue
		delete label.dataset.fodrinthOriginalValue
		delete label.dataset.fodrinthPatchedValue
	}
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

	const max = Math.max(...modrinth, ...curseforge, 1)
	if (!native?.parentElement) return
	const host = native.parentElement
	native.style.display = 'none'
	overlays.forEach((element) => element.remove())

	if (modrinth.length) {
		host.appendChild(makeOverlay('modrinth', 'var(--color-brand, #1bd96a)', points(modrinth, max), 0.07))
	}
	if (curseforge.length) {
		host.appendChild(makeOverlay('curseforge', '#ff7849', points(curseforge, max), 0.045))
	}
	patchAxis(section, max)
	section.dataset.fodrinthProviderChartFingerprint = nextFingerprint
}

function schedulePatch() {
	if (scheduled) return
	scheduled = true
	requestAnimationFrame(patch)
}

export function initFodrinthAnalyticsProviderChart() {
	if (observer) return
	observer = new MutationObserver(schedulePatch)
	observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true })
	router.afterEach(schedulePatch)
	window.addEventListener(CREATOR_ANALYTICS_CACHE_UPDATED_EVENT, schedulePatch)
	schedulePatch()
}
