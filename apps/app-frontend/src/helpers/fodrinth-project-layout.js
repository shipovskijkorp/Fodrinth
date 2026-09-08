import router from '@/routes'

const STORAGE_KEY = 'fodrinth.creator.projects.layout.v1'
const VALID_LAYOUTS = new Set(['1', '2', '3'])

const LAYOUT_ICONS = {
	1: `
		<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
			<rect x="3" y="5" width="14" height="10" rx="1.5" />
		</svg>
	`,
	2: `
		<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
			<rect x="2.5" y="4" width="6.5" height="12" rx="1.3" />
			<rect x="11" y="4" width="6.5" height="12" rx="1.3" />
		</svg>
	`,
	3: `
		<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
			<rect x="1.5" y="5" width="4.8" height="10" rx="1.1" />
			<rect x="7.6" y="5" width="4.8" height="10" rx="1.1" />
			<rect x="13.7" y="5" width="4.8" height="10" rx="1.1" />
		</svg>
	`,
}

function readLayout() {
	const stored = localStorage.getItem(STORAGE_KEY)
	return VALID_LAYOUTS.has(stored) ? stored : '2'
}

let currentLayout = readLayout()

function updateButtons(picker) {
	picker.querySelectorAll('[data-project-layout]').forEach((button) => {
		const active = button.dataset.projectLayout === currentLayout
		button.classList.toggle('is-active', active)
		button.setAttribute('aria-pressed', String(active))
	})
}

function applyLayout(grid, picker) {
	for (const layout of VALID_LAYOUTS) grid.classList.remove(`fodrinth-layout-${layout}`)
	grid.classList.add(`fodrinth-layout-${currentLayout}`)
	if (picker) updateButtons(picker)
}

function createLayoutPicker(grid) {
	const picker = document.createElement('div')
	picker.className = 'fodrinth-project-layout-picker'
	picker.setAttribute('role', 'group')
	picker.setAttribute('aria-label', 'Project card layout')

	for (const [layout, label] of [
		['1', 'One column'],
		['2', 'Two columns'],
		['3', 'Three square cards per row'],
	]) {
		const button = document.createElement('button')
		button.type = 'button'
		button.className = 'fodrinth-project-layout-button'
		button.dataset.projectLayout = layout
		button.title = label
		button.setAttribute('aria-label', label)
		button.innerHTML = LAYOUT_ICONS[layout]
		button.addEventListener('click', () => {
			currentLayout = layout
			localStorage.setItem(STORAGE_KEY, currentLayout)
			applyLayout(grid, picker)
		})
		picker.appendChild(button)
	}

	updateButtons(picker)
	return picker
}

function patchProjectPage() {
	if (router.currentRoute.value.path !== '/projects') return

	const grid = document.querySelector('.project-grid')
	if (!grid) return

	const page = grid.closest('.mx-auto.flex.max-w-7xl') || grid.parentElement
	page?.classList.add('fodrinth-projects-page')

	let picker = page?.querySelector('.fodrinth-project-layout-picker') ?? null
	const searchInput = page?.querySelector('input.project-input[type="search"]') ?? null
	const toolbarRow = searchInput?.parentElement ?? null

	if (toolbarRow) {
		toolbarRow.classList.add('fodrinth-project-toolbar-row')
		if (!picker) {
			picker = createLayoutPicker(grid)
			toolbarRow.appendChild(picker)
		}
	}

	applyLayout(grid, picker)
}

export function initFodrinthProjectLayout() {
	let updateQueued = false
	const queueUpdate = () => {
		if (updateQueued) return
		updateQueued = true
		queueMicrotask(() => {
			updateQueued = false
			patchProjectPage()
		})
	}

	const observer = new MutationObserver(queueUpdate)
	observer.observe(document.documentElement, {
		childList: true,
		subtree: true,
	})

	const removeRouteHook = router.afterEach(queueUpdate)
	queueUpdate()

	return () => {
		observer.disconnect()
		removeRouteHook()
	}
}
