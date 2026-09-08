import 'floating-vue/dist/style.css'
import 'overlayscrollbars/overlayscrollbars.css'

import { VueQueryPlugin } from '@tanstack/vue-query'
import FloatingVue from 'floating-vue'
import { createApp } from 'vue'

import App from '@/App.vue'
import '@/assets/fodrinth.css'
import '@/assets/fodrinth-projects.css'
import { overlayScrollbarsDirective } from '@/directives/overlayScrollbars'
import { startCreatorAnalyticsBackground } from '@/helpers/creator-analytics-cache.js'
import { setupErrorReporting } from '@/helpers/error-reporting'
import { initFodrinthAnalyticsProviderChart } from '@/helpers/fodrinth-analytics-provider-chart'
import { initFodrinthAnalyticsSort } from '@/helpers/fodrinth-analytics-sort'
import { initFodrinthNavbar } from '@/helpers/fodrinth-navbar'
import { initFodrinthProjectLayout } from '@/helpers/fodrinth-project-layout'
import i18nPlugin from '@/plugins/i18n'
import i18nDebugPlugin from '@/plugins/i18n-debug'
import router from '@/routes'

const app = createApp(App)
setupErrorReporting(app, router)

app.use(VueQueryPlugin)
app.use(router)
app.use(FloatingVue, {
	themes: {
		'ribbit-popout': {
			$extend: 'dropdown',
			placement: 'bottom-end',
			instantMove: true,
			distance: 8,
		},
		'dismissable-prompt': {
			$extend: 'dropdown',
			placement: 'bottom-start',
		},
	},
})
app.use(i18nPlugin)
app.use(i18nDebugPlugin)
app.directive('overlay-scrollbars', overlayScrollbarsDirective)

async function mount() {
	if (import.meta.env.DEV && import.meta.env.VITE_VUE_SCAN === 'true') {
		const { VueScanPlugin } = await import('@taijased/vue-render-tracker')
		app.use(new VueScanPlugin({ enabled: true, showOverlay: true, log: false, playSound: false }))
	}
	app.mount('#app')
	initFodrinthNavbar()
	initFodrinthProjectLayout()
	initFodrinthAnalyticsSort()
	initFodrinthAnalyticsProviderChart()
	startCreatorAnalyticsBackground()
}

void mount()
