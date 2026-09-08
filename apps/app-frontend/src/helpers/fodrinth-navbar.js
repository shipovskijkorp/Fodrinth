const CURSEFORGE_AUTH_URL = 'https://authors-old.curseforge.com/account/api-tokens'

function createCurseForgeAuthButton() {
	const button = document.createElement('a')
	button.href = CURSEFORGE_AUTH_URL
	button.target = '_blank'
	button.rel = 'noopener noreferrer'
	button.className =
		'fodrinth-curseforge-auth w-12 h-12 text-primary rounded-full flex items-center justify-center text-2xl transition-all bg-transparent hover:bg-button-bg hover:text-contrast'
	button.setAttribute('aria-label', 'Sign into CurseForge')
	button.title = 'Sign into CurseForge'
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
	if (elementAfterSpacer?.tagName === 'BUTTON') {
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

	const observer = new MutationObserver(queueUpdate)
	observer.observe(document.documentElement, {
		childList: true,
		subtree: true,
	})

	queueUpdate()
	return () => observer.disconnect()
}
