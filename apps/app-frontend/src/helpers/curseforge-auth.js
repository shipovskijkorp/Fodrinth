import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { openUrl } from '@tauri-apps/plugin-opener'

const CURSEFORGE_TOKEN_STORAGE_KEY = 'fodrinth.curseforge.api-token'
const CURSEFORGE_TOKEN_URL = 'https://authors-old.curseforge.com/account/api-tokens'
const CURSEFORGE_TOKEN_VALIDATION_URL = 'https://minecraft.curseforge.com/api/game/versions'

export const CURSEFORGE_AUTH_CHANGED_EVENT = 'fodrinth:curseforge-auth-changed'

let authModal = null
let tokenInput = null
let statusElement = null
let connectButton = null
let disconnectButton = null
let closeButton = null
let getTokenButton = null
let isBusy = false

export function getCurseForgeToken() {
	return localStorage.getItem(CURSEFORGE_TOKEN_STORAGE_KEY)?.trim() || null
}

export function isCurseForgeAuthenticated() {
	return getCurseForgeToken() !== null
}

export function getCurseForgeAuthHeaders() {
	const token = getCurseForgeToken()
	return token ? { 'X-Api-Token': token } : {}
}

function emitAuthChanged() {
	window.dispatchEvent(
		new CustomEvent(CURSEFORGE_AUTH_CHANGED_EVENT, {
			detail: { authenticated: isCurseForgeAuthenticated() },
		}),
	)
}

function setStatus(message, type = 'info') {
	if (!statusElement) return
	statusElement.textContent = message
	statusElement.dataset.type = type
	statusElement.hidden = !message
}

function renderAuthState() {
	if (!tokenInput || !connectButton || !disconnectButton) return

	const authenticated = isCurseForgeAuthenticated()
	tokenInput.value = ''
	tokenInput.placeholder = authenticated
		? 'Paste a new API token to replace the current one'
		: 'Paste your CurseForge API token'
	connectButton.textContent = authenticated ? 'Replace token' : 'Connect'
	disconnectButton.hidden = !authenticated

	if (authenticated) {
		setStatus('CurseForge API token is connected.', 'success')
	} else {
		setStatus('', 'info')
	}
}

function setBusy(busy) {
	isBusy = busy
	if (tokenInput) tokenInput.disabled = busy
	if (connectButton) {
		connectButton.disabled = busy
		connectButton.textContent = busy
			? 'Checking...'
			: isCurseForgeAuthenticated()
				? 'Replace token'
				: 'Connect'
	}
	if (disconnectButton) disconnectButton.disabled = busy
	if (closeButton) closeButton.disabled = busy
	if (getTokenButton) getTokenButton.disabled = busy
}

export async function validateCurseForgeToken(token) {
	const normalized = token?.trim()
	if (!normalized) return false

	const response = await tauriFetch(CURSEFORGE_TOKEN_VALIDATION_URL, {
		method: 'GET',
		headers: {
			Accept: 'application/json',
			'X-Api-Token': normalized,
		},
	})

	if (response.status === 401 || response.status === 403) return false
	if (!response.ok) {
		throw new Error(`CurseForge returned HTTP ${response.status}`)
	}

	const body = await response.json().catch(() => null)
	if (!Array.isArray(body)) {
		throw new Error('CurseForge returned an unexpected response')
	}

	return true
}

async function connect() {
	if (isBusy || !tokenInput) return

	const token = tokenInput.value.trim()
	if (!token) {
		setStatus('Enter a CurseForge API token first.', 'error')
		tokenInput.focus()
		return
	}

	setBusy(true)
	setStatus('Checking the token with CurseForge...', 'info')
	try {
		const valid = await validateCurseForgeToken(token)
		if (!valid) {
			setStatus('CurseForge rejected this API token.', 'error')
			return
		}

		localStorage.setItem(CURSEFORGE_TOKEN_STORAGE_KEY, token)
		emitAuthChanged()
		renderAuthState()
	} catch (error) {
		console.error('Failed to validate CurseForge API token', error)
		const message = error instanceof Error ? error.message : String(error || 'Unknown error')
		setStatus(`Could not connect to CurseForge: ${message}`, 'error')
	} finally {
		setBusy(false)
	}
}

function disconnect() {
	if (isBusy) return
	localStorage.removeItem(CURSEFORGE_TOKEN_STORAGE_KEY)
	emitAuthChanged()
	renderAuthState()
	setStatus('Disconnected from CurseForge.', 'info')
}

function closeModal() {
	if (isBusy || !authModal) return
	authModal.hidden = true
}

function ensureAuthModal() {
	if (authModal?.isConnected) return

	authModal = document.createElement('div')
	authModal.id = 'fodrinth-curseforge-auth-modal'
	authModal.className = 'fodrinth-cf-auth-backdrop'
	authModal.hidden = true
	authModal.innerHTML = `
		<section class="fodrinth-cf-auth-modal" role="dialog" aria-modal="true" aria-labelledby="fodrinth-cf-auth-title">
			<div class="fodrinth-cf-auth-header">
				<div>
					<h2 id="fodrinth-cf-auth-title">CurseForge</h2>
					<p>Connect the author API used for publishing and creator tools.</p>
				</div>
				<button type="button" class="fodrinth-cf-auth-close" aria-label="Close">×</button>
			</div>

			<p class="fodrinth-cf-auth-note">
				CurseForge author APIs authenticate with an API token. Fodrinth validates it with CurseForge before saving it locally.
			</p>

			<label class="fodrinth-cf-auth-label" for="fodrinth-cf-auth-token">API token</label>
			<input
				id="fodrinth-cf-auth-token"
				class="fodrinth-cf-auth-input"
				type="password"
				autocomplete="off"
				spellcheck="false"
			/>
			<div class="fodrinth-cf-auth-status" hidden></div>

			<div class="fodrinth-cf-auth-actions">
				<button type="button" class="fodrinth-cf-auth-button fodrinth-cf-auth-button-secondary" data-action="get-token">
					Get API token
				</button>
				<div class="fodrinth-cf-auth-actions-right">
					<button type="button" class="fodrinth-cf-auth-button fodrinth-cf-auth-button-danger" data-action="disconnect" hidden>
						Disconnect
					</button>
					<button type="button" class="fodrinth-cf-auth-button fodrinth-cf-auth-button-primary" data-action="connect">
						Connect
					</button>
				</div>
			</div>
		</section>
	`

	document.body.appendChild(authModal)
	tokenInput = authModal.querySelector('#fodrinth-cf-auth-token')
	statusElement = authModal.querySelector('.fodrinth-cf-auth-status')
	connectButton = authModal.querySelector('[data-action="connect"]')
	disconnectButton = authModal.querySelector('[data-action="disconnect"]')
	closeButton = authModal.querySelector('.fodrinth-cf-auth-close')
	getTokenButton = authModal.querySelector('[data-action="get-token"]')

	connectButton?.addEventListener('click', () => void connect())
	disconnectButton?.addEventListener('click', disconnect)
	closeButton?.addEventListener('click', closeModal)
	getTokenButton?.addEventListener('click', () => void openUrl(CURSEFORGE_TOKEN_URL))
	tokenInput?.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') {
			event.preventDefault()
			void connect()
		}
	})
	authModal.addEventListener('mousedown', (event) => {
		if (event.target === authModal) closeModal()
	})
	window.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && !authModal.hidden) closeModal()
	})
}

export function openCurseForgeAuth() {
	ensureAuthModal()
	renderAuthState()
	authModal.hidden = false
	queueMicrotask(() => tokenInput?.focus())
}
