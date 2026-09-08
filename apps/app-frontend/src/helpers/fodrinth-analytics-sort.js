import router from '@/routes'

const SORT_BY_COLUMN = ['name', 'provider', 'period', 'alltime']
const NUMERIC_SORTS = new Set(['period', 'alltime'])

let observer = null
let scheduled = false

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
		.fodrinth-sortable-header:hover {
			color: var(--color-contrast, #fff) !important;
			background: color-mix(in srgb, var(--color-surface-4) 55%, transparent);
		}
		.fodrinth-sortable-header.fodrinth-sort-active {
			color: var(--color-contrast, #fff) !important;
		}
		.fodrinth-sort-indicator {
			display: inline-block;
			margin-left: 0.35rem;
			font-size: 0.8em;
			font-weight: 700;
			color: var(--color-brand, #1bd96a);
		}
	`
	document.head.appendChild(style)
}

function updateHeaders(section, select) {
	const headers = [...section.querySelectorAll('table thead th')]
	const activeSort = select.value || 'provider'

	headers.forEach((header, index) => {
		const sortId = SORT_BY_COLUMN[index]
		if (!sortId) return

		header.classList.add('fodrinth-sortable-header')
		header.dataset.fodrinthSort = sortId
		header.title = `Sort by ${header.textContent?.trim() ?? sortId}`
		header.classList.toggle('fodrinth-sort-active', activeSort === sortId)

		let indicator = header.querySelector(':scope > .fodrinth-sort-indicator')
		if (activeSort === sortId) {
			if (!indicator) {
				indicator = document.createElement('span')
				indicator.className = 'fodrinth-sort-indicator'
				header.appendChild(indicator)
			}
			indicator.textContent = NUMERIC_SORTS.has(sortId) ? '↓' : '↑'
		} else {
			indicator?.remove()
		}

		if (header.dataset.fodrinthSortBound === 'true') return
		header.dataset.fodrinthSortBound = 'true'
		header.addEventListener('click', () => {
			const currentSection = findComparisonSection()
			const currentSelect = currentSection ? findSortSelect(currentSection) : null
			if (!currentSelect || ![...currentSelect.options].some((option) => option.value === sortId)) return
			currentSelect.value = sortId
			currentSelect.dispatchEvent(new Event('change', { bubbles: true }))
			queueMicrotask(schedulePatch)
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
	updateHeaders(section, select)
}

function schedulePatch() {
	if (scheduled) return
	scheduled = true
	requestAnimationFrame(patch)
}

export function initFodrinthAnalyticsSort() {
	if (observer) return
	ensureStyles()
	observer = new MutationObserver(schedulePatch)
	observer.observe(document.body, { childList: true, subtree: true, characterData: true })
	router.afterEach(() => schedulePatch())
	schedulePatch()
}
