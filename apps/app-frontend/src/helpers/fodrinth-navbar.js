import router from '@/routes'
import {
	CURSEFORGE_AUTH_CHANGED_EVENT,
	getCurseForgeProfile,
	isCurseForgeAuthenticated,
	openCurseForgeAuth,
	refreshCurseForgeProfile,
} from '@/helpers/curseforge-auth.js'

const PACKAGE_ICON = `
	<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M16.5 9.4 7.55 4.24" />
		<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
		<polyline points="3.29 7 12 12 20.71 7" />
		<line x1="12" x2="12" y1="22" y2="12" />
	</svg>
`

const ANALYTICS_ICON = `
	<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M3 3v18h18" />
		<path d="M18 17V9" />
		<path d="M13 17V5" />
		<path d="M8 17v-3" />
	</svg>
`

const CURSEFORGE_LOGO = `
	<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
		<path fill="currentColor" d="M18.326 9.2145S23.2261 8.4418 24 6.1882h-7.5066V4.4H0l2.0318 2.3576V9.173s5.1267-.2665 7.1098 1.2372c2.7146 2.516-3.053 5.917-3.053 5.917L5.0995 19.6c1.5465-1.4726 4.494-3.3775 9.8983-3.2857-2.0565.65-4.1245 1.6651-5.7344 3.2857h10.9248l-1.0288-3.2726s-7.918-4.6688-.8336-7.1127z" />
	</svg>
`

const LOGIN_ICON = `
	<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
		<polyline points="10 17 15 12 10 7" />
		<line x1="15" x2="3" y1="12" y2="12" />
	</svg>
`

const creatorTabs = [
	{
		className: 'fodrinth-projects-nav',
		label: 'Projects',
		path: '/projects',
		icon: PACKAGE_ICON,
	},
	{
		className: 'fodrinth-analytics-nav',
		label: 'Analytics',
		path: '/analytics',
		icon: ANALYTICS_ICON,
	},
]

function createCreatorNavButton(tab) {
	const button = document.createElement('button')
	button.type = 'button'
	button.className = `${tab.className} fodrinth-creator-nav button-animation border-none text-primary cursor-pointer w-12 h-12 rounded-full flex items-center justify-center text-2xl transition-all bg-transparent hover:bg-button-bg hover:text-contrast`
	button.title = tab.label
	button.setAttribute('aria-label', tab.label)
	button.dataset.route = tab.path
	button.innerHTML = tab.icon
	button.addEventListener('click', () => void router.push(tab.path))
	return button
}

function updateCreatorNavState() {
	const currentPath = router.currentRoute.value.path
	document.querySelectorAll('.fodrinth-creator-nav').forEach((button) => {
		button.classList.toggle('is-active', currentPath === button.dataset.route)
	})
}

function ensureCreatorTabs(navbar) {
	const discoverButton = Array.from(navbar.children).find((element) => {
		if (element.tagName !== 'A') return false
		return element.getAttribute('href')?.endsWith('/browse/modpack')
	})
	if (!discoverButton) return

	let insertAfter = discoverButton
	for (const tab of creatorTabs) {
		let button = navbar.querySelector(`.${tab.className}`)
		if (!button) button = createCreatorNavButton(tab)

		if (insertAfter.nextElementSibling !== button) {
			insertAfter.insertAdjacentElement('afterend', button)
		}
		insertAfter = button
	}
	updateCreatorNavState()
}

function renderCurseForgeButton(button) {
	const authenticated = isCurseForgeAuthenticated()
	const profile = getCurseForgeProfile()
	button.classList.toggle('is-authenticated', authenticated)
	button.classList.toggle('is-profile', authenticated)
	button.replaceChildren()

	if (!authenticated) {
		button.innerHTML = LOGIN_ICON
		button.setAttribute('aria-label', 'Sign into CurseForge')
		button.title = 'Sign into CurseForge'
		return
	}

	const displayName = profile?.displayName || profile?.username || 'CurseForge'
	button.setAttribute('aria-label', `${displayName} — CurseForge`)
	button.title = `${displayName} — CurseForge`

	if (profile?.avatarUrl) {
		const avatar = document.createElement('img')
		avatar.src = profile.avatarUrl
		avatar.alt = ''
		avatar.className = 'fodrinth-cf-profile-avatar'
		avatar.referrerPolicy = 'no-referrer'
		button.appendChild(avatar)
		return
	}

	const fallback = document.createElement('span')
	fallback.className = 'fodrinth-cf-profile-fallback'
	fallback.innerHTML = CURSEFORGE_LOGO
	button.appendChild(fallback)
}

function updateCurseForgeAuthButton(button) {
	renderCurseForgeButton(button)
}

function createCurseForgeAuthButton() {
	const button = document.createElement('button')
	button.type = 'button'
	button.className =
		'fodrinth-curseforge-auth w-12 h-12 text-primary rounded-full flex items-center justify-center text-2xl transition-all bg-transparent hover:bg-button-bg hover:text-contrast'
	button.addEventListener('click', openCurseForgeAuth)
	updateCurseForgeAuthButton(button)
	return button
}

function patchNavbar() {
	const navbar = document.querySelector('.app-grid-navbar')
	if (!navbar) return

	ensureCreatorTabs(navbar)

	const spacer = Array.from(navbar.children).find((element) => element.classList.contains('flex-grow'))
	if (!spacer) return

	// Keep settings in the bottom group, immediately after the flex spacer.
	// This places it directly above the CurseForge and Modrinth auth buttons.
	let settingsButton = navbar.querySelector('.fodrinth-settings-button')
	if (!settingsButton) {
		const candidate = spacer.nextElementSibling
		if (
			candidate?.tagName === 'BUTTON' &&
			!candidate.classList.contains('fodrinth-curseforge-auth')
		) {
			settingsButton = candidate
			settingsButton.classList.add('fodrinth-settings-button')
		}
	}

	if (settingsButton && spacer.nextElementSibling !== settingsButton) {
		navbar.insertBefore(settingsButton, spacer.nextElementSibling)
	}

	let curseForgeButton = navbar.querySelector('.fodrinth-curseforge-auth')
	if (!curseForgeButton) {
		curseForgeButton = createCurseForgeAuthButton()
	}

	const authInsertPoint = settingsButton ?? spacer
	if (authInsertPoint.nextElementSibling !== curseForgeButton) {
		authInsertPoint.insertAdjacentElement('afterend', curseForgeButton)
	}
}

export function initFodrinthNavbar() {
	let updateQueued = false

	const queueUpdate = () => {
		if (updateQueued) return
		updateQueued = true
		queueMicrotask(() => {
			updateQueued = false
			patchNavbar()
		})
	}

	const updateAuthState = () => {
		document.querySelectorAll('.fodrinth-curseforge-auth').forEach(updateCurseForgeAuthButton)
	}

	const observer = new MutationObserver(queueUpdate)
	observer.observe(document.documentElement, {
		childList: true,
		subtree: true,
	})
	window.addEventListener(CURSEFORGE_AUTH_CHANGED_EVENT, updateAuthState)
	const removeRouteHook = router.afterEach(() => updateCreatorNavState())

	if (isCurseForgeAuthenticated() && !getCurseForgeProfile()) {
		void refreshCurseForgeProfile().catch((error) => {
			console.debug('CurseForge profile lookup is unavailable for this token', error)
		})
	}

	queueUpdate()
	return () => {
		observer.disconnect()
		window.removeEventListener(CURSEFORGE_AUTH_CHANGED_EVENT, updateAuthState)
		removeRouteHook()
	}
}
