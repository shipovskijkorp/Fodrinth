import { CREATOR_ANALYTICS_CACHE_UPDATED_EVENT } from '@/helpers/creator-analytics-cache.js'
import router from '@/routes'

const SORT_BY_COLUMN = ['name', 'provider', 'period', 'alltime']
const NUMERIC_SORTS = new Set(['period', 'alltime'])
const PROVIDER_RANK = { Sync: 0, Modrinth: 1, CurseForge: 2 }

let observer = null
let scheduled = false
let activeSort = 'provider'
let sortDirection = 'asc'
let initializedSort = false
let suppressSelectSync = false
let restoring = false

const numberParts = new Intl.NumberFormat().formatToParts(12345.6)
const numberGroup = numberParts.find((part) => part.type === 'group')?.value ?? ''
const numberDecimal = numberParts.find((part) => part.type === 'decimal')?.value ?? '.'

function isAnalyticsRoute() {
	return router.currentRoute.value?.path === '/analytics'
}

function findComparisonSection() {
	for (const section of document.querySelectorAll('section')) {
		const heading = section.querySelector('h2')
		if (heading?.textContent?.trim() === 'Project comparison') return section
	}
	return null
}

function findSortSelect(section) {
	return [...section.querySelectorAll('select')].find((select) =>
		[...select.options].some((option) => option.textContent?.trim().startsWith('Sort:')),
	)
}

function defaultDirection(sortId) {
	return NUMERIC_SORTS.has(sortId) ? 'desc' : 'asc'
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseDisplayedNumber(value) {
	let normalized = String(value ?? '').trim()
	if (numberGroup) normalized = normalized.replace(new RegExp(escapeRegExp(numberGroup), 'g'), '')
	if (numberDecimal && numberDecimal !== '.') {
		normalized = normalized.replace(new RegExp(escapeRegExp(numberDecimal), 'g'), '.')
	}
	normalized = normalized.replace(/[^0-9+.-]/g, '')
	const number = Number.parseFloat(normalized)
	return Number.isFinite(number) ? number : null
}

function projectName(row) {
	return row.cells?.[0]?.textContent?.trim() ?? ''
}

function periodValue(row) {
	return parseDisplayedNumber(row.cells?.[2]?.textContent) ?? 0
}

function compareRows(left, right, sortId, direction) {
	const columnIndex = SORT_BY_COLUMN.indexOf(sortId)
	if (columnIndex < 0) return 0
	const leftText = left.cells?.[columnIndex]?.textContent?.trim() ?? ''
	const rightText = right.cells?.[columnIndex]?.textContent?.trim() ?? ''
	const directionFactor = direction === 'desc' ? -1 : 1
	let result = 0

	if (NUMERIC_SORTS.has(sortId)) {
		const leftNumber = parseDisplayedNumber(leftText)
		const rightNumber = parseDisplayedNumber(rightText)
		if (leftNumber == null && rightNumber != null) return 1
		if (leftNumber != null && rightNumber == null) return -1
		if (leftNumber != null && rightNumber != null) result = (leftNumber - rightNumber) * directionFactor
	} else if (sortId === 'provider') {
		const leftRank = PROVIDER_RANK[leftText] ?? 99
		const rightRank = PROVIDER_RANK[rightText] ?? 99
		if (leftRank !== rightRank) result = (leftRank - rightRank) * directionFactor
		else result = periodValue(right) - periodValue(left)
	} else {
		result = leftText.localeCompare(rightText, undefined, { sensitivity: 'base' }) * directionFactor
	}

	if (result !== 0) return result
	return projectName(left).localeCompare(projectName(right), undefined, { sensitivity: 'base' })
}

function sortRows(section, sortId = activeSort, direction = sortDirection) {
	const tbody = section?.querySelector('table tbody')
	if (!tbody) return
	const rows = [...tbody.querySelectorAll(':scope > tr')]
	if (rows.length < 2) return

	const sorted = rows
		.map((row, index) => ({ row, index }))
		.sort((left, right) =>
			compareRows(left.row, right.row, sortId, direction) || left.index - right.index,
		)
		.map((entry) => entry.row)

	if (sorted.every((row, index) => row === rows[index])) return
	const fragment = document.createDocumentFragment()
	for (const row of sorted) fragment.appendChild(row)
	tbody.appendChild(fragment)
}

function restoreVueOrder() {
	if (restoring || !isAnalyticsRoute()) return
	const section = findComparisonSection()
	if (!section) return
	restoring = true
	try {
		// Analytics.vue owns the table and always renders the selected field in its canonical
		// direction (text ascending, numbers descending, provider ascending). Put the DOM back
		// in exactly that order before Vue reacts to a source/period/cache change. This avoids
		// externally reordered keyed <tr> nodes confusing Vue's patcher on the next render.
		sortRows(section, activeSort, defaultDirection(activeSort))
	} finally {
		restoring = false
	}
}

function ensureStyles() {
	if (document.getElementById('fodrinth-analytics-sort-style')) return
	const style = document.createElement('style')
	style.id = 'fodrinth-analytics-sort-style'
	style.textContent = `
		.fodrinth-analytics-sort-select {
			display: none !important;
		}
		.fodrinth-sortable-header {
			cursor: pointer;
			user-select: none;
			transition: color 120ms ease, background-color 120ms ease;
		}
		.fodrinth-sortable-header:hover,
		.fodrinth-sortable-header:focus-visible {
			color: var(--color-contrast, #fff) !important;
			background: color-mix(in srgb, var(--color-surface-4) 55%, transparent);
			outline: none;
		}
		.fodrinth-sortable-header.fodrinth-sort-active {
			color: var(--color-contrast, #fff) !important;
		}
		.fodrinth-sort-indicator {
			display: inline-block;
			min-width: 0.9em;
			margin-left: 0.35rem;
			font-size: 0.9em;
			font-weight: 800;
			color: var(--color-brand, #1bd96a);
		}
	`
	document.head.appendChild(style)
}

function activateSort(sortId, select) {
	restoreVueOrder()
	if (activeSort === sortId) {
		sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'
	} else {
		activeSort = sortId
		sortDirection = defaultDirection(sortId)
	}

	if (select.value !== sortId && [...select.options].some((option) => option.value === sortId)) {
		suppressSelectSync = true
		select.value = sortId
		select.dispatchEvent(new Event('change', { bubbles: true }))
	}
	schedulePatch()
}

function updateHeaders(section, select) {
	const headers = [...section.querySelectorAll('table thead th')]

	headers.forEach((header, index) => {
		const sortId = SORT_BY_COLUMN[index]
		if (!sortId) return

		if (!header.dataset.fodrinthSortLabel) {
			header.dataset.fodrinthSortLabel = header.textContent?.trim() ?? sortId
		}
		const label = header.dataset.fodrinthSortLabel
		header.classList.add('fodrinth-sortable-header')
		header.dataset.fodrinthSort = sortId
		header.tabIndex = 0
		header.title = activeSort === sortId
			? `Sort ${label} ${sortDirection === 'asc' ? 'descending' : 'ascending'}`
			: `Sort by ${label}`
		header.classList.toggle('fodrinth-sort-active', activeSort === sortId)
		header.setAttribute('aria-sort', activeSort === sortId ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none')

		let indicator = header.querySelector(':scope > .fodrinth-sort-indicator')
		if (activeSort === sortId) {
			if (!indicator) {
				indicator = document.createElement('span')
				indicator.className = 'fodrinth-sort-indicator'
				header.appendChild(indicator)
			}
			indicator.textContent = sortDirection === 'asc' ? '↑' : '↓'
		} else {
			indicator?.remove()
		}

		if (header.dataset.fodrinthSortBound === 'true') return
		header.dataset.fodrinthSortBound = 'true'
		const trigger = () => {
			const currentSection = findComparisonSection()
			const currentSelect = currentSection ? findSortSelect(currentSection) : null
			if (!currentSelect || ![...currentSelect.options].some((option) => option.value === sortId)) return
			activateSort(sortId, currentSelect)
		}
		header.addEventListener('click', trigger)
		header.addEventListener('keydown', (event) => {
			if (event.key !== 'Enter' && event.key !== ' ') return
			event.preventDefault()
			trigger()
		})
	})
}

function patch() {
	scheduled = false
	if (!isAnalyticsRoute()) return
	const section = findComparisonSection()
	if (!section) return
	const select = findSortSelect(section)
	if (!select) return

	ensureStyles()
	select.classList.add('fodrinth-analytics-sort-select')

	const selectSort = select.value || 'provider'
	if (!initializedSort) {
		activeSort = selectSort
		sortDirection = defaultDirection(activeSort)
		initializedSort = true
	} else if (suppressSelectSync) {
		suppressSelectSync = false
	} else if (selectSort !== activeSort) {
		activeSort = selectSort
		sortDirection = defaultDirection(activeSort)
	}

	updateHeaders(section, select)
	if (sortDirection !== defaultDirection(activeSort)) sortRows(section)
}

function schedulePatch() {
	if (scheduled) return
	scheduled = true
	requestAnimationFrame(patch)
}

function beforeUiMutation(event) {
	if (!isAnalyticsRoute()) return
	if (event?.target?.closest?.('.fodrinth-sortable-header')) return
	restoreVueOrder()
	requestAnimationFrame(schedulePatch)
}

function beforeCacheMutation() {
	restoreVueOrder()
	schedulePatch()
}

export function initFodrinthAnalyticsSort() {
	if (observer) return
	ensureStyles()
	observer = new MutationObserver(schedulePatch)
	observer.observe(document.body, { childList: true, subtree: true, characterData: true })
	document.addEventListener('click', beforeUiMutation, true)
	document.addEventListener('change', beforeUiMutation, true)
	window.addEventListener(CREATOR_ANALYTICS_CACHE_UPDATED_EVENT, beforeCacheMutation)
	router.beforeEach(() => {
		restoreVueOrder()
		return true
	})
	router.afterEach(() => schedulePatch())
	schedulePatch()
}
