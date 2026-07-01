'use client'

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
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

function fmtPct(fraction: number): string {
  return (fraction * 100).toFixed(1)
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

// ── Mini ring (reused in both sections) ──────────────────────────────────────

function MiniRing({ rate }: { rate: number }) {
  const sz = 56, sw = 6
  const r  = (sz - sw) / 2
  const c  = 2 * Math.PI * r
  const offset = c * (1 - Math.min(Math.max(rate, 0), 1))

  return (
    <div className={s.miniRingWrap} aria-hidden="true">
      <svg width={sz} height={sz} viewBox={`0 0 ${sz} ${sz}`}>
        <circle cx={sz/2} cy={sz/2} r={r} fill="none" stroke="#E2E8F0" strokeWidth={sw} />
        <circle
          cx={sz/2} cy={sz/2} r={r}
          fill="none"
          stroke="#2563EB"
          strokeWidth={sw}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${sz/2} ${sz/2})`}
          className={s.ringArc}
        />
      </svg>
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
          <span className={s.barVal}>{connections.toLocaleString()}</span>
        </div>
        <div className={s.barRow}>
          <span className={s.barName}>Replied</span>
          <div className={s.barTrack} role="progressbar"
            aria-valuenow={parseFloat((rate * 100).toFixed(1))}
            aria-valuemin={0} aria-valuemax={100}>
            <div className={`${s.barFill} ${s.barBlue}`} style={{ width: replyW }} />
          </div>
          <span className={s.barVal}>{replies.toLocaleString()}</span>
        </div>
      </div>
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
  const pct = fmtPct(stats.reply_rate)

  return (
    <>
      <div className={s.statsGrid}>
        <div className={s.card}>
          <span className={s.label}>Total Connections</span>
          <span className={s.statNum}>{stats.total_connections.toLocaleString()}</span>
        </div>
        <div className={s.card}>
          <span className={s.label}>Total Replies</span>
          <span className={s.statNum}>{stats.total_replies.toLocaleString()}</span>
        </div>
        <div className={`${s.card} ${s.rateCard}`}>
          <span className={s.label}>Reply Rate</span>
          <div className={s.rateRow}>
            <MiniRing rate={stats.reply_rate} />
            <span className={s.rateNum}>{pct}%</span>
          </div>
        </div>
      </div>
      <BreakdownBars
        connections={stats.total_connections}
        replies={stats.total_replies}
        rate={stats.reply_rate}
      />
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
  const replyRatePct  = fmtPct(data.reply_rate)
  const bounceRatePct = fmtPct(data.bounce_rate)

  return (
    <>
      <div className={s.emailGrid}>
        <div className={s.card}>
          <span className={s.label}>Replies</span>
          <span className={s.statNum}>{data.total_replies.toLocaleString()}</span>
        </div>
        <div className={`${s.card} ${s.rateCard}`}>
          <span className={s.label}>Reply Rate</span>
          <div className={s.rateRow}>
            <MiniRing rate={data.reply_rate} />
            <span className={s.rateNum}>{replyRatePct}%</span>
          </div>
        </div>
        <div className={`${s.card} ${s.bounceCard}`}>
          <span className={s.label}>Bounce Rate</span>
          <span className={s.statNum}>{bounceRatePct}%</span>
        </div>
        <div className={`${s.card} ${s.interestedCard}`}>
          <span className={s.label}>Interested Replies</span>
          <span className={s.statNum}>{data.interested_replies.toLocaleString()}</span>
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
      <header className={s.header}>
        <span className={s.brand}>DELIGATR</span>
        <span className={s.pipe} aria-hidden="true" />
        <span className={s.headerSub}>Outreach Report</span>
      </header>
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
          </div>
        ))}
        <div className={s.card}>
          <div className={`${s.sk} ${s.skLabel}`} />
          <div className={s.rateRow}>
            <div className={`${s.sk} ${s.skRing}`} />
            <div className={`${s.sk} ${s.skNumLg}`} />
          </div>
        </div>
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
      <div className={`${s.sk} ${s.skMeta}`} />

      <div className={s.divider} />

      {/* Email skeleton */}
      <div className={`${s.sk} ${s.skSectionHeading}`} />
      <div className={s.emailGrid}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={s.card}>
            <div className={`${s.sk} ${s.skLabel}`} />
            <div className={`${s.sk} ${s.skNum}`} />
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
  const dbRef = useRef(createSupabaseClient())

  useEffect(() => {
    if (!locationId) {
      setState({ status: 'no-param' })
      return
    }
    setState({ status: 'loading' })
    const db = dbRef.current

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

      <h2 className={s.sectionHeading}>LinkedIn Outreach</h2>
      <LinkedInSection state={linkedin} />

      <div className={s.divider} role="separator" />

      <h2 className={s.sectionHeading}>Cold Email</h2>
      <EmailSection state={email} />
    </Shell>
  )
}
