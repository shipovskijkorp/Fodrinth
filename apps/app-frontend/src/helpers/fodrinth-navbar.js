import {
	CURSEFORGE_AUTH_CHANGED_EVENT,
	isCurseForgeAuthenticated,
	openCurseForgeAuth,
} from '@/helpers/curseforge-auth.js'

function updateCurseForgeAuthButton(button) {
	const authenticated = isCurseForgeAuthenticated()
	button.classList.toggle('is-authenticated', authenticated)
	button.setAttribute(
		'aria-label',
		authenticated ? 'CurseForge connected' : 'Sign into CurseForge',
	)
	button.title = authenticated ? 'CurseForge connected' : 'Sign into CurseForge'
}

function createCurseForgeAuthButton() {
	const button = document.createElement('button')
	button.type = 'button'
	button.className =
		'fodrinth-curseforge-auth w-12 h-12 text-primary rounded-full flex items-center justify-center text-2xl transition-all bg-transparent hover:bg-button-bg hover:text-contrast'
	button.innerHTML = `
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="24"
			height="24"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
			<polyline points="10 17 15 12 10 7" />
			<line x1="15" x2="3" y1="12" y2="12" />
		</svg>
	`
	button.addEventListener('click', openCurseForgeAuth)
	updateCurseForgeAuthButton(button)
	return button
}

function patchNavbar() {
	const navbar = document.querySelector('.app-grid-navbar')
	if (!navbar) return

	const spacer = Array.from(navbar.children).find((element) => element.classList.contains('flex-grow'))
	if (!spacer) return

	// In upstream App.vue the settings button sits immediately after the flex spacer.
	// Move it into the main navigation group, directly above the spacer.
	const elementAfterSpacer = spacer.nextElementSibling
	if (elementAfterSpacer?.tagName === 'BUTTON' && !elementAfterSpacer.classList.contains('fodrinth-curseforge-auth')) {
		elementAfterSpacer.classList.add('fodrinth-settings-button')
		navbar.insertBefore(elementAfterSpacer, spacer)
	}

	if (!navbar.querySelector('.fodrinth-curseforge-auth')) {
		spacer.insertAdjacentElement('afterend', createCurseForgeAuthButton())
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

	queueUpdate()
	return () => {
		observer.disconnect()
		window.removeEventListener(CURSEFORGE_AUTH_CHANGED_EVENT, updateAuthState)
	}
}
