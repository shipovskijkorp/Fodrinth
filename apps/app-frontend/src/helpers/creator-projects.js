import { invoke } from '@tauri-apps/api/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

import {
	getCurseForgeAuthHeaders,
	getCurseForgeToken,
	isCurseForgeAuthenticated,
} from '@/helpers/curseforge-auth.js'

const PROJECT_LINKS_STORAGE_KEY = 'fodrinth.creator.project-links.v1'
export const CREATOR_PROJECT_LINKS_CHANGED_EVENT = 'fodrinth:creator-project-links-changed'

function normalizeId(value) {
	const id = String(value ?? '').trim()
	return id || null
}

function readLinks() {
	const raw = localStorage.getItem(PROJECT_LINKS_STORAGE_KEY)
	if (!raw) return []
	try {
		const parsed = JSON.parse(raw)
		if (!Array.isArray(parsed)) return []
		return parsed
			.map((link) => ({
				id: normalizeId(link?.id) || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
				modrinth: normalizeId(link?.modrinth),
				curseforge: normalizeId(link?.curseforge),
				createdAt: link?.createdAt || new Date().toISOString(),
			}))
			.filter((link) => link.modrinth && link.curseforge)
	} catch {
		return []
	}
}

function writeLinks(links) {
	localStorage.setItem(PROJECT_LINKS_STORAGE_KEY, JSON.stringify(links))
	window.dispatchEvent(
		new CustomEvent(CREATOR_PROJECT_LINKS_CHANGED_EVENT, {
			detail: { links },
		}),
	)
}

export function getCreatorProjectLinks() {
	return readLinks()
}

export function linkCreatorProjects(modrinthProjectId, curseForgeProjectId) {
	const modrinth = normalizeId(modrinthProjectId)
	const curseforge = normalizeId(curseForgeProjectId)
	if (!modrinth || !curseforge) throw new Error('Both project IDs are required to synchronize projects.')

	const links = readLinks().filter(
		(link) => link.modrinth !== modrinth && link.curseforge !== curseforge,
	)
	const link = {
		id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
		modrinth,
		curseforge,
		createdAt: new Date().toISOString(),
	}
	links.push(link)
	writeLinks(links)
	return link
}

export function unlinkCreatorProjects(linkId) {
	const id = normalizeId(linkId)
	const links = readLinks().filter((link) => link.id !== id)
	writeLinks(links)
	return links
}

export async function getCurseForgeAuthorProjects() {
	return await invoke('plugin:utils|curseforge_get_author_projects')
}

async function readResponse(response, action) {
	const text = await response.text().catch(() => '')
	if (!response.ok) {
		const suffix = text ? `: ${text.slice(0, 500)}` : ''
		throw new Error(`CurseForge ${action} failed with HTTP ${response.status}${suffix}`)
	}
	if (!text) return null
	try {
		return JSON.parse(text)
	} catch {
		return text
	}
}

function requireCurseForgeToken() {
	const token = getCurseForgeToken()
	if (!token || !isCurseForgeAuthenticated()) {
		throw new Error('Connect a CurseForge author API token before changing projects.')
	}
	return token
}

export async function updateCurseForgeProject(projectId, patch) {
	requireCurseForgeToken()
	const id = normalizeId(projectId)
	if (!id) throw new Error('CurseForge project ID is missing.')

	const metadata = {}
	if (patch.name != null) metadata.name = String(patch.name)
	if (patch.summary != null) metadata.summary = String(patch.summary)
	if (patch.description != null) {
		metadata.description = String(patch.description)
		metadata.descriptionType = 'markdown'
	}
	if (patch.sourceUrl != null) metadata.sourceUrl = String(patch.sourceUrl)
	if (patch.issuesUrl != null) metadata.issueTrackerUrl = String(patch.issuesUrl)
	if (patch.license != null && String(patch.license).trim()) metadata.license = String(patch.license).trim()

	const form = new FormData()
	form.append('metadata', JSON.stringify(metadata))
	const response = await tauriFetch(
		`https://minecraft.curseforge.com/api/projects/${encodeURIComponent(id)}/update-project`,
		{
			method: 'POST',
			headers: getCurseForgeAuthHeaders(),
			body: form,
		},
	)
	return await readResponse(response, 'project update')
}

export async function uploadCurseForgeProjectFile(projectId, file, release) {
	requireCurseForgeToken()
	const id = normalizeId(projectId)
	if (!id) throw new Error('CurseForge project ID is missing.')
	if (!(file instanceof File)) throw new Error('Choose a file to upload.')

	const gameVersionNames = [
		...(release.gameVersions ?? []),
		...(release.loaders ?? []),
	]
		.map((value) => String(value).trim())
		.filter(Boolean)
		.filter((value, index, values) => values.indexOf(value) === index)

	const metadata = {
		changelog: String(release.changelog ?? ''),
		changelogType: 'markdown',
		displayName: String(release.name || release.versionNumber || file.name),
		releaseType: ['alpha', 'beta', 'release'].includes(release.releaseType)
			? release.releaseType
			: 'release',
	}
	if (gameVersionNames.length) metadata.gameVersionNames = gameVersionNames

	const form = new FormData()
	form.append('metadata', JSON.stringify(metadata))
	form.append('file', file, file.name)

	const response = await tauriFetch(
		`https://minecraft.curseforge.com/api/projects/${encodeURIComponent(id)}/upload-file`,
		{
			method: 'POST',
			headers: getCurseForgeAuthHeaders(),
			body: form,
		},
	)
	return await readResponse(response, 'file upload')
}
