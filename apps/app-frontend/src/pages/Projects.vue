<script setup>
import {
	CurseForgeIcon,
	ModrinthIcon,
	PackageIcon,
	RefreshCwIcon,
} from '@modrinth/assets'
import { injectModrinthClient } from '@modrinth/ui'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import {
	CURSEFORGE_AUTH_CHANGED_EVENT,
	isCurseForgeAuthenticated,
	openCurseForgeAuth,
} from '@/helpers/curseforge-auth.js'
import { openCurseForgeAuthorPortal } from '@/helpers/curseforge-analytics.js'
import {
	CREATOR_PROJECT_LINKS_CHANGED_EVENT,
	getCreatorProjectLinks,
	getCurseForgeAuthorProjects,
	linkCreatorProjects,
	unlinkCreatorProjects,
	updateCurseForgeProject,
	uploadCurseForgeProjectFile,
} from '@/helpers/creator-projects.js'
import { get as getModrinthCredentials } from '@/helpers/mr_auth.ts'
import { get_user_projects } from '@/helpers/users'

const client = injectModrinthClient()

const loading = ref(false)
const errorMessage = ref('')
const curseForgeError = ref('')
const curseForgePortalNeedsLogin = ref(false)
const modrinthProjects = ref([])
const curseForgeProjects = ref([])
const projectLinks = ref(getCreatorProjectLinks())
const sourceFilter = ref('all')
const searchQuery = ref('')
const sortMode = ref('updated')

const editCard = ref(null)
const editBusy = ref(false)
const editResults = ref([])
const editProviders = ref({ modrinth: false, curseforge: false })
const editInitial = ref(null)
const editForm = ref({
	name: '',
	summary: '',
	description: '',
	sourceUrl: '',
	issuesUrl: '',
})

const uploadCard = ref(null)
const uploadBusy = ref(false)
const uploadResults = ref([])
const uploadProgress = ref({ modrinth: null, curseforge: null })
const uploadProviders = ref({ modrinth: false, curseforge: false })
const uploadForm = ref({
	file: null,
	versionNumber: '',
	name: '',
	releaseType: 'release',
	gameVersions: '',
	loaders: '',
	changelog: '',
})

const syncCard = ref(null)
const syncTargetId = ref('')
const syncError = ref('')

const numberFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })

function projectId(project) {
	return String(project?.id ?? '').trim()
}

function projectName(project, fallback = 'Untitled project') {
	return project?.name ?? project?.title ?? project?.slug ?? fallback
}

function projectSummary(project) {
	return project?.summary ?? project?.short_description ?? project?.description ?? ''
}

function projectIcon(project) {
	return project?.icon_url ?? project?.icon ?? project?.logo?.thumbnailUrl ?? null
}

function projectDownloads(project) {
	const value = Number(project?.downloads ?? project?.downloadCount ?? project?.download_count)
	return Number.isFinite(value) ? value : null
}

function projectStatus(project) {
	return project?.status ?? project?.requested_status ?? null
}

function projectTimestamp(project, fields) {
	for (const field of fields) {
		const raw = project?.[field]
		if (raw == null || raw === '') continue

		if (typeof raw === 'number' && Number.isFinite(raw)) {
			return raw > 1_000_000_000_000 ? raw : raw * 1000
		}

		const parsed = Date.parse(String(raw))
		if (Number.isFinite(parsed)) return parsed
	}
	return 0
}

function projectUpdated(project) {
	return projectTimestamp(project, [
		'updated',
		'date_modified',
		'dateModified',
		'modified',
		'modifiedAt',
		'updatedAt',
		'lastUpdated',
		'dateReleased',
		'date_released',
		'latestFileDate',
	])
}

function projectCreated(project) {
	return projectTimestamp(project, [
		'published',
		'date_created',
		'dateCreated',
		'created',
		'createdAt',
	])
}

function missingProject(id, provider) {
	return {
		id,
		name: `${provider === 'modrinth' ? 'Modrinth' : 'CurseForge'} project ${id}`,
		_missing: true,
	}
}

const modrinthById = computed(
	() => new Map(modrinthProjects.value.map((project) => [projectId(project), project])),
)
const curseForgeById = computed(
	() => new Map(curseForgeProjects.value.map((project) => [projectId(project), project])),
)

const cards = computed(() => {
	const result = []
	const usedModrinth = new Set()
	const usedCurseForge = new Set()

	for (const link of projectLinks.value) {
		const modrinth = modrinthById.value.get(String(link.modrinth)) ?? null
		const curseforge = curseForgeById.value.get(String(link.curseforge)) ?? null
		if (!modrinth && !curseforge) continue

		usedModrinth.add(String(link.modrinth))
		usedCurseForge.add(String(link.curseforge))
		result.push({
			id: `linked:${link.id}`,
			kind: 'linked',
			link,
			modrinth: modrinth ?? missingProject(link.modrinth, 'modrinth'),
			curseforge: curseforge ?? missingProject(link.curseforge, 'curseforge'),
		})
	}

	for (const project of modrinthProjects.value) {
		const id = projectId(project)
		if (!id || usedModrinth.has(id)) continue
		result.push({ id: `modrinth:${id}`, kind: 'modrinth', modrinth: project, curseforge: null })
	}

	for (const project of curseForgeProjects.value) {
		const id = projectId(project)
		if (!id || usedCurseForge.has(id)) continue
		result.push({ id: `curseforge:${id}`, kind: 'curseforge', modrinth: null, curseforge: project })
	}

	return result
})

function primaryProject(card) {
	const modrinth = card?.modrinth?._missing ? null : card?.modrinth
	const curseforge = card?.curseforge?._missing ? null : card?.curseforge
	return modrinth || curseforge || card?.modrinth || card?.curseforge || null
}

function cardTitle(card) {
	return projectName(primaryProject(card))
}

function cardSummary(card) {
	return projectSummary(primaryProject(card))
}

function cardIcon(card) {
	return projectIcon(primaryProject(card))
}

function cardDownloads(card) {
	const mr = card?.modrinth?._missing ? null : projectDownloads(card?.modrinth)
	const cf = card?.curseforge?._missing ? null : projectDownloads(card?.curseforge)
	if (card?.kind === 'linked') {
		const values = [mr, cf].filter((value) => value != null)
		return values.length ? values.reduce((total, value) => total + value, 0) : null
	}
	return mr ?? cf
}

function cardUpdated(card) {
	return Math.max(
		card?.modrinth?._missing ? 0 : projectUpdated(card?.modrinth),
		card?.curseforge?._missing ? 0 : projectUpdated(card?.curseforge),
	)
}

function cardCreated(card) {
	return Math.max(
		card?.modrinth?._missing ? 0 : projectCreated(card?.modrinth),
		card?.curseforge?._missing ? 0 : projectCreated(card?.curseforge),
	)
}

function providerClass(provider) {
	return provider === 'modrinth' ? 'provider-modrinth' : 'provider-curseforge'
}

function formatDownloads(value) {
	return value == null ? '—' : numberFormatter.format(value)
}

function compareProjectCards(a, b) {
	const byName = cardTitle(a).localeCompare(cardTitle(b), undefined, { sensitivity: 'base' })

	switch (sortMode.value) {
		case 'downloads':
			return (cardDownloads(b) ?? -1) - (cardDownloads(a) ?? -1) || byName
		case 'newest':
			return cardCreated(b) - cardCreated(a) || byName
		case 'name-desc':
			return -byName
		case 'name-asc':
			return byName
		case 'updated':
		default:
			return cardUpdated(b) - cardUpdated(a) || byName
	}
}

const filteredCards = computed(() => {
	const query = searchQuery.value.trim().toLowerCase()
	const filtered = cards.value.filter((card) => {
		if (sourceFilter.value === 'synced' && card.kind !== 'linked') return false
		if (sourceFilter.value === 'modrinth' && !card.modrinth) return false
		if (sourceFilter.value === 'curseforge' && !card.curseforge) return false
		if (!query) return true

		const text = [
			cardTitle(card),
			cardSummary(card),
			card.modrinth?.id,
			card.curseforge?.id,
			card.modrinth?.slug,
			card.curseforge?.slug,
		]
			.filter(Boolean)
			.join(' ')
			.toLowerCase()
		return text.includes(query)
	})

	return filtered.sort(compareProjectCards)
})

const counts = computed(() => ({
	all: cards.value.length,
	modrinth: cards.value.filter((card) => !!card.modrinth).length,
	curseforge: cards.value.filter((card) => !!card.curseforge).length,
	synced: cards.value.filter((card) => card.kind === 'linked').length,
}))

async function refreshProjects() {
	loading.value = true
	errorMessage.value = ''
	curseForgeError.value = ''
	curseForgePortalNeedsLogin.value = false

	try {
		const credentials = await getModrinthCredentials().catch(() => null)
		const jobs = []

		if (credentials?.user_id) {
			jobs.push(
				get_user_projects(credentials.user_id)
					.then((projects) => {
						modrinthProjects.value = Array.isArray(projects) ? projects : []
					})
					.catch((error) => {
						modrinthProjects.value = []
						throw new Error(`Modrinth: ${error instanceof Error ? error.message : String(error)}`)
					}),
			)
		} else {
			modrinthProjects.value = []
		}

		if (isCurseForgeAuthenticated()) {
			jobs.push(
				getCurseForgeAuthorProjects()
					.then((response) => {
						curseForgePortalNeedsLogin.value = !!response?.needsLogin
						curseForgeProjects.value = Array.isArray(response?.projects) ? response.projects : []
						if (response?.error) curseForgeError.value = String(response.error)
					})
					.catch((error) => {
						curseForgeProjects.value = []
						curseForgeError.value = error instanceof Error ? error.message : String(error)
					}),
			)
		} else {
			curseForgeProjects.value = []
		}

		const results = await Promise.allSettled(jobs)
		const rejected = results.find((result) => result.status === 'rejected')
		if (rejected?.reason) {
			errorMessage.value = rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason)
		}
	} finally {
		projectLinks.value = getCreatorProjectLinks()
		loading.value = false
	}
}

function editFieldSource(card) {
	const mr = card?.modrinth?._missing ? null : card?.modrinth
	const cf = card?.curseforge?._missing ? null : card?.curseforge
	return mr || cf || card?.modrinth || card?.curseforge || {}
}

function openEdit(card) {
	const source = editFieldSource(card)
	editCard.value = card
	editResults.value = []
	editProviders.value = {
		modrinth: !!card.modrinth,
		curseforge: !!card.curseforge,
	}
	const values = {
		name: projectName(source, ''),
		summary: source.summary ?? '',
		description: source.description ?? '',
		sourceUrl: source.source_url ?? source.sourceUrl ?? '',
		issuesUrl: source.issues_url ?? source.issuesUrl ?? '',
	}
	editForm.value = { ...values }
	editInitial.value = { ...values }
}

function closeEdit() {
	if (editBusy.value) return
	editCard.value = null
	editInitial.value = null
	editResults.value = []
}

function changedEditFields() {
	if (!editInitial.value) return { ...editForm.value }
	const changed = {}
	for (const key of Object.keys(editForm.value)) {
		if (String(editForm.value[key] ?? '') !== String(editInitial.value[key] ?? '')) {
			changed[key] = editForm.value[key]
		}
	}
	return changed
}

async function saveEdit() {
	if (!editCard.value || editBusy.value) return
	if (!editProviders.value.modrinth && !editProviders.value.curseforge) {
		editResults.value = [{ provider: 'Fodrinth', ok: false, message: 'Choose at least one provider.' }]
		return
	}

	const changed = changedEditFields()
	if (!Object.keys(changed).length) {
		editResults.value = [{ provider: 'Fodrinth', ok: true, message: 'No fields changed.' }]
		return
	}

	editBusy.value = true
	editResults.value = []
	try {
		const jobs = []

		if (editProviders.value.modrinth && editCard.value.modrinth) {
			const project = editCard.value.modrinth
			const patch = {}
			if ('name' in changed) patch.name = changed.name
			if ('summary' in changed) patch.summary = changed.summary
			if ('description' in changed) patch.description = changed.description
			if ('sourceUrl' in changed) patch.source_url = String(changed.sourceUrl).trim() || null
			if ('issuesUrl' in changed) patch.issues_url = String(changed.issuesUrl).trim() || null
			jobs.push({
				provider: 'Modrinth',
				promise: client.labrinth.projects_v3.edit(project.id, patch),
			})
		}

		if (editProviders.value.curseforge && editCard.value.curseforge) {
			jobs.push({
				provider: 'CurseForge',
				promise: updateCurseForgeProject(editCard.value.curseforge.id, changed),
			})
		}

		const settled = await Promise.allSettled(jobs.map((job) => job.promise))
		editResults.value = settled.map((result, index) => ({
			provider: jobs[index].provider,
			ok: result.status === 'fulfilled',
			message:
				result.status === 'fulfilled'
					? 'Saved'
					: result.reason instanceof Error
						? result.reason.message
						: String(result.reason),
		}))

		if (editResults.value.some((result) => result.ok)) {
			editInitial.value = { ...editForm.value }
			await refreshProjects()
		}
	} catch (error) {
		editResults.value = [{
			provider: 'Fodrinth',
			ok: false,
			message: error instanceof Error ? error.message : String(error),
		}]
	} finally {
		editBusy.value = false
	}
}

function csvValues(value) {
	return String(value ?? '')
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean)
		.filter((part, index, values) => values.indexOf(part) === index)
}

function modrinthLoaderName(value) {
	const text = String(value ?? '').trim()
	const key = text.toLowerCase().replace(/[ _-]+/g, '')
	const known = {
		neoforge: 'neoforge',
		forge: 'forge',
		fabric: 'fabric',
		quilt: 'quilt',
		liteloader: 'liteloader',
		rift: 'rift',
		bukkit: 'bukkit',
		spigot: 'spigot',
		paper: 'paper',
		purpur: 'purpur',
		folia: 'folia',
		velocity: 'velocity',
		waterfall: 'waterfall',
	}
	return known[key] || text.toLowerCase()
}

function openUpload(card) {
	const source = editFieldSource(card)
	const gameVersions = source.game_versions ?? source.gameVersions ?? []
	const loaders = source.loaders ?? []
	uploadCard.value = card
	uploadResults.value = []
	uploadProgress.value = { modrinth: null, curseforge: null }
	uploadProviders.value = {
		modrinth: !!card.modrinth,
		curseforge: !!card.curseforge,
	}
	uploadForm.value = {
		file: null,
		versionNumber: '',
		name: '',
		releaseType: 'release',
		gameVersions: Array.isArray(gameVersions) ? gameVersions.join(', ') : '',
		loaders: Array.isArray(loaders) ? loaders.join(', ') : '',
		changelog: '',
	}
}

function closeUpload() {
	if (uploadBusy.value) return
	uploadCard.value = null
	uploadResults.value = []
}

function onUploadFile(event) {
	uploadForm.value.file = event.target?.files?.[0] ?? null
}

function modrinthProjectType(project) {
	const types = project?.project_types
	if (Array.isArray(types) && types.length) return types[0]
	return project?.project_type ?? null
}

async function saveUpload() {
	if (!uploadCard.value || uploadBusy.value) return
	const file = uploadForm.value.file
	if (!(file instanceof File)) {
		uploadResults.value = [{ provider: 'Fodrinth', ok: false, message: 'Choose a file first.' }]
		return
	}
	if (!uploadForm.value.versionNumber.trim()) {
		uploadResults.value = [{ provider: 'Fodrinth', ok: false, message: 'Enter a version number.' }]
		return
	}
	if (!uploadProviders.value.modrinth && !uploadProviders.value.curseforge) {
		uploadResults.value = [{ provider: 'Fodrinth', ok: false, message: 'Choose at least one provider.' }]
		return
	}

	const gameVersions = csvValues(uploadForm.value.gameVersions)
	const loaders = csvValues(uploadForm.value.loaders)
	if (uploadProviders.value.modrinth && (!gameVersions.length || !loaders.length)) {
		uploadResults.value = [{
			provider: 'Modrinth',
			ok: false,
			message: 'Modrinth requires at least one game version and loader.',
		}]
		return
	}

	uploadBusy.value = true
	uploadResults.value = []
	uploadProgress.value = { modrinth: null, curseforge: null }
	try {
		const jobs = []
		const release = {
			versionNumber: uploadForm.value.versionNumber.trim(),
			name: uploadForm.value.name.trim() || uploadForm.value.versionNumber.trim(),
			releaseType: uploadForm.value.releaseType,
			gameVersions,
			loaders,
			changelog: uploadForm.value.changelog,
		}

		if (uploadProviders.value.modrinth && uploadCard.value.modrinth) {
			const project = uploadCard.value.modrinth
			const modrinthLoaders = release.loaders.map(modrinthLoaderName)
			const handle = client.labrinth.versions_v3.createVersion(
				{
					project_id: project.id,
					version_number: release.versionNumber,
					name: release.name,
					changelog: release.changelog,
					dependencies: [],
					game_versions: release.gameVersions,
					version_type: release.releaseType,
					featured: false,
					loaders: modrinthLoaders,
				},
				[{ file }],
				modrinthProjectType(project),
			)
			handle.onProgress((progress) => {
				uploadProgress.value = {
					...uploadProgress.value,
					modrinth: Math.round((progress?.progress ?? 0) * 100),
				}
			})
			jobs.push({ provider: 'Modrinth', promise: handle.promise })
		}

		if (uploadProviders.value.curseforge && uploadCard.value.curseforge) {
			jobs.push({
				provider: 'CurseForge',
				promise: uploadCurseForgeProjectFile(uploadCard.value.curseforge.id, file, release),
			})
		}

		const settled = await Promise.allSettled(jobs.map((job) => job.promise))
		uploadResults.value = settled.map((result, index) => ({
			provider: jobs[index].provider,
			ok: result.status === 'fulfilled',
			message:
				result.status === 'fulfilled'
					? 'Uploaded'
					: result.reason instanceof Error
						? result.reason.message
						: String(result.reason),
		}))
	} catch (error) {
		uploadResults.value = [{
			provider: 'Fodrinth',
			ok: false,
			message: error instanceof Error ? error.message : String(error),
		}]
	} finally {
		uploadBusy.value = false
	}
}

const alreadyLinkedModrinth = computed(
	() => new Set(projectLinks.value.map((link) => String(link.modrinth))),
)
const alreadyLinkedCurseForge = computed(
	() => new Set(projectLinks.value.map((link) => String(link.curseforge))),
)

const syncTargets = computed(() => {
	if (!syncCard.value || syncCard.value.kind === 'linked') return []
	const fromModrinth = !!syncCard.value.modrinth
	const sourceName = cardTitle(syncCard.value).trim().toLowerCase()
	const projects = fromModrinth
		? curseForgeProjects.value.filter((project) => !alreadyLinkedCurseForge.value.has(projectId(project)))
		: modrinthProjects.value.filter((project) => !alreadyLinkedModrinth.value.has(projectId(project)))

	return projects
		.map((project) => ({
			id: projectId(project),
			name: projectName(project),
			exactName: projectName(project).trim().toLowerCase() === sourceName,
		}))
		.sort((a, b) => Number(b.exactName) - Number(a.exactName) || a.name.localeCompare(b.name))
})

function openSync(card) {
	if (card.kind === 'linked') return
	syncCard.value = card
	syncTargetId.value = ''
	syncError.value = ''
	queueMicrotask(() => {
		const exact = syncTargets.value.find((target) => target.exactName)
		if (exact) syncTargetId.value = exact.id
	})
}

function closeSync() {
	syncCard.value = null
	syncTargetId.value = ''
	syncError.value = ''
}

function confirmSync() {
	if (!syncCard.value || !syncTargetId.value) {
		syncError.value = 'Choose the matching project on the other platform.'
		return
	}

	try {
		if (syncCard.value.modrinth) {
			linkCreatorProjects(syncCard.value.modrinth.id, syncTargetId.value)
		} else {
			linkCreatorProjects(syncTargetId.value, syncCard.value.curseforge.id)
		}
		projectLinks.value = getCreatorProjectLinks()
		closeSync()
	} catch (error) {
		syncError.value = error instanceof Error ? error.message : String(error)
	}
}

function unlinkCard(card) {
	if (card.kind !== 'linked' || !card.link?.id) return
	unlinkCreatorProjects(card.link.id)
	projectLinks.value = getCreatorProjectLinks()
}

function updateLinks() {
	projectLinks.value = getCreatorProjectLinks()
}

function handleCurseForgeAuthChanged() {
	void refreshProjects()
}

onMounted(() => {
	window.addEventListener(CREATOR_PROJECT_LINKS_CHANGED_EVENT, updateLinks)
	window.addEventListener(CURSEFORGE_AUTH_CHANGED_EVENT, handleCurseForgeAuthChanged)
	void refreshProjects()
})

onBeforeUnmount(() => {
	window.removeEventListener(CREATOR_PROJECT_LINKS_CHANGED_EVENT, updateLinks)
	window.removeEventListener(CURSEFORGE_AUTH_CHANGED_EVENT, handleCurseForgeAuthChanged)
})
</script>

<template>
	<div class="w-full p-6 md:p-8">
		<div class="mx-auto flex max-w-7xl flex-col gap-4 pb-20">
			<header class="flex flex-wrap items-start justify-between gap-4">
				<div>
					<h1 class="m-0 text-2xl font-semibold text-contrast md:text-3xl">Projects</h1>
					<p class="mb-0 mt-1 max-w-3xl text-secondary">
						Manage Modrinth and CurseForge publications separately, or synchronize matching projects into one creator card.
					</p>
				</div>
				<div class="flex flex-wrap gap-2">
					<button
						v-if="!isCurseForgeAuthenticated()"
						type="button"
						class="project-button secondary"
						@click="openCurseForgeAuth"
					>
						<CurseForgeIcon class="size-4" />
						Connect CurseForge
					</button>
					<button
						type="button"
						class="project-button secondary"
						:disabled="loading"
						@click="refreshProjects"
					>
						<RefreshCwIcon class="size-4" :class="{ 'animate-spin': loading }" />
						Refresh
					</button>
				</div>
			</header>

			<div
				v-if="curseForgePortalNeedsLogin"
				class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-solid border-surface-5 bg-surface-2 px-4 py-3 text-sm text-secondary"
			>
				<span>Sign in to CurseForge Authors in the Fodrinth window so the app can load your private creator project list.</span>
				<button type="button" class="project-button secondary compact" @click="openCurseForgeAuthorPortal">
					Open CurseForge Authors
				</button>
			</div>
			<div v-if="errorMessage" class="notice error">{{ errorMessage }}</div>
			<div v-if="curseForgeError" class="notice warning">CurseForge: {{ curseForgeError }}</div>

			<div class="flex flex-col gap-3 rounded-2xl border border-solid border-surface-5 bg-surface-3 p-3">
				<div class="flex flex-wrap items-center gap-2">
					<button
						v-for="filter in [
							{ id: 'all', label: 'All' },
							{ id: 'modrinth', label: 'Modrinth' },
							{ id: 'curseforge', label: 'CurseForge' },
							{ id: 'synced', label: 'Synced' },
						]"
						:key="filter.id"
						type="button"
						class="filter-button"
						:class="{ active: sourceFilter === filter.id }"
						@click="sourceFilter = filter.id"
					>
						{{ filter.label }}
						<span class="filter-count">{{ counts[filter.id] }}</span>
					</button>
				</div>
				<div class="grid gap-2 md:grid-cols-[minmax(0,1fr)_14rem]">
					<input
						v-model="searchQuery"
						type="search"
						class="project-input"
						placeholder="Search your projects…"
					/>
					<select v-model="sortMode" class="project-input" aria-label="Sort projects">
						<option value="updated">Recently updated</option>
						<option value="downloads">Downloads</option>
						<option value="newest">Newest</option>
						<option value="name-asc">Name A–Z</option>
						<option value="name-desc">Name Z–A</option>
					</select>
				</div>
			</div>

			<div v-if="loading && cards.length === 0" class="empty-state">
				<RefreshCwIcon class="size-7 animate-spin" />
				<span>Loading creator projects…</span>
			</div>

			<div v-else-if="filteredCards.length === 0" class="empty-state">
				<PackageIcon class="size-8" />
				<div class="text-center">
					<div class="font-semibold text-contrast">No projects to show</div>
					<p class="m-0 mt-1 text-sm text-secondary">
						Sign in to Modrinth and connect CurseForge, or change the current filter.
					</p>
				</div>
			</div>

			<div v-else class="project-grid">
				<article v-for="card in filteredCards" :key="card.id" class="project-card">
					<div class="provider-corner">
						<span
							v-if="card.modrinth"
							class="provider-badge"
							:class="[providerClass('modrinth'), { missing: card.modrinth._missing }]"
							title="Modrinth"
						>
							<ModrinthIcon class="size-4" />
						</span>
						<span
							v-if="card.curseforge"
							class="provider-badge"
							:class="[providerClass('curseforge'), { missing: card.curseforge._missing }]"
							title="CurseForge"
						>
							<CurseForgeIcon class="size-4" />
						</span>
					</div>

					<div class="project-card-main">
						<div class="project-image">
							<img v-if="cardIcon(card)" :src="cardIcon(card)" alt="" />
							<PackageIcon v-else class="size-8 text-secondary" />
						</div>
						<div class="min-w-0 flex-1 pr-12">
							<div class="flex min-w-0 items-center gap-2">
								<h2 class="m-0 truncate text-base font-semibold text-contrast">{{ cardTitle(card) }}</h2>
								<span v-if="card.kind === 'linked'" class="synced-chip">Synced</span>
							</div>
							<p class="project-summary">{{ cardSummary(card) || 'No project summary.' }}</p>
							<div class="project-meta">
								<span>{{ formatDownloads(cardDownloads(card)) }} downloads</span>
								<span v-if="projectStatus(primaryProject(card))">{{ projectStatus(primaryProject(card)) }}</span>
							</div>
						</div>
					</div>

					<div class="provider-lines">
						<div v-if="card.modrinth" class="provider-line">
							<span class="inline-flex items-center gap-2"><ModrinthIcon class="size-3.5" />Modrinth</span>
							<code>{{ card.modrinth.id }}</code>
						</div>
						<div v-if="card.curseforge" class="provider-line">
							<span class="inline-flex items-center gap-2"><CurseForgeIcon class="size-3.5" />CurseForge</span>
							<code>{{ card.curseforge.id }}</code>
						</div>
					</div>

					<div class="project-actions">
						<button type="button" class="project-button secondary compact" @click="openEdit(card)">Edit</button>
						<button type="button" class="project-button primary compact" @click="openUpload(card)">Upload file</button>
						<button
							v-if="card.kind !== 'linked'"
							type="button"
							class="project-button secondary compact"
							@click="openSync(card)"
						>
							Sync
						</button>
						<button
							v-else
							type="button"
							class="project-button subtle compact"
							@click="unlinkCard(card)"
						>
							Unlink
						</button>
					</div>
				</article>
			</div>
		</div>
	</div>

	<Teleport to="body">
		<div v-if="syncCard" class="modal-backdrop" @mousedown.self="closeSync">
			<section class="creator-modal small" role="dialog" aria-modal="true">
				<header class="modal-header">
					<div>
						<h2>Synchronize project</h2>
						<p>Link {{ cardTitle(syncCard) }} to its publication on the other platform.</p>
					</div>
					<button type="button" class="modal-close" @click="closeSync">×</button>
				</header>
				<div class="modal-body">
					<label class="field-label">
						Matching {{ syncCard.modrinth ? 'CurseForge' : 'Modrinth' }} project
						<select v-model="syncTargetId" class="project-input">
							<option value="">Choose a project…</option>
							<option v-for="target in syncTargets" :key="target.id" :value="target.id">
								{{ target.name }}{{ target.exactName ? ' — likely match' : '' }}
							</option>
						</select>
					</label>
					<p v-if="syncTargets.length === 0" class="m-0 text-sm text-secondary">
						No unlinked projects from the other platform are currently loaded.
					</p>
					<div v-if="syncError" class="notice error">{{ syncError }}</div>
				</div>
				<footer class="modal-footer">
					<button type="button" class="project-button secondary" @click="closeSync">Cancel</button>
					<button type="button" class="project-button primary" :disabled="!syncTargetId" @click="confirmSync">
						Synchronize
					</button>
				</footer>
			</section>
		</div>

		<div v-if="editCard" class="modal-backdrop" @mousedown.self="closeEdit">
			<section class="creator-modal" role="dialog" aria-modal="true">
				<header class="modal-header">
					<div>
						<h2>Edit project</h2>
						<p>Shared fields can be pushed to one or both linked publications.</p>
					</div>
					<button type="button" class="modal-close" :disabled="editBusy" @click="closeEdit">×</button>
				</header>
				<div class="modal-body">
					<div class="provider-picker">
						<label v-if="editCard.modrinth">
							<input v-model="editProviders.modrinth" type="checkbox" />
							<ModrinthIcon class="size-4" /> Modrinth
						</label>
						<label v-if="editCard.curseforge">
							<input v-model="editProviders.curseforge" type="checkbox" />
							<CurseForgeIcon class="size-4" /> CurseForge
						</label>
					</div>

					<label class="field-label">Name<input v-model="editForm.name" class="project-input" /></label>
					<label class="field-label">Summary<input v-model="editForm.summary" class="project-input" /></label>
					<label class="field-label">
						Description
						<textarea v-model="editForm.description" class="project-input textarea" rows="8"></textarea>
					</label>
					<div class="grid gap-3 md:grid-cols-2">
						<label class="field-label">Source URL<input v-model="editForm.sourceUrl" class="project-input" /></label>
						<label class="field-label">Issue tracker URL<input v-model="editForm.issuesUrl" class="project-input" /></label>
					</div>

					<div v-if="editResults.length" class="result-stack">
						<div v-for="result in editResults" :key="result.provider" class="result-row" :class="result.ok ? 'success' : 'failed'">
							<strong>{{ result.provider }}</strong>
							<span>{{ result.message }}</span>
						</div>
					</div>
				</div>
				<footer class="modal-footer">
					<button type="button" class="project-button secondary" :disabled="editBusy" @click="closeEdit">Close</button>
					<button type="button" class="project-button primary" :disabled="editBusy" @click="saveEdit">
						<RefreshCwIcon v-if="editBusy" class="size-4 animate-spin" />
						Save changes
					</button>
				</footer>
			</section>
		</div>

		<div v-if="uploadCard" class="modal-backdrop" @mousedown.self="closeUpload">
			<section class="creator-modal" role="dialog" aria-modal="true">
				<header class="modal-header">
					<div>
						<h2>Upload file</h2>
						<p>Publish one artifact to the selected provider publications. Successful uploads are kept if another provider fails.</p>
					</div>
					<button type="button" class="modal-close" :disabled="uploadBusy" @click="closeUpload">×</button>
				</header>
				<div class="modal-body">
					<div class="provider-picker">
						<label v-if="uploadCard.modrinth">
							<input v-model="uploadProviders.modrinth" type="checkbox" />
							<ModrinthIcon class="size-4" /> Modrinth
						</label>
						<label v-if="uploadCard.curseforge">
							<input v-model="uploadProviders.curseforge" type="checkbox" />
							<CurseForgeIcon class="size-4" /> CurseForge
						</label>
					</div>

					<label class="file-drop">
						<input type="file" :disabled="uploadBusy" @change="onUploadFile" />
						<PackageIcon class="size-7" />
						<span>{{ uploadForm.file?.name || 'Choose JAR, ZIP, MRPACK or another release artifact' }}</span>
					</label>

					<div class="grid gap-3 md:grid-cols-2">
						<label class="field-label">Version number<input v-model="uploadForm.versionNumber" class="project-input" placeholder="8.0.14" /></label>
						<label class="field-label">Display name<input v-model="uploadForm.name" class="project-input" placeholder="Defaults to version number" /></label>
						<label class="field-label">
							Release type
							<select v-model="uploadForm.releaseType" class="project-input">
								<option value="release">Release</option>
								<option value="beta">Beta</option>
								<option value="alpha">Alpha</option>
							</select>
						</label>
						<label class="field-label">Minecraft versions<input v-model="uploadForm.gameVersions" class="project-input" placeholder="1.21.1, 1.21.11" /></label>
						<label class="field-label md:col-span-2">Loaders<input v-model="uploadForm.loaders" class="project-input" placeholder="NeoForge, Forge, Fabric" /></label>
					</div>
					<label class="field-label">
						Changelog (Markdown)
						<textarea v-model="uploadForm.changelog" class="project-input textarea" rows="7"></textarea>
					</label>

					<div v-if="uploadProgress.modrinth != null" class="upload-progress">
						<div class="flex justify-between text-xs text-secondary"><span>Modrinth upload</span><span>{{ uploadProgress.modrinth }}%</span></div>
						<div class="progress-track"><div class="progress-value" :style="{ width: `${uploadProgress.modrinth}%` }"></div></div>
					</div>

					<div v-if="uploadResults.length" class="result-stack">
						<div v-for="result in uploadResults" :key="result.provider" class="result-row" :class="result.ok ? 'success' : 'failed'">
							<strong>{{ result.provider }}</strong>
							<span>{{ result.message }}</span>
						</div>
					</div>
				</div>
				<footer class="modal-footer">
					<button type="button" class="project-button secondary" :disabled="uploadBusy" @click="closeUpload">Close</button>
					<button type="button" class="project-button primary" :disabled="uploadBusy" @click="saveUpload">
						<RefreshCwIcon v-if="uploadBusy" class="size-4 animate-spin" />
						Upload
					</button>
				</footer>
			</section>
		</div>
	</Teleport>
</template>

<style scoped>
.project-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr));
	gap: 0.8rem;
}

.project-card {
	position: relative;
	display: flex;
	min-height: 220px;
	flex-direction: column;
	gap: 0.8rem;
	border: 1px solid var(--color-surface-5);
	border-radius: 1rem;
	background: var(--color-surface-3);
	padding: 1rem;
	transition: border-color 120ms ease, transform 120ms ease, background 120ms ease;
}

.project-card:hover {
	border-color: color-mix(in srgb, var(--color-brand) 36%, var(--color-surface-5));
	background: color-mix(in srgb, var(--color-surface-3) 94%, var(--color-brand));
	transform: translateY(-1px);
}

.project-card-main {
	display: flex;
	align-items: flex-start;
	gap: 0.9rem;
}

.project-image {
	display: flex;
	width: 4.5rem;
	height: 4.5rem;
	flex: 0 0 auto;
	align-items: center;
	justify-content: center;
	overflow: hidden;
	border-radius: 0.85rem;
	background: var(--color-surface-4);
}

.project-image img {
	width: 100%;
	height: 100%;
	object-fit: cover;
}

.project-summary {
	display: -webkit-box;
	overflow: hidden;
	margin: 0.35rem 0 0;
	color: var(--color-secondary);
	font-size: 0.85rem;
	line-height: 1.35;
	-webkit-box-orient: vertical;
	-webkit-line-clamp: 2;
}

.project-meta {
	display: flex;
	flex-wrap: wrap;
	gap: 0.35rem 0.75rem;
	margin-top: 0.55rem;
	color: var(--color-secondary);
	font-size: 0.75rem;
}

.provider-corner {
	position: absolute;
	top: 0.75rem;
	right: 0.75rem;
	display: flex;
	gap: 0.35rem;
}

.provider-badge {
	display: inline-flex;
	width: 2rem;
	height: 2rem;
	align-items: center;
	justify-content: center;
	border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
	border-radius: 0.65rem;
	box-shadow: 0 5px 18px rgb(0 0 0 / 12%);
}

.provider-badge.missing {
	opacity: 0.45;
}

.provider-modrinth {
	background: color-mix(in srgb, #1bd96a 16%, var(--color-surface-2));
	color: #1bd96a;
}

.provider-curseforge {
	background: color-mix(in srgb, #ff7849 16%, var(--color-surface-2));
	color: #ff7849;
}

.synced-chip {
	flex: 0 0 auto;
	border: 1px solid color-mix(in srgb, var(--color-brand) 35%, transparent);
	border-radius: 999px;
	background: color-mix(in srgb, var(--color-brand) 12%, transparent);
	padding: 0.15rem 0.45rem;
	color: var(--color-brand);
	font-size: 0.65rem;
	font-weight: 700;
	text-transform: uppercase;
}

.provider-lines {
	display: flex;
	flex-direction: column;
	gap: 0.35rem;
	border-top: 1px solid var(--color-surface-4);
	padding-top: 0.65rem;
}

.provider-line {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 1rem;
	color: var(--color-secondary);
	font-size: 0.75rem;
}

.provider-line code {
	overflow: hidden;
	max-width: 50%;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.project-actions {
	display: flex;
	flex-wrap: wrap;
	gap: 0.45rem;
	margin-top: auto;
}

.project-button {
	display: inline-flex;
	min-height: 2.4rem;
	align-items: center;
	justify-content: center;
	gap: 0.45rem;
	border: 1px solid transparent;
	border-radius: 0.7rem;
	padding: 0.45rem 0.85rem;
	font: inherit;
	font-size: 0.875rem;
	font-weight: 600;
	cursor: pointer;
	transition: filter 100ms ease, background 100ms ease;
}

.project-button.compact {
	min-height: 2rem;
	padding: 0.3rem 0.65rem;
	font-size: 0.78rem;
}

.project-button.primary {
	background: var(--color-brand);
	color: var(--color-button-text, white);
}

.project-button.secondary {
	border-color: var(--color-surface-5);
	background: var(--color-surface-3);
	color: var(--color-primary);
}

.project-button.subtle {
	background: transparent;
	color: var(--color-secondary);
}

.project-button:hover:not(:disabled) {
	filter: brightness(1.08);
}

.project-button:disabled {
	cursor: not-allowed;
	opacity: 0.55;
}

.filter-button {
	display: inline-flex;
	align-items: center;
	gap: 0.5rem;
	border: 1px solid transparent;
	border-radius: 0.7rem;
	background: transparent;
	padding: 0.45rem 0.7rem;
	color: var(--color-primary);
	font: inherit;
	font-size: 0.82rem;
	font-weight: 600;
	cursor: pointer;
}

.filter-button.active {
	border-color: var(--color-surface-5);
	background: var(--color-surface-5);
	color: var(--color-contrast);
}

.filter-count {
	border-radius: 999px;
	background: var(--color-surface-2);
	padding: 0.08rem 0.38rem;
	font-size: 0.7rem;
}

.project-input {
	box-sizing: border-box;
	width: 100%;
	min-height: 2.5rem;
	border: 1px solid var(--color-surface-5);
	border-radius: 0.7rem;
	background: var(--color-surface-2);
	padding: 0.55rem 0.7rem;
	color: var(--color-primary);
	font: inherit;
	outline: none;
}

.project-input:focus {
	border-color: var(--color-brand);
}

.project-input.textarea {
	resize: vertical;
	line-height: 1.45;
}

.empty-state {
	display: flex;
	min-height: 14rem;
	align-items: center;
	justify-content: center;
	gap: 0.8rem;
	border: 1px dashed var(--color-surface-5);
	border-radius: 1rem;
	color: var(--color-secondary);
}

.notice {
	border: 1px solid var(--color-surface-5);
	border-radius: 0.75rem;
	background: var(--color-surface-2);
	padding: 0.75rem 0.9rem;
	font-size: 0.82rem;
}

.notice.error {
	border-color: color-mix(in srgb, #ef4444 38%, var(--color-surface-5));
	color: #ef7777;
}

.notice.warning {
	border-color: color-mix(in srgb, #f59e0b 35%, var(--color-surface-5));
	color: var(--color-secondary);
}

.modal-backdrop {
	position: fixed;
	z-index: 100000;
	inset: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	background: rgb(0 0 0 / 62%);
	padding: 1rem;
	backdrop-filter: blur(5px);
}

.creator-modal {
	display: flex;
	width: min(760px, 100%);
	max-height: min(900px, 92vh);
	flex-direction: column;
	overflow: hidden;
	border: 1px solid var(--color-surface-5);
	border-radius: 1rem;
	background: var(--color-surface-3);
	box-shadow: 0 24px 90px rgb(0 0 0 / 40%);
}

.creator-modal.small {
	width: min(520px, 100%);
}

.modal-header,
.modal-footer {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 1rem;
	padding: 1rem 1.1rem;
}

.modal-header {
	border-bottom: 1px solid var(--color-surface-4);
}

.modal-header h2 {
	margin: 0;
	color: var(--color-contrast);
	font-size: 1.15rem;
}

.modal-header p {
	margin: 0.25rem 0 0;
	color: var(--color-secondary);
	font-size: 0.8rem;
}

.modal-close {
	border: 0;
	background: transparent;
	color: var(--color-secondary);
	font-size: 1.5rem;
	line-height: 1;
	cursor: pointer;
}

.modal-body {
	display: flex;
	flex-direction: column;
	gap: 0.9rem;
	overflow-y: auto;
	padding: 1.1rem;
}

.modal-footer {
	align-items: center;
	justify-content: flex-end;
	border-top: 1px solid var(--color-surface-4);
}

.field-label {
	display: flex;
	flex-direction: column;
	gap: 0.35rem;
	color: var(--color-primary);
	font-size: 0.78rem;
	font-weight: 600;
}

.provider-picker {
	display: flex;
	flex-wrap: wrap;
	gap: 0.55rem;
}

.provider-picker label {
	display: inline-flex;
	align-items: center;
	gap: 0.45rem;
	border: 1px solid var(--color-surface-5);
	border-radius: 0.65rem;
	background: var(--color-surface-2);
	padding: 0.45rem 0.65rem;
	color: var(--color-primary);
	font-size: 0.8rem;
	font-weight: 600;
}

.file-drop {
	display: flex;
	min-height: 6rem;
	align-items: center;
	justify-content: center;
	gap: 0.7rem;
	border: 1px dashed var(--color-surface-5);
	border-radius: 0.8rem;
	background: var(--color-surface-2);
	padding: 1rem;
	color: var(--color-secondary);
	text-align: center;
	cursor: pointer;
}

.file-drop input {
	position: absolute;
	width: 1px;
	height: 1px;
	opacity: 0;
}

.result-stack {
	display: flex;
	flex-direction: column;
	gap: 0.4rem;
}

.result-row {
	display: grid;
	grid-template-columns: 110px 1fr;
	gap: 0.7rem;
	border: 1px solid var(--color-surface-5);
	border-radius: 0.65rem;
	padding: 0.6rem 0.7rem;
	font-size: 0.78rem;
}

.result-row.success {
	border-color: color-mix(in srgb, #22c55e 35%, var(--color-surface-5));
}

.result-row.failed {
	border-color: color-mix(in srgb, #ef4444 35%, var(--color-surface-5));
}

.upload-progress {
	display: flex;
	flex-direction: column;
	gap: 0.35rem;
}

.progress-track {
	height: 0.4rem;
	overflow: hidden;
	border-radius: 999px;
	background: var(--color-surface-4);
}

.progress-value {
	height: 100%;
	border-radius: inherit;
	background: var(--color-brand);
	transition: width 120ms linear;
}
</style>
