import { invoke } from '@tauri-apps/api/core'

export const CURSEFORGE_USD_PER_POINT = 0.05

export async function openCurseForgeAuthorPortal() {
	return await invoke('plugin:utils|curseforge_open_author_portal')
}

export async function getCurseForgeAuthorAnalytics(periodDays = 30) {
	return await invoke('plugin:utils|curseforge_get_author_analytics', {
		periodDays,
	})
}
