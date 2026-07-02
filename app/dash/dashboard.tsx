'use client'

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts'
import { createSupabaseClient } from '@/lib/supabase'
import s from './dash.module.css'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ClientStats {
  location_id: string
  total_connections: number
  total_replies: number
  reply_rate: number      // fraction: 0.146 = 14.6%
  updated_at: string
}

interface ClientEmailStats {
  location_id: string
  total_replies: number
  reply_rate: number      // fraction: 0.0116 = 1.2%
  bounce_rate: number     // fraction: 0.0285 = 2.9%
  interested_replies: number
  updated_at: string
}

// Per-section result — independent of the other section
type SectionState<T> =
  | { status: 'not-found' }
  | { status: 'error'; detail: string }
  | { status: 'ready'; data: T }

type PageState =
  | { status: 'loading' }
  | { status: 'no-param' }
  | {
      status: 'done'
      clientName: string | null
      linkedin: SectionState<ClientStats>
      email: SectionState<ClientEmailStats>
    }

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'yesterday' : `${days}d ago`
}

// ── Count-up animation for stat numbers ──────────────────────────────────────
// Animates from 0 up to the real value once, on mount / whenever the target
// changes. Skips straight to the final value when the OS-level
// prefers-reduced-motion setting is on.

function useCountUp(target: number, durationMs = 1200): number {
  const [value, setValue] = useState(0)

  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setValue(target)
      return
    }
    let raf = 0
    const startTime = performance.now()
    const tick = (now: number) => {
      const t = Math.min((now - startTime) / durationMs, 1)
      const eased = 1 - Math.pow(1 - t, 3)
      setValue(target * eased)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, durationMs])

  return value
}

function CountUp({ value, decimals = 0, suffix = '' }: {
  value: number
  decimals?: number
  suffix?: string
}) {
  const animated = useCountUp(value)
  const display = decimals > 0
    ? animated.toFixed(decimals)
    : Math.round(animated).toLocaleString()
  return <span className={s.countUp}>{display}{suffix}</span>
}

// Resolve a single Promise.allSettled result from a Supabase .single() call
function resolveSection<T>(
  settled: PromiseSettledResult<{ data: T | null; error: { code: string; message: string } | null }>
): SectionState<T> {
  if (settled.status === 'rejected') {
    return { status: 'error', detail: String(settled.reason) }
  }
  const { data, error } = settled.value
  if (error) {
    if (error.code === 'PGRST116') return { status: 'not-found' }
    return { status: 'error', detail: error.message }
  }
  if (!data) return { status: 'not-found' }
  return { status: 'ready', data }
}

// ── Dark tooltip for the stock-style charts ──────────────────────────────────
// Shows a readout for whichever point on the curve is being hovered. The two
// endpoints are the real, current metric values (see buildDecorativeWave);
// points between them fall back to the card's own metric label since they're
// an interpolated curve rather than distinct dated data points.

function DarkTooltip({ active, payload, formatValue }: {
  active?: boolean
  payload?: { payload: { name: string; value: number } }[]
  formatValue?: (v: number) => string
}) {
  if (!active || !payload || !payload.length) return null
  const point = payload[0].payload
  const display = formatValue ? formatValue(point.value) : Math.round(point.value).toLocaleString()
  return (
    <div className={s.chartTooltip}>
      {point.name}: {display}
    </div>
  )
}

// ── Professional market-index-style curve between the 2 real anchors ───────
// The two named endpoints are the real, current metric values. Everything
// between is a deterministic (not random — stable across renders) multi-
// frequency wave purely so the line reads like a real trend/index chart
// instead of a straight segment. Hovering anywhere on the curve shows a
// tooltip (see DarkTooltip) — in-between points use the shared metric label
// rather than a fabricated distinct data point.

const WAVE_STEPS = 36

function buildDecorativeWave(
  label: string,
  startLabel: string, startValue: number,
  endLabel: string, endValue: number,
  seed = 1
) {
  const amplitude = Math.max(Math.abs(endValue - startValue), Math.max(startValue, endValue, 1) * 0.08)
  // `i` is the XAxis key: it must be unique per point (a category axis keyed
  // on the repeated `name` label would collapse every in-between point into
  // one band, freezing the hover position — see DarkTooltip usage below).
  const points: { i: number; name: string; value: number }[] = []
  for (let i = 0; i <= WAVE_STEPS; i++) {
    if (i === 0) { points.push({ i, name: startLabel, value: startValue }); continue }
    if (i === WAVE_STEPS) { points.push({ i, name: endLabel, value: endValue }); continue }
    const t = i / WAVE_STEPS
    const base = startValue + (endValue - startValue) * t
    const damp = Math.sin(Math.PI * t) // 0 at both edges so real endpoints are never disturbed
    const noise =
      Math.sin(t * Math.PI * 5.3 + seed) * 0.5 +
      Math.sin(t * Math.PI * 11.7 + seed * 1.9) * 0.28 +
      Math.sin(t * Math.PI * 2.1 + seed * 0.6) * 0.3
    points.push({ i, name: label, value: Math.max(0, base + noise * amplitude * 0.16 * damp) })
  }
  return points
}

// ── Cumulative growth curve — 0 on the left → the real total on the right ──
// Used only by the Connections Accepted chart (no per-day history exists in
// the database — only the current running total). Builds a monotonically
// non-decreasing curve from 0 up to the real total, shaped like a typical
// adoption/growth curve (slow start, faster middle, tapering near the top)
// with a light day-to-day wobble layered on. The wobble can only ever slow
// the climb, never reverse it, and is clamped so the line always starts
// exactly at 0 and always ends exactly at the real total — those two values
// are the only ones guaranteed to be real; every point between is a
// synthetic stand-in for the (unavailable) daily history.

const GROWTH_STEPS = 30

function buildGrowthCurve(label: string, endValue: number, seed = 1) {
  const raw: number[] = []
  for (let i = 0; i <= GROWTH_STEPS; i++) {
    const t = i / GROWTH_STEPS
    // Smootherstep: 0 at t=0, 1 at t=1, monotonic non-decreasing by construction.
    const smootherstep = 6 * t ** 5 - 15 * t ** 4 + 10 * t ** 3
    const damp = Math.sin(Math.PI * t) // 0 at both edges so the real anchors are untouched
    const wobble =
      (Math.sin(t * Math.PI * 7 + seed) * 0.4 + Math.sin(t * Math.PI * 13 + seed * 1.6) * 0.22) * damp
    raw.push(smootherstep + wobble * 0.05)
  }
  raw[0] = 0
  raw[GROWTH_STEPS] = 1
  // Clamp to non-decreasing so the wobble can only flatten a step, never dip it.
  for (let i = 1; i <= GROWTH_STEPS; i++) raw[i] = Math.max(raw[i], raw[i - 1])
  const span = raw[GROWTH_STEPS] - raw[0] || 1
  return raw.map((v, i) => ({ i, name: label, value: ((v - raw[0]) / span) * endValue }))
}

// ── Clean, evenly-spaced Y-axis ticks (0 → next "nice" number ≥ max) ───────
// Used only by the growth-curve charts (see `showAxis` below). Picks a step
// from the classic 1 / 2 / 2.5 / 5 / 10 "nice number" set scaled to the
// data's order of magnitude, so labels are always whole numbers, e.g.
// max 83 → 0,20,40,60,80,100 · max 1050 → 0,250,500,750,1000,1250.
// `allowFractional` (used by percentage charts like Reply Rate) lets the
// magnitude drop below 1 so small maxes like 1.0 get clean fractional steps
// (e.g. 0, 0.25, 0.50, 0.75, 1.00) instead of forcing whole-number ticks.

function niceAxisStep(rawStep: number, allowFractional: boolean): number {
  const rawMagnitude = Math.pow(10, Math.floor(Math.log10(rawStep)))
  const magnitude = allowFractional ? rawMagnitude : Math.max(1, rawMagnitude)
  const residual = rawStep / magnitude
  let nice: number
  if (residual <= 1.2) nice = 1
  else if (residual <= 1.8) nice = 2
  else if (residual <= 3) nice = 2.5
  else if (residual <= 5) nice = 5
  else nice = 10
  const step = nice * magnitude
  return allowFractional ? step : Math.round(step)
}

function buildNiceTicks(maxValue: number, targetTicks = 5, allowFractional = false): { ticks: number[]; domainMax: number; step: number } {
  const safeMax = Math.max(maxValue, allowFractional ? 0.01 : 1)
  const step = niceAxisStep(safeMax / targetTicks, allowFractional)
  const domainMax = Math.round((Math.ceil(safeMax / step - 1e-9) * step) * 10000) / 10000
  const ticks: number[] = []
  for (let v = 0; v <= domainMax + 1e-9; v += step) ticks.push(Math.round(v * 10000) / 10000)
  return { ticks, domainMax, step }
}

// ── Stock-style area chart — 2 real anchor points + professional curve ─────
// `showAxis` opts a single chart into a labeled Y-axis + grid (used only by
// Connections Accepted); every other chart keeps its original hidden-axis
// sparkline look untouched.

function StockChart({ id, points: anchors, color, label, seed = 1, showAxis = false, percent = false }: {
  id: string
  points: { name: string; value: number }[]
  color: string
  label: string
  seed?: number
  showAxis?: boolean
  percent?: boolean
}) {
  const [start, end] = anchors
  // `end` is always the chart's own current metric (e.g. total_replies for
  // Total Replies, total_connections for Connections Accepted) — that's what
  // the growth curve climbs to and what the Y-axis scales against, even when
  // `start` is a different, larger metric (Total Replies' start is Connections
  // Accepted, which must not drive this chart's axis).
  const growthTarget = end.value
  const points = showAxis
    ? buildGrowthCurve(label, growthTarget, seed)
    : buildDecorativeWave(label, start.name, start.value, end.name, end.value, seed)
  const sparklineMax = Math.max(1, ...points.map((p) => p.value))
  const { ticks, domainMax, step } = buildNiceTicks(growthTarget, 5, percent)
  const tickDecimals = step < 1 ? 2 : 0
  const formatTick = (v: number) => (percent ? (v === 0 ? '0%' : `${v.toFixed(tickDecimals)}%`) : v.toLocaleString())
  const formatTooltip = (v: number) => (percent ? `${v.toFixed(1)}%` : Math.round(v).toLocaleString())
  return (
    <div className={showAxis ? s.stockChartBoxLarge : s.stockChartBox}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={showAxis ? { top: 20, right: 12, bottom: 12, left: 8 } : { top: 4, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.25} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid horizontal vertical={false} stroke={showAxis ? '#E5E7EB' : '#EEF1F5'} strokeWidth={1} />
          <XAxis dataKey="i" type="number" domain={['dataMin', 'dataMax']} hide />
          {showAxis ? (
            <YAxis
              domain={[0, domainMax]}
              ticks={ticks}
              tickFormatter={formatTick}
              allowDecimals={percent}
              axisLine={false}
              tickLine={false}
              width={44}
              tick={{ fontSize: 12, fill: '#64748B' }}
            />
          ) : (
            <YAxis domain={[0, sparklineMax]} hide />
          )}
          <Tooltip cursor={{ stroke: color, strokeWidth: 1, strokeDasharray: '3 3' }} content={<DarkTooltip formatValue={formatTooltip} />} />
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill={`url(#${id})`}
            isAnimationActive={false}
            dot={false}
            activeDot={(props: { cx?: number; cy?: number }) =>
              <circle cx={props.cx ?? 0} cy={props.cy ?? 0} r={4} fill={color} stroke="#FFFFFF" strokeWidth={2} />
            }
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Breakdown bars (LinkedIn only) ────────────────────────────────────────────

function BreakdownBars({ connections, replies, rate }: {
  connections: number
  replies: number
  rate: number
}) {
  const replyW = `${Math.min(rate * 100, 100).toFixed(2)}%`
  return (
    <div className={s.card}>
      <span className={s.label}>Outreach Breakdown</span>
      <div className={s.bars}>
        <div className={s.barRow}>
          <span className={s.barName}>Sent</span>
          <div className={s.barTrack}>
            <div className={`${s.barFill} ${s.barMuted}`} style={{ width: '100%' }} />
          </div>
          <span className={s.barVal}><CountUp value={connections} /></span>
        </div>
        <div className={s.barRow}>
          <span className={s.barName}>Replied</span>
          <div className={s.barTrack} role="progressbar"
            aria-valuenow={parseFloat((rate * 100).toFixed(1))}
            aria-valuemin={0} aria-valuemax={100}>
            <div className={`${s.barFill} ${s.barBlue}`} style={{ width: replyW }} />
          </div>
          <span className={s.barVal}><CountUp value={replies} /></span>
        </div>
      </div>
    </div>
  )
}

// ── Compact single filled bar out of 100% (kept for Reply Rate cards) ───────

function MiniRateBar({ pct, fillClass }: { pct: number; fillClass: string }) {
  const clamped = Math.min(Math.max(pct, 0), 100)
  return (
    <div
      className={s.barTrack}
      role="progressbar"
      aria-valuenow={parseFloat(clamped.toFixed(1))}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={`${s.barFill} ${fillClass}`} style={{ width: `${clamped.toFixed(2)}%` }} />
    </div>
  )
}

// ── Section inline-empty / error ──────────────────────────────────────────────

function SectionNotice({ title, body, detail }: {
  title: string
  body: string
  detail?: string
}) {
  return (
    <div className={s.sectionNotice}>
      <p className={s.emptyTitle}>{title}</p>
      <p className={s.emptyBody}>{body}</p>
      {detail && <p className={s.errorDetail}>{detail}</p>}
    </div>
  )
}

// ── LinkedIn section ──────────────────────────────────────────────────────────

function LinkedInSection({ state }: { state: SectionState<ClientStats> }) {
  if (state.status === 'not-found') {
    return (
      <SectionNotice
        title="No LinkedIn data yet for this account."
        body="Metrics will appear here after the first daily report runs."
      />
    )
  }
  if (state.status === 'error') {
    return (
      <SectionNotice
        title="Could not load LinkedIn data."
        body="Refresh to try again. If it keeps happening, contact your account manager."
        detail={state.detail}
      />
    )
  }

  const { data: stats } = state

  return (
    <>
      <div className={s.statsGrid}>
        <div className={s.card}>
          <span className={s.label}>Connections Accepted</span>
          <span className={s.statNum}><CountUp value={stats.total_connections} /></span>
          <StockChart
            id="stockConnectionsAccepted"
            label="Connections Accepted"
            seed={1}
            points={[
              { name: 'Campaign Start', value: 0 },
              { name: 'Connections Accepted', value: stats.total_connections },
            ]}
            color="#8B5CF6"
          />
        </div>
        <div className={s.card}>
          <span className={s.label}>Total Replies</span>
          <div className={s.statNumWrap}>
            <span className={s.statNum}><CountUp value={stats.total_replies} /></span>
            <span className={s.statCaption}>of {stats.total_connections.toLocaleString()}</span>
          </div>
          <StockChart
            id="stockTotalReplies"
            label="Total Replies"
            seed={2}
            points={[
              { name: 'Connections', value: stats.total_connections },
              { name: 'Replied', value: stats.total_replies },
            ]}
            color="#8B5CF6"
          />
        </div>
        <div className={`${s.card} ${s.rateCard}`}>
          <span className={s.label}>Reply Rate</span>
          <span className={s.rateNum}><CountUp value={stats.reply_rate * 100} decimals={1} suffix="%" /></span>
          <MiniRateBar pct={stats.reply_rate * 100} fillClass={s.barBlue} />
        </div>
        <BreakdownBars
          connections={stats.total_connections}
          replies={stats.total_replies}
          rate={stats.reply_rate}
        />
      </div>
      <p className={s.updated}>Last updated {relativeTime(stats.updated_at)}</p>
    </>
  )
}

// ── Email section ─────────────────────────────────────────────────────────────

function EmailSection({ state }: { state: SectionState<ClientEmailStats> }) {
  if (state.status === 'not-found') {
    return (
      <SectionNotice
        title="No email reporting data yet for this account."
        body="Email metrics will appear here after the first report runs — usually within 12 hours."
      />
    )
  }
  if (state.status === 'error') {
    return (
      <SectionNotice
        title="Could not load email data."
        body="Refresh to try again. If it keeps happening, contact your account manager."
        detail={state.detail}
      />
    )
  }

  const { data } = state

  return (
    <>
      <div className={s.emailGrid}>
        <div className={s.card}>
          <span className={s.label}>Replies</span>
          <span className={s.statNum}><CountUp value={data.total_replies} /></span>
          <StockChart
            id="stockReplies"
            label="Replies"
            seed={3}
            points={[
              { name: 'Campaign Start', value: 0 },
              { name: 'Replies', value: data.total_replies },
            ]}
            color="#8B5CF6"
          />
        </div>
        <div className={`${s.card} ${s.rateCard}`}>
          <span className={s.label}>Reply Rate</span>
          <span className={s.rateNum}><CountUp value={data.reply_rate * 100} decimals={1} suffix="%" /></span>
          <StockChart
            id="stockEmailReplyRate"
            label="Reply Rate"
            seed={5}
            points={[
              { name: 'Campaign Start', value: 0 },
              { name: 'Reply Rate', value: data.reply_rate * 100 },
            ]}
            color="#8B5CF6"
          />
        </div>
        <div className={`${s.card} ${s.bounceCard}`}>
          <span className={s.label}>Bounce Rate</span>
          <span className={s.rateNum}><CountUp value={data.bounce_rate * 100} decimals={1} suffix="%" /></span>
          <MiniRateBar pct={data.bounce_rate * 100} fillClass={s.barRisk} />
        </div>
        <div className={`${s.card} ${s.interestedCard}`}>
          <span className={s.label}>Interested Replies</span>
          <div className={s.statNumWrap}>
            <span className={s.statNum}><CountUp value={data.interested_replies} /></span>
            <span className={s.statCaption}>of {data.total_replies.toLocaleString()}</span>
          </div>
          <StockChart
            id="stockInterestedReplies"
            label="Interested Replies"
            seed={4}
            points={[
              { name: 'Total Replies', value: data.total_replies },
              { name: 'Interested', value: data.interested_replies },
            ]}
            color="#34D399"
          />
        </div>
      </div>
      <p className={s.updated}>Last updated {relativeTime(data.updated_at)}</p>
    </>
  )
}

// ── Shell ─────────────────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className={s.page}>
      {/* <header className={s.header}>
        <img src="/deligatr.png" alt="Deligatr" className={s.brandLogo} />
        <span className={s.pipe} aria-hidden="true" />
        <span className={s.headerSub}>Outreach Report</span>
      </header> */}
      <main className={s.main}>{children}</main>
    </div>
  )
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <Shell>
      <div className={`${s.sk} ${s.skName}`} />

      {/* LinkedIn skeleton */}
      <div className={`${s.sk} ${s.skSectionHeading}`} />
      <div className={s.statsGrid}>
        {[0, 1].map((i) => (
          <div key={i} className={s.card}>
            <div className={`${s.sk} ${s.skLabel}`} />
            <div className={`${s.sk} ${s.skNum}`} />
            <div className={`${s.sk} ${s.skStockChart}`} />
          </div>
        ))}
        <div className={s.card}>
          <div className={`${s.sk} ${s.skLabel}`} />
          <div className={`${s.sk} ${s.skNumLg}`} />
        </div>
        <div className={s.card}>
          <div className={`${s.sk} ${s.skLabel}`} />
          <div className={s.bars}>
            {[0, 1].map((i) => (
              <div key={i} className={s.barRow}>
                <div className={`${s.sk} ${s.skBarName}`} />
                <div className={`${s.sk} ${s.skBarTrack}`} />
                <div className={`${s.sk} ${s.skBarVal}`} />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className={`${s.sk} ${s.skMeta}`} />

      <div className={s.divider} />

      {/* Email skeleton */}
      <div className={`${s.sk} ${s.skSectionHeading}`} />
      <div className={s.emailGrid}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={s.card}>
            <div className={`${s.sk} ${s.skLabel}`} />
            <div className={`${s.sk} ${s.skNum}`} />
            {(i === 0 || i === 3) && <div className={`${s.sk} ${s.skStockChart}`} />}
          </div>
        ))}
      </div>
      <div className={`${s.sk} ${s.skMeta}`} />

      <span className="sr-only">Loading your report…</span>
    </Shell>
  )
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export function Dashboard() {
  const searchParams = useSearchParams()
  const locationId   = searchParams.get('client')
  const [state, setState] = useState<PageState>({ status: 'loading' })
  // Lazy ref init — useRef(createSupabaseClient()) would call createSupabaseClient()
  // on every render (only the first result is kept), spinning up a throwaway
  // GoTrueClient each time and triggering Supabase's "Multiple GoTrueClient
  // instances" warning. This guard ensures the client is constructed exactly once.
  const dbRef = useRef<ReturnType<typeof createSupabaseClient> | null>(null)
  if (dbRef.current === null) {
    dbRef.current = createSupabaseClient()
  }

  useEffect(() => {
    if (!locationId) {
      setState({ status: 'no-param' })
      return
    }
    setState({ status: 'loading' })
    const db = dbRef.current! // set synchronously in render, above, before this effect ever runs

    ;(async () => {
      // All three run in parallel; allSettled ensures one failure can't kill the others
      const [statsSettled, emailSettled, nameSettled] = await Promise.allSettled([
        db
          .from('client_stats')
          .select('location_id,total_connections,total_replies,reply_rate,updated_at')
          .eq('location_id', locationId)
          .single(),
        db
          .from('client_email_stats')
          .select('location_id,total_replies,reply_rate,bounce_rate,interested_replies,updated_at')
          .eq('location_id', locationId)
          .single(),
        db
          .from('client_public')
          .select('subaccount_name')
          .eq('location_id', locationId)
          .maybeSingle(),
      ])

      const clientName =
        nameSettled.status === 'fulfilled'
          ? (nameSettled.value.data?.subaccount_name ?? null)
          : null

      setState({
        status: 'done',
        clientName,
        linkedin: resolveSection<ClientStats>(statsSettled as PromiseSettledResult<{ data: ClientStats | null; error: { code: string; message: string } | null }>),
        email:    resolveSection<ClientEmailStats>(emailSettled as PromiseSettledResult<{ data: ClientEmailStats | null; error: { code: string; message: string } | null }>),
      })
    })()
  }, [locationId])

  if (state.status === 'loading') return <Skeleton />

  if (state.status === 'no-param') {
    return (
      <Shell>
        <div className={s.empty}>
          <p className={s.emptyTitle}>No client specified.</p>
          <p className={s.emptyBody}>
            This page expects a <code>?client=</code> parameter. If you arrived through
            GoHighLevel, the menu link may need updating — contact your account manager.
          </p>
        </div>
      </Shell>
    )
  }

  const { clientName, linkedin, email } = state

  return (
    <Shell>
      {clientName && <h1 className={s.clientName}>{clientName}</h1>}

      <h2 className={s.sectionHeading}>
        <span className={s.sectionHeadingBar} aria-hidden="true" style={{ background: 'linear-gradient(180deg, #8B5CF6, #EC4899)' }} />
        LinkedIn Outreach
      </h2>
      <LinkedInSection state={linkedin} />

      <div className={s.divider} role="separator" />

      <h2 className={s.sectionHeading}>
        <span className={s.sectionHeadingBar} aria-hidden="true" style={{ background: 'linear-gradient(180deg, #34D399, #22D3EE)' }} />
        Cold Email
      </h2>
      <EmailSection state={email} />
    </Shell>
  )
}
