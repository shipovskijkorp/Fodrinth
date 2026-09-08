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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import {
	CURSEFORGE_AUTH_CHANGED_EVENT,
	getCurseForgeProfile,
	isCurseForgeAuthenticated,
} from '@/helpers/curseforge-auth.js'
import {
	CURSEFORGE_USD_PER_POINT,
	openCurseForgeAuthorPortal,
} from '@/helpers/curseforge-analytics.js'
import {
	CREATOR_ANALYTICS_CACHE_UPDATED_EVENT,
	getCreatorAnalyticsSnapshot,
	isCreatorAnalyticsPeriodComplete,
	refreshCreatorAnalyticsPeriod,
} from '@/helpers/creator-analytics-cache.js'
import {
	CREATOR_PROJECT_LINKS_CHANGED_EVENT,
	getCreatorProjectLinks,
} from '@/helpers/creator-projects.js'

const DAY_MS = 24 * 60 * 60 * 1000

const sourceMode = ref('combined')
const metricMode = ref('downloads')
const viewMode = ref('total')
const periodDays = ref(30)
const projectSort = ref('provider')
const syncProjects = ref(true)
const creatorProjectLinks = ref(getCreatorProjectLinks())
const loading = ref(false)
const backgroundLoadingPeriod = ref(null)
const openingCurseForgePortal = ref(false)
const errorMessage = ref('')
const curseForgeErrorMessage = ref('')
const modrinthCredentials = ref(null)
const modrinthProjects = ref([])
const analyticsResponse = ref(null)
const payoutBalance = ref(null)
const payoutHistory = ref([])
const curseForgeConnected = ref(isCurseForgeAuthenticated())
const curseForgeProfile = ref(getCurseForgeProfile())
const curseForgeAnalytics = ref(null)
const modrinthCacheKnown = ref(false)
const curseForgeCacheKnown = ref(false)

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
const projectSortOptions = computed(() => [
	{ id: 'provider', label: 'Provider' },
	{ id: 'name', label: 'Name' },
	{ id: 'period', label: metricMode.value === 'downloads' ? 'Period downloads' : 'Creator earnings' },
	...(metricMode.value === 'downloads' ? [{ id: 'alltime', label: 'All-time downloads' }] : []),
])

const numberFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const compactNumberFormatter = new Intl.NumberFormat(undefined, {
	notation: 'compact',
	maximumFractionDigits: 1,
})
const pointsFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })
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

function formatPoints(value) {
	return pointsFormatter.format(Number.isFinite(value) ? value : 0)
}

function finiteOrNull(value) {
	if (value == null || value === '') return null
	const number = Number(value)
	return Number.isFinite(number) ? number : null
}

function normalizeId(value) {
	return String(value ?? '').trim()
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
			total + slice.reduce((sliceTotal, point) => sliceTotal + getMetricValue(point, kind), 0),
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
				String(point.source_project),
				(totals.get(String(point.source_project)) ?? 0) + getMetricValue(point, kind),
			)
		}
	}
	return totals
}

const rangeDates = computed(() => {
	const end = new Date()
	const start = new Date(end.getTime() - periodDays.value * DAY_MS)
	const previousStart = new Date(start.getTime() - periodDays.value * DAY_MS)
	return { start, end, previousStart }
})

function inRange(timestamp, start, end) {
	const time = new Date(timestamp).getTime()
	return Number.isFinite(time) && time >= start.getTime() && time < end.getTime()
}

function sumTransactions(items, start, end, field = 'usd') {
	return (items ?? []).reduce((total, item) => {
		if (!inRange(item?.timestamp, start, end)) return total
		return total + (finiteOrNull(item?.[field]) ?? 0)
	}, 0)
}

function sumTransactionPoints(items, start, end) {
	return sumTransactions(items, start, end, 'points')
}

const modrinthSelectable = computed(() => sourceMode.value !== 'curseforge')
const curseForgeSelectable = computed(() => sourceMode.value !== 'modrinth')
const modrinthIncluded = computed(() => modrinthSelectable.value && !!modrinthCredentials.value)
const curseForgeDownloads = computed(() => curseForgeAnalytics.value?.downloads ?? null)
const curseForgeDownloadsIncluded = computed(() => {
	if (!curseForgeSelectable.value || !curseForgeAnalytics.value?.connected) return false
	const data = curseForgeDownloads.value
	return !!data && (
		finiteOrNull(data.current) != null ||
		finiteOrNull(data.allTime) != null ||
		(data.series?.length ?? 0) > 0 ||
		(data.projects?.length ?? 0) > 0
	)
})
const curseForgeMoneyIncluded = computed(() => {
	if (!curseForgeSelectable.value || !curseForgeAnalytics.value?.connected) return false
	return (
		(curseForgeAnalytics.value?.earnings?.length ?? 0) > 0 ||
		(curseForgeAnalytics.value?.withdrawals?.length ?? 0) > 0 ||
		finiteOrNull(curseForgeAnalytics.value?.rewardBalanceUsd) != null
	)
})
const curseForgeIncluded = computed(() =>
	metricMode.value === 'downloads' ? curseForgeDownloadsIncluded.value : curseForgeMoneyIncluded.value,
)
const includedProviderCount = computed(
	() => Number(modrinthIncluded.value) + Number(curseForgeIncluded.value),
)

const modrinthCurrentDownloads = computed(() =>
	modrinthIncluded.value ? sumMetric(splitAnalytics.value.current, 'downloads') : 0,
)
const modrinthPreviousDownloads = computed(() =>
	modrinthIncluded.value ? sumMetric(splitAnalytics.value.previous, 'downloads') : 0,
)
const modrinthCurrentRevenue = computed(() =>
	modrinthIncluded.value ? sumMetric(splitAnalytics.value.current, 'revenue') : 0,
)
const modrinthPreviousRevenue = computed(() =>
	modrinthIncluded.value ? sumMetric(splitAnalytics.value.previous, 'revenue') : 0,
)
const modrinthAllTimeDownloads = computed(() =>
	modrinthIncluded.value
		? modrinthProjects.value.reduce((total, project) => total + (Number(project.downloads) || 0), 0)
		: 0,
)
const curseForgeCurrentDownloads = computed(() =>
	curseForgeDownloadsIncluded.value ? finiteOrNull(curseForgeDownloads.value?.current) ?? 0 : 0,
)
const curseForgePreviousDownloads = computed(() =>
	curseForgeDownloadsIncluded.value ? finiteOrNull(curseForgeDownloads.value?.previous) ?? 0 : 0,
)
const curseForgeAllTimeDownloads = computed(() =>
	curseForgeDownloadsIncluded.value ? finiteOrNull(curseForgeDownloads.value?.allTime) ?? 0 : 0,
)
const curseForgeUniqueDownloads = computed(() =>
	curseForgeDownloadsIncluded.value ? finiteOrNull(curseForgeDownloads.value?.uniqueCurrent) : null,
)
const curseForgePreviousUniqueDownloads = computed(() =>
	curseForgeDownloadsIncluded.value ? finiteOrNull(curseForgeDownloads.value?.uniquePrevious) : null,
)
const curseForgeCurrentRevenue = computed(() =>
	curseForgeMoneyIncluded.value
		? sumTransactions(curseForgeAnalytics.value?.earnings, rangeDates.value.start, rangeDates.value.end)
		: 0,
)
const curseForgePreviousRevenue = computed(() =>
	curseForgeMoneyIncluded.value
		? sumTransactions(curseForgeAnalytics.value?.earnings, rangeDates.value.previousStart, rangeDates.value.start)
		: 0,
)
const curseForgeCurrentPoints = computed(() =>
	curseForgeMoneyIncluded.value
		? sumTransactionPoints(curseForgeAnalytics.value?.earnings, rangeDates.value.start, rangeDates.value.end)
		: 0,
)
const curseForgeRewardPoints = computed(() => finiteOrNull(curseForgeAnalytics.value?.rewardPoints))
const curseForgeRewardBalanceUsd = computed(() => finiteOrNull(curseForgeAnalytics.value?.rewardBalanceUsd))
const curseForgePaidCurrent = computed(() =>
	curseForgeMoneyIncluded.value
		? sumTransactions(curseForgeAnalytics.value?.withdrawals, rangeDates.value.start, rangeDates.value.end)
		: 0,
)
const modrinthPaidCurrent = computed(() => {
	if (!modrinthIncluded.value) return 0
	return payoutHistory.value.reduce((total, transaction) => {
		if (transaction?.type !== 'withdrawal') return total
		if (!inRange(transaction.created, rangeDates.value.start, rangeDates.value.end)) return total
		return total + Math.abs(Number(transaction.amount) || 0)
	}, 0)
})

const currentDownloads = computed(() => modrinthCurrentDownloads.value + curseForgeCurrentDownloads.value)
const previousDownloads = computed(() => modrinthPreviousDownloads.value + curseForgePreviousDownloads.value)
const currentRevenue = computed(() => modrinthCurrentRevenue.value + curseForgeCurrentRevenue.value)
const previousRevenue = computed(() => modrinthPreviousRevenue.value + curseForgePreviousRevenue.value)
const allTimeDownloads = computed(() => modrinthAllTimeDownloads.value + curseForgeAllTimeDownloads.value)
const availableBalance = computed(() => {
	let total = 0
	let hasValue = false
	if (modrinthIncluded.value && payoutBalance.value) {
		total += Number(payoutBalance.value.available) || 0
		hasValue = true
	}
	if (curseForgeMoneyIncluded.value && curseForgeRewardBalanceUsd.value != null) {
		total += curseForgeRewardBalanceUsd.value
		hasValue = true
	}
	return hasValue ? total : null
})
const paidCurrent = computed(() => modrinthPaidCurrent.value + curseForgePaidCurrent.value)

function percentChange(current, previous) {
	if (!previous) return null
	return ((current - previous) / previous) * 100
}

const downloadChange = computed(() => percentChange(currentDownloads.value, previousDownloads.value))
const revenueChange = computed(() => percentChange(currentRevenue.value, previousRevenue.value))
const uniqueDownloadChange = computed(() => {
	if (curseForgeUniqueDownloads.value == null || curseForgePreviousUniqueDownloads.value == null) return null
	return percentChange(curseForgeUniqueDownloads.value, curseForgePreviousUniqueDownloads.value)
})

function chartStartOfDay() {
	const start = new Date(rangeDates.value.start)
	start.setHours(0, 0, 0, 0)
	return start.getTime()
}

function makeDailySeriesFromTransactions(items, field = 'usd') {
	const values = Array(periodDays.value).fill(0)
	const start = chartStartOfDay()
	for (const item of items ?? []) {
		const timestamp = new Date(item?.timestamp).getTime()
		if (!Number.isFinite(timestamp) || timestamp < start || timestamp >= rangeDates.value.end.getTime()) continue
		const index = Math.min(periodDays.value - 1, Math.max(0, Math.floor((timestamp - start) / DAY_MS)))
		values[index] += finiteOrNull(item?.[field]) ?? 0
	}
	return values
}

function makeDailySeriesFromDatedRows(rows, field) {
	const values = Array(periodDays.value).fill(0)
	const start = chartStartOfDay()
	let found = false
	for (const row of rows ?? []) {
		const timestamp = new Date(row?.date ?? row?.timestamp ?? row?.time).getTime()
		const value = finiteOrNull(row?.[field] ?? (field === 'total' ? row?.value : null))
		if (!Number.isFinite(timestamp) || value == null || timestamp < start || timestamp >= rangeDates.value.end.getTime() + DAY_MS) continue
		const index = Math.min(periodDays.value - 1, Math.max(0, Math.floor((timestamp - start) / DAY_MS)))
		values[index] += value
		found = true
	}
	return found ? values : []
}

function mergeSeries(left, right) {
	if (left.length === 0) return right
	if (right.length === 0) return left
	const size = Math.max(left.length, right.length)
	return Array.from({ length: size }, (_, index) => (left[index] ?? 0) + (right[index] ?? 0))
}

const modrinthCurrentSeries = computed(() => {
	if (!modrinthIncluded.value) return []
	return buildSeries(
		splitAnalytics.value.current,
		metricMode.value === 'downloads' ? 'downloads' : 'revenue',
	)
})
const curseForgeCurrentSeries = computed(() => {
	if (metricMode.value === 'downloads') {
		if (!curseForgeDownloadsIncluded.value) return []
		return makeDailySeriesFromDatedRows(curseForgeDownloads.value?.series, 'total')
	}
	if (!curseForgeMoneyIncluded.value) return []
	return makeDailySeriesFromTransactions(curseForgeAnalytics.value?.earnings, 'usd')
})
const currentSeries = computed(() => {
	if (sourceMode.value === 'modrinth') return modrinthCurrentSeries.value
	if (sourceMode.value === 'curseforge') return curseForgeCurrentSeries.value
	return mergeSeries(modrinthCurrentSeries.value, curseForgeCurrentSeries.value)
})
const chartSeries = computed(() => {
	if (metricMode.value === 'downloads' && sourceMode.value === 'combined') {
		return [
			{ id: 'modrinth', values: modrinthCurrentSeries.value, color: 'var(--color-brand, #1bd96a)', areaOpacity: 0.07 },
			{ id: 'curseforge', values: curseForgeCurrentSeries.value, color: '#ff7849', areaOpacity: 0.045 },
		].filter((series) => series.values.length > 0)
	}
	const values = currentSeries.value
	if (values.length === 0) return []
	return [{
		id: sourceMode.value,
		values,
		color: sourceMode.value === 'curseforge' ? '#ff7849' : 'var(--color-brand, #1bd96a)',
		areaOpacity: 0.08,
	}]
})
const chartMax = computed(() => Math.max(0, ...chartSeries.value.flatMap((series) => series.values)))
function makeChartPoints(values) {
	if (!values.length) return ''
	const width = 760
	const height = 220
	const max = Math.max(chartMax.value, 1)
	return values
		.map((value, index) => {
			const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width
			const y = height - (value / max) * (height - 20)
			return `${x.toFixed(1)},${y.toFixed(1)}`
		})
		.join(' ')
}
const chartLines = computed(() => chartSeries.value.map((series) => {
	const points = makeChartPoints(series.values)
	return {
		...series,
		points,
		areaPoints: points ? `0,220 ${points} 760,220` : '',
	}
}))
const chartTitle = computed(() =>
	metricMode.value === 'downloads' ? 'Downloads over time' : 'Creator earnings over time',
)

function buildCurseForgeEarningsByProject() {
	const totals = new Map()
	for (const earning of curseForgeAnalytics.value?.earnings ?? []) {
		if (!inRange(earning?.timestamp, rangeDates.value.start, rangeDates.value.end)) continue
		for (const project of earning?.projects ?? []) {
			if (!project?.name) continue
			const value = finiteOrNull(project.usd) ?? (finiteOrNull(project.points) ?? 0) * CURSEFORGE_USD_PER_POINT
			totals.set(project.name, (totals.get(project.name) ?? 0) + value)
		}
	}
	return totals
}

const rawProjectRows = computed(() => {
	const rows = []
	if (modrinthIncluded.value) {
		const kind = metricMode.value === 'downloads' ? 'downloads' : 'revenue'
		const totals = buildProjectTotals(splitAnalytics.value.current, kind)
		for (const project of modrinthProjects.value) {
			const sourceId = normalizeId(project.id)
			const periodValue = totals.get(sourceId) ?? 0
			const allTimeDownloads = Number(project.downloads) || 0
			rows.push({
				id: `modrinth:${sourceId}`,
				sourceId,
				name: project.title ?? project.name ?? project.slug ?? project.id,
				icon: project.icon_url ?? null,
				provider: 'Modrinth',
				className: 'modrinth',
				periodValue,
				allTimeDownloads,
				parts: [{ provider: 'Modrinth', className: 'modrinth', periodValue, allTimeDownloads }],
			})
		}
	}
	if (curseForgeIncluded.value) {
		if (metricMode.value === 'downloads') {
			for (const project of curseForgeDownloads.value?.projects ?? []) {
				const sourceId = normalizeId(project.id ?? project.name)
				const periodValue = finiteOrNull(project.period) ?? finiteOrNull(project.current) ?? finiteOrNull(project.total) ?? 0
				const allTimeDownloads = finiteOrNull(project.allTime) ?? finiteOrNull(project.total) ?? 0
				rows.push({
					id: `curseforge:${sourceId}`,
					sourceId,
					name: project.name ?? String(project.id ?? 'CurseForge project'),
					icon: project.icon ?? null,
					provider: 'CurseForge',
					className: 'curseforge',
					periodValue,
					allTimeDownloads,
					uniqueDownloads: finiteOrNull(project.unique),
					parts: [{ provider: 'CurseForge', className: 'curseforge', periodValue, allTimeDownloads }],
				})
			}
		} else {
			for (const [name, value] of buildCurseForgeEarningsByProject()) {
				rows.push({
					id: `curseforge:${name}`,
					sourceId: name,
					name,
					icon: null,
					provider: 'CurseForge',
					className: 'curseforge',
					periodValue: value,
					allTimeDownloads: 0,
					parts: [{ provider: 'CurseForge', className: 'curseforge', periodValue: value, allTimeDownloads: 0 }],
				})
			}
		}
	}
	return rows
})

function dominantPart(parts) {
	if (!parts?.length) return null
	const periodTotal = parts.reduce((sum, part) => sum + Math.max(0, finiteOrNull(part.periodValue) ?? 0), 0)
	const field = periodTotal > 0 ? 'periodValue' : 'allTimeDownloads'
	return [...parts].sort((a, b) => (finiteOrNull(b[field]) ?? 0) - (finiteOrNull(a[field]) ?? 0))[0]
}

function syncRows(rows) {
	if (!syncProjects.value || sourceMode.value !== 'combined' || metricMode.value !== 'downloads') return rows
	const modrinth = new Map(rows.filter((row) => row.provider === 'Modrinth').map((row) => [row.sourceId, row]))
	const curseforge = new Map(rows.filter((row) => row.provider === 'CurseForge').map((row) => [row.sourceId, row]))
	const consumed = new Set()
	const synced = []
	for (const link of creatorProjectLinks.value) {
		const mr = modrinth.get(normalizeId(link.modrinth))
		const cf = curseforge.get(normalizeId(link.curseforge))
		if (!mr || !cf) continue
		consumed.add(mr.id)
		consumed.add(cf.id)
		const parts = [mr.parts[0], cf.parts[0]]
		const dominant = dominantPart(parts) ?? mr.parts[0]
		synced.push({
			id: `sync:${link.id}`,
			sourceId: normalizeId(link.id),
			name: mr.name || cf.name,
			icon: mr.icon || cf.icon,
			provider: 'Sync',
			className: dominant.className,
			periodValue: mr.periodValue + cf.periodValue,
			allTimeDownloads: mr.allTimeDownloads + cf.allTimeDownloads,
			parts,
			sync: true,
		})
	}
	return [...synced, ...rows.filter((row) => !consumed.has(row.id))]
}

function sortProjectRows(rows) {
	const result = [...rows]
	const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' })
	if (projectSort.value === 'name') return result.sort(byName)
	if (projectSort.value === 'period') return result.sort((a, b) => b.periodValue - a.periodValue || byName(a, b))
	if (projectSort.value === 'alltime') return result.sort((a, b) => b.allTimeDownloads - a.allTimeDownloads || byName(a, b))
	const rank = { Sync: 0, Modrinth: 1, CurseForge: 2 }
	return result.sort((a, b) => (rank[a.provider] ?? 99) - (rank[b.provider] ?? 99) || b.periodValue - a.periodValue || byName(a, b))
}

const projectRows = computed(() => sortProjectRows(syncRows(rawProjectRows.value)))

function projectBarSegments(row) {
	const parts = row.parts?.length ? row.parts : []
	if (parts.length === 0) return []
	if (parts.length === 1) return [{ ...parts[0], share: 100 }]
	const periodTotal = parts.reduce((sum, part) => sum + Math.max(0, finiteOrNull(part.periodValue) ?? 0), 0)
	const field = periodTotal > 0 ? 'periodValue' : 'allTimeDownloads'
	const total = parts.reduce((sum, part) => sum + Math.max(0, finiteOrNull(part[field]) ?? 0), 0)
	if (total <= 0) return parts.map((part) => ({ ...part, share: 100 / parts.length }))
	return parts.map((part) => ({
		...part,
		share: (Math.max(0, finiteOrNull(part[field]) ?? 0) / total) * 100,
	}))
}

const summaryCards = computed(() => {
	if (metricMode.value === 'downloads') {
		const cards = [
			{
				label: `Downloads · ${periodDays.value}d`,
				value: formatNumber(currentDownloads.value),
				icon: DownloadIcon,
				change: downloadChange.value,
				subtitle: 'vs previous matching period',
			},
			{
				label: 'All-time downloads',
				value: formatNumber(allTimeDownloads.value),
				icon: ChartIcon,
				subtitle: 'Cumulative compatible provider totals',
			},
		]
		if (curseForgeUniqueDownloads.value != null) {
			cards.push({
				label: `CurseForge unique · ${periodDays.value}d`,
				value: formatNumber(curseForgeUniqueDownloads.value),
				icon: DownloadIcon,
				change: uniqueDownloadChange.value,
				subtitle: 'Unique downloads are provider-native and are not mixed with Modrinth',
			})
		}
		cards.push(
			{
				label: 'Projects',
				value: formatNumber(projectRows.value.length),
				icon: PackageIcon,
				subtitle: syncProjects.value && sourceMode.value === 'combined' ? 'Linked publications are counted once' : 'Publications included in this view',
			},
			{
				label: 'Sources included',
				value: `${includedProviderCount.value}/2`,
				icon: ChartIcon,
				subtitle: 'Only compatible provider data is summed',
			},
		)
		return cards
	}
	const pending = modrinthIncluded.value && payoutBalance.value ? Number(payoutBalance.value.pending) || 0 : null
	return [
		{
			label: `Estimated / earned · ${periodDays.value}d`,
			value: formatMoney(currentRevenue.value),
			icon: CurrencyIcon,
			change: revenueChange.value,
			subtitle: curseForgeMoneyIncluded.value
				? `CurseForge: ${formatPoints(curseForgeCurrentPoints.value)} points × $${CURSEFORGE_USD_PER_POINT.toFixed(2)}`
				: 'Provider-reported creator earnings',
		},
		{
			label: 'Available balance',
			value: availableBalance.value == null ? '—' : formatMoney(availableBalance.value),
			icon: CurrencyIcon,
			subtitle: curseForgeRewardPoints.value != null
				? `CurseForge balance: ${formatPoints(curseForgeRewardPoints.value)} points = ${formatMoney(curseForgeRewardBalanceUsd.value)}`
				: pending != null
					? `${formatMoney(pending)} pending on Modrinth`
					: 'No provider balance available',
		},
		{
			label: `Paid · ${periodDays.value}d`,
			value: formatMoney(paidCurrent.value),
			icon: CurrencyIcon,
			subtitle: 'Settled withdrawals in the selected period',
		},
		{
			label: 'Sources included',
			value: `${includedProviderCount.value}/2`,
			icon: ChartIcon,
			subtitle: 'Earnings, balances and paid withdrawals keep separate settlement semantics',
		},
	]
})

const hasVisibleData = computed(() => {
	if (metricMode.value === 'downloads') {
		return (modrinthIncluded.value && modrinthProjects.value.length > 0) || curseForgeDownloadsIncluded.value
	}
	return modrinthIncluded.value || curseForgeMoneyIncluded.value
})
const selectedPeriodRefreshing = computed(() => Number(backgroundLoadingPeriod.value) === Number(periodDays.value))
const needsCurseForgePortalLogin = computed(() =>
	curseForgeSelectable.value && curseForgeCacheKnown.value && (!curseForgeAnalytics.value?.connected || curseForgeAnalytics.value?.needsLogin),
)
const pageNotice = computed(() => {
	if (selectedPeriodRefreshing.value) return `Refreshing ${periodDays.value}-day analytics because this range is missing or incomplete…`
	if (errorMessage.value && sourceMode.value !== 'curseforge') return errorMessage.value
	if (curseForgeErrorMessage.value && sourceMode.value !== 'modrinth') return curseForgeErrorMessage.value
	if (needsCurseForgePortalLogin.value) {
		return curseForgeConnected.value
			? 'CurseForge publishing is connected, but private creator analytics uses your CurseForge Authors browser session. Open the Author Dashboard, sign in there once, then refresh analytics.'
			: 'CurseForge creator analytics uses a CurseForge Authors browser session. Open the Author Dashboard and sign in; the publishing API token is a separate credential.'
	}
	if (modrinthCacheKnown.value && !modrinthCredentials.value && sourceMode.value === 'modrinth') return 'Sign into Modrinth to load creator analytics for your projects.'
	if (sourceMode.value === 'combined' && includedProviderCount.value < 2 && (modrinthCacheKnown.value || curseForgeCacheKnown.value)) {
		return 'Combined is showing every provider with compatible data currently available. Missing provider values stay excluded instead of being estimated.'
	}
	if (curseForgeAnalytics.value?.downloadsError && metricMode.value === 'downloads' && sourceMode.value !== 'modrinth') {
		return `CurseForge rewards are connected, but download analytics could not be read: ${curseForgeAnalytics.value.downloadsError}`
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
			value: metricMode.value === 'downloads' ? modrinthCurrentDownloads.value : modrinthCurrentRevenue.value,
			detail: null,
		})
	}
	if (sourceMode.value !== 'modrinth') {
		rows.push({
			provider: 'CurseForge',
			className: 'curseforge',
			included: curseForgeIncluded.value,
			projects: metricMode.value === 'downloads' ? curseForgeDownloads.value?.projects?.length ?? 0 : buildCurseForgeEarningsByProject().size,
			value: metricMode.value === 'downloads' ? curseForgeCurrentDownloads.value : curseForgeCurrentRevenue.value,
			detail: metricMode.value === 'monetization' && curseForgeIncluded.value ? `${formatPoints(curseForgeCurrentPoints.value)} points` : null,
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
	return `${change > 0 ? '+' : ''}${change.toFixed(1)}%`
}

function hydrateCreatorAnalytics(snapshot = getCreatorAnalyticsSnapshot(periodDays.value)) {
	if (Number(snapshot?.periodDays) !== Number(periodDays.value)) return

	const modrinth = snapshot?.modrinth ?? null
	modrinthCacheKnown.value = !!modrinth
	if (modrinth) {
		modrinthCredentials.value = modrinth.authenticated
			? { user_id: modrinth.userId, cached: true }
			: null
		modrinthProjects.value = Array.isArray(modrinth.projects) ? modrinth.projects : []
		analyticsResponse.value = modrinth.analyticsResponse ?? null
		payoutBalance.value = modrinth.payoutBalance ?? null
		payoutHistory.value = Array.isArray(modrinth.payoutHistory) ? modrinth.payoutHistory : []
		errorMessage.value = modrinth.error ? `Could not refresh Modrinth analytics: ${modrinth.error}` : ''
	} else {
		modrinthCredentials.value = null
		modrinthProjects.value = []
		analyticsResponse.value = null
		payoutBalance.value = null
		payoutHistory.value = []
		errorMessage.value = ''
	}

	const curseforge = snapshot?.curseforge ?? null
	curseForgeCacheKnown.value = !!curseforge
	if (curseforge) {
		curseForgeAnalytics.value = curseforge.analytics ?? null
		curseForgeErrorMessage.value = curseforge.error
			? `Could not refresh CurseForge analytics: ${curseforge.error}`
			: ''
	} else {
		curseForgeAnalytics.value = null
		curseForgeErrorMessage.value = ''
	}
}

async function refreshAnalytics() {
	loading.value = true
	errorMessage.value = ''
	curseForgeErrorMessage.value = ''
	try {
		const snapshot = await refreshCreatorAnalyticsPeriod(periodDays.value, { force: true })
		hydrateCreatorAnalytics(snapshot)
	} catch (error) {
		console.error('Failed to refresh creator analytics', error)
		errorMessage.value = error instanceof Error
			? `Could not refresh creator analytics: ${error.message}`
			: `Could not refresh creator analytics: ${String(error)}`
	} finally {
		loading.value = false
	}
}

function refreshPeriodInBackground() {
	const requestedPeriod = Number(periodDays.value)
	const incomplete = !isCreatorAnalyticsPeriodComplete(requestedPeriod)
	if (incomplete) backgroundLoadingPeriod.value = requestedPeriod
	void refreshCreatorAnalyticsPeriod(requestedPeriod, { force: incomplete })
		.then((snapshot) => {
			if (Number(periodDays.value) === requestedPeriod) hydrateCreatorAnalytics(snapshot)
		})
		.catch((error) => {
			if (import.meta.env.DEV) console.debug('[Fodrinth] Cached analytics refresh failed', error)
		})
		.finally(() => {
			if (Number(backgroundLoadingPeriod.value) === requestedPeriod) backgroundLoadingPeriod.value = null
		})
}

function handleCreatorAnalyticsCacheUpdated(event) {
	if (Number(event?.detail?.periodDays) !== Number(periodDays.value)) return
	hydrateCreatorAnalytics()
}

async function connectCurseForgeAnalytics() {
	openingCurseForgePortal.value = true
	try {
		await openCurseForgeAuthorPortal()
	} catch (error) {
		curseForgeErrorMessage.value = error instanceof Error ? error.message : `Could not open CurseForge Authors: ${String(error)}`
	} finally {
		openingCurseForgePortal.value = false
	}
}

function updateCurseForgeState() {
	curseForgeConnected.value = isCurseForgeAuthenticated()
	curseForgeProfile.value = getCurseForgeProfile()
}

function updateCreatorProjectLinks() {
	creatorProjectLinks.value = getCreatorProjectLinks()
}

watch(periodDays, () => {
	hydrateCreatorAnalytics()
	refreshPeriodInBackground()
})
watch(metricMode, () => {
	if (metricMode.value !== 'downloads' && projectSort.value === 'alltime') projectSort.value = 'period'
})

onMounted(() => {
	window.addEventListener(CURSEFORGE_AUTH_CHANGED_EVENT, updateCurseForgeState)
	window.addEventListener(CREATOR_PROJECT_LINKS_CHANGED_EVENT, updateCreatorProjectLinks)
	window.addEventListener(CREATOR_ANALYTICS_CACHE_UPDATED_EVENT, handleCreatorAnalyticsCacheUpdated)
	hydrateCreatorAnalytics()
	refreshPeriodInBackground()
})

onBeforeUnmount(() => {
	window.removeEventListener(CURSEFORGE_AUTH_CHANGED_EVENT, updateCurseForgeState)
	window.removeEventListener(CREATOR_PROJECT_LINKS_CHANGED_EVENT, updateCreatorProjectLinks)
	window.removeEventListener(CREATOR_ANALYTICS_CACHE_UPDATED_EVENT, handleCreatorAnalyticsCacheUpdated)
})
</script>

<template>
	<div class="w-full p-6 md:p-8">
		<div class="mx-auto flex max-w-7xl flex-col gap-4 pb-16">
			<div class="flex flex-wrap items-start justify-between gap-4">
				<div>
					<h1 class="m-0 text-2xl font-semibold text-contrast md:text-3xl">Analytics</h1>
					<p class="mb-0 mt-1 max-w-3xl text-secondary">Unified creator analytics across Modrinth and CurseForge, while preserving provider-native metric semantics.</p>
				</div>
				<button type="button" class="flex h-10 items-center gap-2 rounded-xl border border-solid border-surface-5 bg-surface-3 px-4 font-medium text-primary transition-colors hover:bg-surface-4 disabled:opacity-60" :disabled="loading" @click="refreshAnalytics">
					<RefreshCwIcon class="size-4" :class="{ 'animate-spin': loading }" />
					Refresh
				</button>
			</div>

			<div class="flex flex-col gap-3 rounded-2xl border border-solid border-surface-5 bg-surface-3 p-3">
				<div class="flex flex-wrap items-center gap-2">
					<button v-for="tab in sourceTabs" :key="tab.id" type="button" class="rounded-xl border border-solid px-4 py-2 font-medium transition-colors" :class="sourceMode === tab.id ? 'border-brand bg-brand-highlight text-contrast' : 'border-transparent bg-transparent text-primary hover:bg-surface-4'" @click="sourceMode = tab.id">
						{{ tab.label }}
					</button>
				</div>
				<div class="flex flex-wrap items-center justify-between gap-3 border-0 border-t border-solid border-surface-4 pt-3">
					<div class="flex flex-wrap items-center gap-2">
						<button v-for="tab in metricTabs" :key="tab.id" type="button" class="flex items-center gap-2 rounded-xl px-3 py-2 font-medium transition-colors" :class="metricMode === tab.id ? 'bg-surface-5 text-contrast' : 'text-primary hover:bg-surface-4'" @click="metricMode = tab.id">
							<component :is="tab.icon" class="size-4" />
							{{ tab.label }}
						</button>
					</div>
					<div class="flex flex-wrap items-center gap-2">
						<div class="flex rounded-xl bg-surface-2 p-1">
							<button v-for="tab in viewTabs" :key="tab.id" type="button" class="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors" :class="viewMode === tab.id ? 'bg-surface-4 text-contrast' : 'text-secondary hover:text-primary'" @click="viewMode = tab.id">
								{{ tab.label }}
							</button>
						</div>
						<select v-model.number="periodDays" class="h-9 rounded-xl border border-solid border-surface-5 bg-surface-2 px-3 text-sm font-medium text-primary outline-none">
							<option v-for="period in periods" :key="period.days" :value="period.days">{{ period.label }}</option>
						</select>
					</div>
				</div>
			</div>

			<div v-if="pageNotice" class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-solid border-surface-5 bg-surface-2 px-4 py-3 text-sm text-secondary">
				<span class="min-w-0 flex-1">{{ pageNotice }}</span>
				<button v-if="needsCurseForgePortalLogin" type="button" class="rounded-lg border border-solid border-[#ff7849]/40 bg-[#ff7849]/10 px-3 py-1.5 font-semibold text-[#ff8c66] transition-colors hover:bg-[#ff7849]/20 disabled:opacity-60" :disabled="openingCurseForgePortal" @click="connectCurseForgeAnalytics">
					{{ openingCurseForgePortal ? 'Opening…' : 'Open Author Dashboard' }}
				</button>
			</div>

			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
				<div v-for="card in summaryCards" :key="card.label" class="flex min-h-32 flex-col justify-between rounded-2xl border border-solid border-surface-5 bg-surface-3 p-4">
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
						<p class="mb-0 mt-1 text-xs text-secondary">{{ dateFormatter.format(rangeDates.start) }} — {{ dateFormatter.format(rangeDates.end) }}</p>
					</div>
					<div class="flex items-center gap-4 text-xs text-secondary">
						<span v-if="sourceMode !== 'curseforge'" class="flex items-center gap-2" :class="{ 'opacity-40': !modrinthIncluded }"><i class="provider-dot modrinth"></i>Modrinth</span>
						<span v-if="sourceMode !== 'modrinth'" class="flex items-center gap-2" :class="{ 'opacity-40': !curseForgeIncluded }"><i class="provider-dot curseforge"></i>CurseForge</span>
					</div>
				</div>
				<div class="relative h-[300px] p-5">
					<div v-if="loading || selectedPeriodRefreshing" class="absolute inset-0 z-10 flex items-center justify-center bg-surface-3/70 backdrop-blur-sm">
						<div class="flex items-center gap-2 font-medium text-primary"><RefreshCwIcon class="size-5 animate-spin" />Fetching analytics…</div>
					</div>
					<div v-if="!hasVisibleData || chartLines.length === 0" class="flex h-full items-center justify-center text-center">
						<div class="max-w-md">
							<ChartIcon class="mx-auto size-8 text-secondary" />
							<h3 class="mb-1 mt-3 text-base font-semibold text-contrast">No chart data available</h3>
							<p class="m-0 text-sm text-secondary">The selected provider did not expose a usable time series for this range.</p>
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
							<svg v-for="line in chartLines" :key="line.id" class="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 760 220" preserveAspectRatio="none" aria-hidden="true" :style="{ color: line.color }">
								<polygon :points="line.areaPoints" fill="currentColor" :opacity="line.areaOpacity" />
								<polyline :points="line.points" fill="none" stroke="currentColor" stroke-width="3" vector-effect="non-scaling-stroke" />
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
							<div class="mt-0.5 text-xs text-secondary">{{ row.included ? `${row.projects} project${row.projects === 1 ? '' : 's'} represented` : 'Provider analytics unavailable for this metric' }}</div>
						</div>
						<div class="text-right">
							<div class="font-semibold" :class="row.included ? 'text-contrast' : 'text-secondary'">{{ providerValue(row) }}</div>
							<div v-if="row.detail" class="mt-0.5 text-xs text-[#ff8c66]">{{ row.detail }}</div>
							<div v-else class="mt-0.5 text-xs text-secondary">{{ metricMode === 'downloads' ? 'period downloads' : 'period creator earnings' }}</div>
						</div>
					</div>
				</div>
			</section>

			<section v-else class="overflow-hidden rounded-2xl border border-solid border-surface-5 bg-surface-3">
				<div class="flex flex-wrap items-center justify-between gap-3 border-0 border-b border-solid border-surface-4 px-5 py-4">
					<div>
						<h2 class="m-0 text-lg font-semibold text-contrast">Project comparison</h2>
						<p class="mb-0 mt-1 text-sm text-secondary">{{ syncProjects && sourceMode === 'combined' && metricMode === 'downloads' ? 'Linked Modrinth and CurseForge publications are shown as one synchronized project.' : 'Individual publications stay separate by provider.' }}</p>
					</div>
					<div class="flex flex-wrap items-center gap-2">
						<label class="inline-flex h-9 cursor-pointer items-center gap-2 rounded-xl border border-solid border-surface-5 bg-surface-2 px-3 text-sm font-medium text-primary">
							<input v-model="syncProjects" type="checkbox" class="size-4 accent-brand" :disabled="sourceMode !== 'combined' || metricMode !== 'downloads'" />
							Sync
						</label>
						<select v-model="projectSort" class="h-9 rounded-xl border border-solid border-surface-5 bg-surface-2 px-3 text-sm font-medium text-primary outline-none">
							<option v-for="option in projectSortOptions" :key="option.id" :value="option.id">Sort: {{ option.label }}</option>
						</select>
					</div>
				</div>
				<div v-if="projectRows.length === 0" class="p-8 text-center text-sm text-secondary">No comparable project data is available for this source.</div>
				<div v-else class="overflow-x-auto">
					<table class="w-full border-collapse text-left">
						<thead>
							<tr class="text-xs uppercase tracking-wide text-secondary">
								<th class="px-5 py-3 font-medium">Project</th>
								<th class="px-5 py-3 font-medium">Provider</th>
								<th class="px-5 py-3 font-medium">{{ metricMode === 'downloads' ? 'Period downloads' : 'Creator earnings' }}</th>
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
											<div class="mt-1 flex h-1.5 overflow-hidden rounded-full bg-surface-4">
												<div v-for="segment in projectBarSegments(row)" :key="segment.provider" class="h-full first:rounded-l-full last:rounded-r-full" :class="segment.className === 'curseforge' ? 'bg-[#ff7849]' : 'bg-brand'" :style="{ width: `${segment.share}%` }" :title="`${segment.provider}: ${metricMode === 'downloads' ? formatNumber(segment.periodValue) : formatMoney(segment.periodValue)} (${segment.share.toFixed(1)}%)`"></div>
											</div>
										</div>
									</div>
								</td>
								<td class="px-5 py-3">
									<span class="inline-flex items-center gap-2 text-sm text-primary"><i class="provider-dot" :class="row.className"></i>{{ row.provider }}</span>
								</td>
								<td class="px-5 py-3 font-semibold text-contrast">{{ metricMode === 'downloads' ? formatNumber(row.periodValue) : formatMoney(row.periodValue) }}</td>
								<td v-if="metricMode === 'downloads'" class="px-5 py-3 text-primary">{{ formatNumber(row.allTimeDownloads) }}</td>
							</tr>
						</tbody>
					</table>
				</div>
			</section>

			<div v-if="metricMode === 'monetization'" class="rounded-xl border border-solid border-surface-5 bg-surface-2 px-4 py-3 text-xs leading-relaxed text-secondary">
				CurseForge Reward Points are converted at <strong class="text-primary">1 point = $0.05 USD</strong>. Fodrinth still keeps <strong class="text-primary">period earnings</strong>, <strong class="text-primary">available balance</strong>, and <strong class="text-primary">paid withdrawals</strong> separate, so money in different settlement states is never silently added together.
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

.text-curseforge {
	color: #ff7849;
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