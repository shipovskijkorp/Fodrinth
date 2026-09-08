<script setup>
import {
	ChartIcon,
	CurrencyIcon,
	DownloadIcon,
	PackageIcon,
	RefreshCwIcon,
	TrendingDownIcon,
	TrendingUpIcon,
} from '@modrinth/assets'
import { injectModrinthClient } from '@modrinth/ui'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import {
	CURSEFORGE_AUTH_CHANGED_EVENT,
	getCurseForgeProfile,
	isCurseForgeAuthenticated,
} from '@/helpers/curseforge-auth.js'
import { get as getModrinthCredentials } from '@/helpers/mr_auth.ts'
import { get_user_projects } from '@/helpers/users'

const client = injectModrinthClient()

const sourceMode = ref('combined')
const metricMode = ref('downloads')
const viewMode = ref('total')
const periodDays = ref(30)
const loading = ref(false)
const errorMessage = ref('')
const modrinthCredentials = ref(null)
const modrinthProjects = ref([])
const analyticsResponse = ref(null)
const payoutBalance = ref(null)
const curseForgeConnected = ref(isCurseForgeAuthenticated())
const curseForgeProfile = ref(getCurseForgeProfile())

const sourceTabs = [
	{ id: 'combined', label: 'Combined' },
	{ id: 'modrinth', label: 'Modrinth' },
	{ id: 'curseforge', label: 'CurseForge' },
]
const metricTabs = [
	{ id: 'downloads', label: 'Downloads', icon: DownloadIcon },
	{ id: 'monetization', label: 'Monetization', icon: CurrencyIcon },
]
const viewTabs = [
	{ id: 'total', label: 'Total' },
	{ id: 'comparison', label: 'Comparison' },
]
const periods = [
	{ days: 7, label: 'Last 7 days' },
	{ days: 30, label: 'Last 30 days' },
	{ days: 90, label: 'Last 90 days' },
]

const numberFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const compactNumberFormatter = new Intl.NumberFormat(undefined, {
	notation: 'compact',
	maximumFractionDigits: 1,
})
const moneyFormatter = new Intl.NumberFormat(undefined, {
	style: 'currency',
	currency: 'USD',
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
})
const dateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

function formatNumber(value) {
	return numberFormatter.format(Number.isFinite(value) ? value : 0)
}

function formatCompact(value) {
	return compactNumberFormatter.format(Number.isFinite(value) ? value : 0)
}

function formatMoney(value) {
	return moneyFormatter.format(Number.isFinite(value) ? value : 0)
}

function getMetricValue(point, kind) {
	if (point?.metric_kind !== kind) return 0
	if (kind === 'downloads') return Number(point.downloads) || 0
	if (kind === 'revenue') return Number(point.revenue) || 0
	return 0
}

function splitPeriods(response) {
	const slices = response?.metrics ?? []
	if (slices.length === 0) return { previous: [], current: [] }
	const midpoint = Math.floor(slices.length / 2)
	return {
		previous: slices.slice(0, midpoint),
		current: slices.slice(midpoint),
	}
}

const splitAnalytics = computed(() => splitPeriods(analyticsResponse.value))

function sumMetric(slices, kind) {
	return slices.reduce(
		(total, slice) =>
			total +
			slice.reduce((sliceTotal, point) => sliceTotal + getMetricValue(point, kind), 0),
		0,
	)
}

function buildSeries(slices, kind) {
	return slices.map((slice) =>
		slice.reduce((total, point) => total + getMetricValue(point, kind), 0),
	)
}

function buildProjectTotals(slices, kind) {
	const totals = new Map()
	for (const slice of slices) {
		for (const point of slice) {
			if (!point?.source_project || point.metric_kind !== kind) continue
			totals.set(
				point.source_project,
				(totals.get(point.source_project) ?? 0) + getMetricValue(point, kind),
			)
		}
	}
	return totals
}

const modrinthIncluded = computed(() => sourceMode.value !== 'curseforge' && !!modrinthCredentials.value)
const curseForgeIncluded = computed(() => false)
const includedProviderCount = computed(
	() => Number(modrinthIncluded.value) + Number(curseForgeIncluded.value),
)

const currentDownloads = computed(() =>
	modrinthIncluded.value ? sumMetric(splitAnalytics.value.current, 'downloads') : 0,
)
const previousDownloads = computed(() =>
	modrinthIncluded.value ? sumMetric(splitAnalytics.value.previous, 'downloads') : 0,
)
const currentRevenue = computed(() =>
	modrinthIncluded.value ? sumMetric(splitAnalytics.value.current, 'revenue') : 0,
)
const previousRevenue = computed(() =>
	modrinthIncluded.value ? sumMetric(splitAnalytics.value.previous, 'revenue') : 0,
)
const allTimeDownloads = computed(() =>
	modrinthIncluded.value
		? modrinthProjects.value.reduce((total, project) => total + (Number(project.downloads) || 0), 0)
		: 0,
)

function percentChange(current, previous) {
	if (!previous) return null
	return ((current - previous) / previous) * 100
}

const downloadChange = computed(() => percentChange(currentDownloads.value, previousDownloads.value))
const revenueChange = computed(() => percentChange(currentRevenue.value, previousRevenue.value))

const currentMetricKind = computed(() => (metricMode.value === 'downloads' ? 'downloads' : 'revenue'))
const currentSeries = computed(() => {
	if (!modrinthIncluded.value) return []
	return buildSeries(splitAnalytics.value.current, currentMetricKind.value)
})

const rangeDates = computed(() => {
	const end = new Date()
	const start = new Date(end.getTime() - periodDays.value * 24 * 60 * 60 * 1000)
	return { start, end }
})

const chartPoints = computed(() => {
	const values = currentSeries.value
	if (values.length === 0) return ''
	const width = 760
	const height = 220
	const max = Math.max(...values, 1)
	return values
		.map((value, index) => {
			const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width
			const y = height - (value / max) * (height - 20)
			return `${x.toFixed(1)},${y.toFixed(1)}`
		})
		.join(' ')
})

const chartAreaPoints = computed(() => {
	if (!chartPoints.value) return ''
	return `0,220 ${chartPoints.value} 760,220`
})

const chartMax = computed(() => Math.max(...currentSeries.value, 0))
const chartTitle = computed(() =>
	metricMode.value === 'downloads' ? 'Downloads over time' : 'Estimated revenue over time',
)

const projectRows = computed(() => {
	if (!modrinthIncluded.value) return []
	const kind = currentMetricKind.value
	const totals = buildProjectTotals(splitAnalytics.value.current, kind)
	return modrinthProjects.value
		.map((project) => ({
			id: project.id,
			name: project.title ?? project.name ?? project.slug ?? project.id,
			icon: project.icon_url ?? null,
			provider: 'Modrinth',
			periodValue: totals.get(project.id) ?? 0,
			allTimeDownloads: Number(project.downloads) || 0,
		}))
		.sort((a, b) => b.periodValue - a.periodValue)
})

const maxProjectValue = computed(() => Math.max(...projectRows.value.map((row) => row.periodValue), 1))

const summaryCards = computed(() => {
	if (metricMode.value === 'downloads') {
		return [
			{
				label: `Downloads · ${periodDays.value}d`,
				value: formatNumber(currentDownloads.value),
				icon: DownloadIcon,
				change: downloadChange.value,
				subtitle: 'vs previous period',
			},
			{
				label: 'All-time downloads',
				value: formatNumber(allTimeDownloads.value),
				icon: ChartIcon,
				subtitle: 'Cumulative provider totals',
			},
			{
				label: 'Projects',
				value: formatNumber(projectRows.value.length),
				icon: PackageIcon,
				subtitle: 'Projects included in this view',
			},
			{
				label: 'Sources included',
				value: `${includedProviderCount.value}/2`,
				icon: ChartIcon,
				subtitle: 'Only compatible provider data is summed',
			},
		]
	}

	return [
		{
			label: `Estimated · ${periodDays.value}d`,
			value: formatMoney(currentRevenue.value),
			icon: CurrencyIcon,
			change: revenueChange.value,
				subtitle: 'Provider-reported analytics',
		},
		{
			label: 'Confirmed',
			value: modrinthIncluded.value && payoutBalance.value ? formatMoney(payoutBalance.value.available) : '—',
			icon: CurrencyIcon,
			subtitle:
				modrinthIncluded.value && payoutBalance.value
					? `${formatMoney(payoutBalance.value.pending)} pending`
					: 'No compatible confirmed balance',
		},
		{
			label: 'Paid',
			value:
				modrinthIncluded.value && payoutBalance.value
					? formatMoney(payoutBalance.value.withdrawn_lifetime)
					: '—',
			icon: CurrencyIcon,
			subtitle: 'Lifetime provider-confirmed withdrawals',
		},
		{
			label: 'Sources included',
			value: `${includedProviderCount.value}/2`,
			icon: ChartIcon,
			subtitle: 'Estimated, confirmed and paid are never mixed',
		},
	]
})

const hasVisibleData = computed(() => {
	if (sourceMode.value === 'curseforge') return false
	return modrinthIncluded.value && modrinthProjects.value.length > 0
})

const pageNotice = computed(() => {
	if (sourceMode.value === 'curseforge') {
		return curseForgeConnected.value
			? 'CurseForge is connected, but its author analytics adapter is not wired yet. This tab is intentionally not filled with guessed data.'
			: 'Connect CurseForge to prepare provider-native analytics. Fodrinth will not invent or infer private author statistics.'
	}
	if (!modrinthCredentials.value) {
		return 'Sign into Modrinth to load creator analytics for your projects.'
	}
	if (errorMessage.value) return errorMessage.value
	if (sourceMode.value === 'combined' && !curseForgeIncluded.value) {
		return 'Combined currently includes Modrinth data only. CurseForge stays excluded until its analytics source is available, so totals remain semantically correct.'
	}
	return ''
})

const providerRows = computed(() => {
	const rows = []
	if (sourceMode.value !== 'curseforge') {
		rows.push({
			provider: 'Modrinth',
			className: 'modrinth',
			included: !!modrinthCredentials.value,
			projects: modrinthProjects.value.length,
			value: metricMode.value === 'downloads' ? currentDownloads.value : currentRevenue.value,
		})
	}
	if (sourceMode.value !== 'modrinth') {
		rows.push({
			provider: 'CurseForge',
			className: 'curseforge',
			included: false,
			projects: null,
			value: null,
		})
	}
	return rows
})

function providerValue(row) {
	if (!row.included || row.value == null) return 'Not included'
	return metricMode.value === 'downloads' ? formatNumber(row.value) : formatMoney(row.value)
}

function trendClass(change) {
	if (change == null || change === 0) return 'text-secondary'
	return change > 0 ? 'text-green' : 'text-red'
}

function trendLabel(change) {
	if (change == null) return null
	const sign = change > 0 ? '+' : ''
	return `${sign}${change.toFixed(1)}%`
}

async function refreshAnalytics() {
	loading.value = true
	errorMessage.value = ''
	try {
		modrinthCredentials.value = await getModrinthCredentials()
		if (!modrinthCredentials.value?.user_id) {
			modrinthProjects.value = []
			analyticsResponse.value = null
			payoutBalance.value = null
			return
		}

		modrinthProjects.value = await get_user_projects(modrinthCredentials.value.user_id)
		const projectIds = modrinthProjects.value.map((project) => project.id).filter(Boolean)
		if (projectIds.length === 0) {
			analyticsResponse.value = null
			payoutBalance.value = null
			return
		}

		const end = new Date()
		const start = new Date(end.getTime() - periodDays.value * 2 * 24 * 60 * 60 * 1000)
		const request = {
			time_range: {
				start: start.toISOString(),
				end: end.toISOString(),
				resolution: { slices: periodDays.value * 2 },
			},
			project_ids: projectIds,
			return_metrics: {
				project_downloads: { bucket_by: ['project_id'] },
				project_revenue: { bucket_by: ['project_id'] },
			},
		}

		const [analyticsResult, payoutResult] = await Promise.allSettled([
			client.labrinth.analytics_v3.fetch(request),
			client.labrinth.payout_v3.getBalance(),
		])

		if (analyticsResult.status === 'fulfilled') {
			analyticsResponse.value = analyticsResult.value
		} else {
			analyticsResponse.value = null
			throw analyticsResult.reason
		}

		payoutBalance.value = payoutResult.status === 'fulfilled' ? payoutResult.value : null
	} catch (error) {
		console.error('Failed to load Fodrinth analytics', error)
		errorMessage.value =
			error instanceof Error ? `Could not load Modrinth analytics: ${error.message}` : 'Could not load Modrinth analytics.'
	} finally {
		loading.value = false
	}
}

function updateCurseForgeState() {
	curseForgeConnected.value = isCurseForgeAuthenticated()
	curseForgeProfile.value = getCurseForgeProfile()
}

watch(periodDays, () => void refreshAnalytics())

onMounted(() => {
	window.addEventListener(CURSEFORGE_AUTH_CHANGED_EVENT, updateCurseForgeState)
	void refreshAnalytics()
})

onBeforeUnmount(() => {
	window.removeEventListener(CURSEFORGE_AUTH_CHANGED_EVENT, updateCurseForgeState)
})
</script>

<template>
	<div class="w-full p-6 md:p-8">
		<div class="mx-auto flex max-w-7xl flex-col gap-4 pb-16">
			<div class="flex flex-wrap items-start justify-between gap-4">
				<div>
					<h1 class="m-0 text-2xl font-semibold text-contrast md:text-3xl">Analytics</h1>
					<p class="mb-0 mt-1 max-w-3xl text-secondary">
						Unified creator analytics across Modrinth and CurseForge, without mixing metrics that mean different things.
					</p>
				</div>
				<button
					type="button"
					class="flex h-10 items-center gap-2 rounded-xl border border-solid border-surface-5 bg-surface-3 px-4 font-medium text-primary transition-colors hover:bg-surface-4 disabled:opacity-60"
					:disabled="loading"
					@click="refreshAnalytics"
				>
					<RefreshCwIcon class="size-4" :class="{ 'animate-spin': loading }" />
					Refresh
				</button>
			</div>

			<div class="flex flex-col gap-3 rounded-2xl border border-solid border-surface-5 bg-surface-3 p-3">
				<div class="flex flex-wrap items-center gap-2">
					<button
						v-for="tab in sourceTabs"
						:key="tab.id"
						type="button"
						class="rounded-xl border border-solid px-4 py-2 font-medium transition-colors"
						:class="
							sourceMode === tab.id
								? 'border-brand bg-brand-highlight text-contrast'
								: 'border-transparent bg-transparent text-primary hover:bg-surface-4'
						"
						@click="sourceMode = tab.id"
					>
						{{ tab.label }}
					</button>
				</div>

				<div class="flex flex-wrap items-center justify-between gap-3 border-0 border-t border-solid border-surface-4 pt-3">
					<div class="flex flex-wrap items-center gap-2">
						<button
							v-for="tab in metricTabs"
							:key="tab.id"
							type="button"
							class="flex items-center gap-2 rounded-xl px-3 py-2 font-medium transition-colors"
							:class="metricMode === tab.id ? 'bg-surface-5 text-contrast' : 'text-primary hover:bg-surface-4'"
							@click="metricMode = tab.id"
						>
							<component :is="tab.icon" class="size-4" />
							{{ tab.label }}
						</button>
					</div>
					<div class="flex flex-wrap items-center gap-2">
						<div class="flex rounded-xl bg-surface-2 p-1">
							<button
								v-for="tab in viewTabs"
								:key="tab.id"
								type="button"
								class="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
								:class="viewMode === tab.id ? 'bg-surface-4 text-contrast' : 'text-secondary hover:text-primary'"
								@click="viewMode = tab.id"
							>
								{{ tab.label }}
							</button>
						</div>
						<select
							v-model.number="periodDays"
							class="h-9 rounded-xl border border-solid border-surface-5 bg-surface-2 px-3 text-sm font-medium text-primary outline-none"
						>
							<option v-for="period in periods" :key="period.days" :value="period.days">
								{{ period.label }}
							</option>
						</select>
					</div>
				</div>
			</div>

			<div v-if="pageNotice" class="rounded-xl border border-solid border-surface-5 bg-surface-2 px-4 py-3 text-sm text-secondary">
				{{ pageNotice }}
			</div>

			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
				<div
					v-for="card in summaryCards"
					:key="card.label"
					class="flex min-h-32 flex-col justify-between rounded-2xl border border-solid border-surface-5 bg-surface-3 p-4"
				>
					<div class="flex items-center justify-between gap-3">
						<span class="font-medium text-primary">{{ card.label }}</span>
						<component :is="card.icon" class="size-5 text-primary" />
					</div>
					<div class="mt-4">
						<div class="text-2xl font-semibold text-contrast md:text-3xl">{{ card.value }}</div>
						<div v-if="card.change != null" class="mt-2 flex items-center gap-1 text-sm">
							<span :class="trendClass(card.change)" class="flex items-center gap-1 font-semibold">
								<TrendingUpIcon v-if="card.change > 0" class="size-3" />
								<TrendingDownIcon v-else-if="card.change < 0" class="size-3" />
								{{ trendLabel(card.change) }}
							</span>
							<span class="text-xs text-secondary">{{ card.subtitle }}</span>
						</div>
						<div v-else class="mt-2 text-xs text-secondary">{{ card.subtitle }}</div>
					</div>
				</div>
			</div>

			<section class="relative overflow-hidden rounded-2xl border border-solid border-surface-5 bg-surface-3">
				<div class="flex flex-wrap items-center justify-between gap-3 border-0 border-b border-solid border-surface-4 px-5 py-4">
					<div>
						<h2 class="m-0 text-lg font-semibold text-contrast">{{ chartTitle }}</h2>
						<p class="mb-0 mt-1 text-xs text-secondary">
							{{ dateFormatter.format(rangeDates.start) }} — {{ dateFormatter.format(rangeDates.end) }}
						</p>
					</div>
					<div class="flex items-center gap-4 text-xs text-secondary">
						<span class="flex items-center gap-2"><i class="provider-dot modrinth"></i>Modrinth</span>
						<span class="flex items-center gap-2 opacity-60"><i class="provider-dot curseforge"></i>CurseForge</span>
					</div>
				</div>

				<div class="relative h-[300px] p-5">
					<div v-if="loading" class="absolute inset-0 z-10 flex items-center justify-center bg-surface-3/70 backdrop-blur-sm">
						<div class="flex items-center gap-2 font-medium text-primary">
							<RefreshCwIcon class="size-5 animate-spin" />
							Fetching analytics…
						</div>
					</div>
					<div v-if="!hasVisibleData || !chartPoints" class="flex h-full items-center justify-center text-center">
						<div class="max-w-md">
							<ChartIcon class="mx-auto size-8 text-secondary" />
							<h3 class="mb-1 mt-3 text-base font-semibold text-contrast">No chart data available</h3>
							<p class="m-0 text-sm text-secondary">Connect a supported provider or choose a range with analytics data.</p>
						</div>
					</div>
					<div v-else class="grid h-full grid-cols-[64px_1fr] grid-rows-[1fr_24px] gap-x-3">
						<div class="flex flex-col justify-between py-1 text-right text-xs text-secondary">
							<span>{{ metricMode === 'downloads' ? formatCompact(chartMax) : formatMoney(chartMax) }}</span>
							<span>{{ metricMode === 'downloads' ? formatCompact(chartMax / 2) : formatMoney(chartMax / 2) }}</span>
							<span>{{ metricMode === 'downloads' ? '0' : '$0.00' }}</span>
						</div>
						<div class="relative overflow-hidden rounded-lg">
							<div class="chart-grid absolute inset-0"></div>
							<svg class="absolute inset-0 h-full w-full overflow-visible text-brand" viewBox="0 0 760 220" preserveAspectRatio="none" aria-hidden="true">
								<polygon :points="chartAreaPoints" fill="currentColor" opacity="0.08" />
								<polyline :points="chartPoints" fill="none" stroke="currentColor" stroke-width="3" vector-effect="non-scaling-stroke" />
							</svg>
						</div>
						<div></div>
						<div class="flex justify-between text-xs text-secondary">
							<span>{{ dateFormatter.format(rangeDates.start) }}</span>
							<span>{{ dateFormatter.format(rangeDates.end) }}</span>
						</div>
					</div>
				</div>
			</section>

			<section v-if="viewMode === 'total'" class="rounded-2xl border border-solid border-surface-5 bg-surface-3">
				<div class="border-0 border-b border-solid border-surface-4 px-5 py-4">
					<h2 class="m-0 text-lg font-semibold text-contrast">Provider totals</h2>
					<p class="mb-0 mt-1 text-sm text-secondary">Combined only includes values with compatible semantics.</p>
				</div>
				<div class="divide-y divide-surface-4">
					<div v-for="row in providerRows" :key="row.provider" class="flex items-center gap-4 px-5 py-4">
						<i class="provider-dot size-lg" :class="row.className"></i>
						<div class="min-w-0 flex-1">
							<div class="font-semibold text-contrast">{{ row.provider }}</div>
							<div class="mt-0.5 text-xs text-secondary">
								{{ row.included ? `${row.projects} project${row.projects === 1 ? '' : 's'} included` : 'Provider analytics not included yet' }}
							</div>
						</div>
						<div class="text-right">
							<div class="font-semibold" :class="row.included ? 'text-contrast' : 'text-secondary'">{{ providerValue(row) }}</div>
							<div class="mt-0.5 text-xs text-secondary">{{ metricMode === 'downloads' ? 'period downloads' : 'period estimated revenue' }}</div>
						</div>
					</div>
				</div>
			</section>

			<section v-else class="overflow-hidden rounded-2xl border border-solid border-surface-5 bg-surface-3">
				<div class="border-0 border-b border-solid border-surface-4 px-5 py-4">
					<h2 class="m-0 text-lg font-semibold text-contrast">Project comparison</h2>
					<p class="mb-0 mt-1 text-sm text-secondary">Individual publications stay separate by provider instead of being silently deduplicated.</p>
				</div>
				<div v-if="projectRows.length === 0" class="p-8 text-center text-sm text-secondary">No comparable project data is available for this source.</div>
				<div v-else class="overflow-x-auto">
					<table class="w-full border-collapse text-left">
						<thead>
							<tr class="text-xs uppercase tracking-wide text-secondary">
								<th class="px-5 py-3 font-medium">Project</th>
								<th class="px-5 py-3 font-medium">Provider</th>
								<th class="px-5 py-3 font-medium">{{ metricMode === 'downloads' ? 'Period downloads' : 'Estimated revenue' }}</th>
								<th v-if="metricMode === 'downloads'" class="px-5 py-3 font-medium">All time</th>
							</tr>
						</thead>
						<tbody>
							<tr v-for="row in projectRows" :key="row.id" class="border-0 border-t border-solid border-surface-4">
								<td class="min-w-64 px-5 py-3">
									<div class="flex items-center gap-3">
										<img v-if="row.icon" :src="row.icon" alt="" class="size-9 rounded-lg object-cover" />
										<div v-else class="flex size-9 items-center justify-center rounded-lg bg-surface-4"><PackageIcon class="size-4 text-secondary" /></div>
										<div class="min-w-0 flex-1">
											<div class="truncate font-medium text-contrast">{{ row.name }}</div>
											<div class="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-4">
												<div class="h-full rounded-full bg-brand" :style="{ width: `${Math.max(2, (row.periodValue / maxProjectValue) * 100)}%` }"></div>
											</div>
										</div>
									</div>
								</td>
								<td class="px-5 py-3"><span class="inline-flex items-center gap-2 text-sm text-primary"><i class="provider-dot modrinth"></i>Modrinth</span></td>
								<td class="px-5 py-3 font-semibold text-contrast">{{ metricMode === 'downloads' ? formatNumber(row.periodValue) : formatMoney(row.periodValue) }}</td>
								<td v-if="metricMode === 'downloads'" class="px-5 py-3 text-primary">{{ formatNumber(row.allTimeDownloads) }}</td>
							</tr>
						</tbody>
					</table>
				</div>
			</section>

			<div v-if="metricMode === 'monetization'" class="rounded-xl border border-solid border-surface-5 bg-surface-2 px-4 py-3 text-xs leading-relaxed text-secondary">
				Monetization deliberately keeps <strong class="text-primary">estimated</strong>, <strong class="text-primary">confirmed</strong>, and <strong class="text-primary">paid</strong> values separate. Fodrinth does not add balances with different settlement states or currencies just to produce a larger “total”.
			</div>
		</div>
	</div>
</template>

<style scoped>
.chart-grid {
	background-image:
		linear-gradient(to bottom, var(--color-surface-4) 1px, transparent 1px),
		linear-gradient(to right, color-mix(in srgb, var(--color-surface-4) 55%, transparent) 1px, transparent 1px);
	background-size: 100% 50%, 12.5% 100%;
}

.provider-dot {
	display: inline-block;
	width: 0.625rem;
	height: 0.625rem;
	flex: 0 0 auto;
	border-radius: 9999px;
}

.provider-dot.size-lg {
	width: 0.875rem;
	height: 0.875rem;
}

.provider-dot.modrinth {
	background: #1bd96a;
	box-shadow: 0 0 0 3px rgb(27 217 106 / 10%);
}

.provider-dot.curseforge {
	background: #ff7849;
	box-shadow: 0 0 0 3px rgb(255 120 73 / 10%);
}
</style>
