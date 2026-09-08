import { invoke } from '@tauri-apps/api/core'

import router from '@/routes'

const STORAGE_KEY = 'fodrinth.creator.projects.layout.v1'
const VALID_LAYOUTS = new Set(['1', '2', '3'])
const CURSEFORGE_STATUS_CACHE_MS = 15_000

const CURSEFORGE_STATUS_LABELS = new Map([
	['0', 'None'],
	['1', 'New'],
	['2', 'Changes required'],
	['3', 'Under soft review'],
	['4', 'Approved'],
	['5', 'Rejected'],
	['6', 'Changes made'],
	['7', 'Inactive'],
	['8', 'Abandoned'],
	['9', 'Deleted'],
	['10', 'Under review'],
])

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

const curseForgeStatuses = new Map()
let curseForgeStatusPromise = null
let curseForgeStatusLoadedAt = 0

function readLayout() {
	const stored = localStorage.getItem(STORAGE_KEY)
	return VALID_LAYOUTS.has(stored) ? stored : '2'
}

let currentLayout = readLayout()

function normalizeCurseForgeStatus(value) {
	const text = String(value ?? '').trim()
	if (!text) return ''
	return CURSEFORGE_STATUS_LABELS.get(text) ?? text
}

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

function providerProjectId(card, providerName) {
	for (const line of card.querySelectorAll('.provider-line')) {
		if (!String(line.textContent || '').includes(providerName)) continue
		return String(line.querySelector('code')?.textContent || '').trim()
	}
	return ''
}

function ensureStatusElement(card) {
	const meta = card.querySelector('.project-meta')
	if (!meta) return null
	if (meta.children.length > 1) return meta.children[1]

	const status = document.createElement('span')
	meta.appendChild(status)
	return status
}

function patchCardStatus(card) {
	const modrinthBadge = card.querySelector('.provider-modrinth')
	const curseForgeBadge = card.querySelector('.provider-curseforge')
	if (!curseForgeBadge) return

	const hasModrinth = !!modrinthBadge && !modrinthBadge.classList.contains('missing')
	const hasCurseForge = !curseForgeBadge.classList.contains('missing')
	const status = ensureStatusElement(card)
	if (!status) return

	const current = String(status.textContent || '').trim()

	if (!modrinthBadge) {
		const normalized = normalizeCurseForgeStatus(current)
		if (normalized && normalized !== current) status.textContent = normalized
		return
	}

	let modrinthStatus = status.dataset.fodrinthModrinthStatus || ''
	if (!modrinthStatus && hasModrinth) {
		modrinthStatus = current.includes('/') ? current.split('/')[0].trim() : current
		status.dataset.fodrinthModrinthStatus = modrinthStatus
	}

	const curseForgeId = providerProjectId(card, 'CurseForge')
	let curseForgeStatus = curseForgeStatuses.get(curseForgeId) || ''
	if (!hasModrinth && hasCurseForge && !curseForgeStatus) {
		curseForgeStatus = normalizeCurseForgeStatus(current)
	}

	const combined = `${hasModrinth && modrinthStatus ? modrinthStatus : '—'}/${hasCurseForge && curseForgeStatus ? curseForgeStatus : '—'}`
	if (status.textContent !== combined) status.textContent = combined
}

async function refreshCurseForgeStatusCache(cards) {
	const neededIds = cards
		.filter((card) => card.querySelector('.provider-modrinth') && card.querySelector('.provider-curseforge:not(.missing)'))
		.map((card) => providerProjectId(card, 'CurseForge'))
		.filter(Boolean)
		.filter((id) => !curseForgeStatuses.has(id))

	if (neededIds.length === 0) return
	if (curseForgeStatusPromise) return
	if (Date.now() - curseForgeStatusLoadedAt < CURSEFORGE_STATUS_CACHE_MS) return

	curseForgeStatusPromise = invoke('plugin:utils|curseforge_get_author_projects')
		.then((response) => {
			for (const project of response?.projects ?? []) {
				const id = String(project?.id ?? '').trim()
				const status = normalizeCurseForgeStatus(project?.status)
				if (id && status) curseForgeStatuses.set(id, status)
			}
		})
		.catch((error) => {
			console.warn('Could not refresh CurseForge project statuses', error)
		})
		.finally(() => {
			curseForgeStatusLoadedAt = Date.now()
			curseForgeStatusPromise = null
			if (router.currentRoute.value.path === '/projects') patchProjectPage()
		})

	await curseForgeStatusPromise
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

	const cards = Array.from(grid.querySelectorAll('.project-card'))
	cards.forEach(patchCardStatus)
	void refreshCurseForgeStatusCache(cards)
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
