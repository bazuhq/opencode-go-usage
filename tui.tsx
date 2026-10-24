/**
 * Go Usage — OpenCode CLI plugin.
 *
 * Renders the OpenCode Go subscription meters (rolling 5h / weekly / monthly)
 * in the session sidebar. Each row shows the full quota window as a bar, the
 * actual usage as filled cells (█), and the theoretical time-elapsed pace as a
 * thin vertical tick (┃), followed by the used percentage and time until reset.
 *
 * Data source: GET https://opencode.ai/console/api/go/status using the Console
 * credential stored by OpenCode after `/connect`. Read-only; refreshes every
 * 60 seconds and immediately after each completed turn.
 */
/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { Show, createSignal } from "solid-js"

const GO_STATUS_URL = "https://opencode.ai/console/api/go/status"
const REFRESH_MS = 60_000
const FETCH_TIMEOUT_MS = 8_000
const BAR_WIDTH = 20
// Percentage points below the theoretical line that still count as "about to
// reach the pace" and paint the bar with the warning colour.
const PACE_WARN_GAP_PCT = 2
// The first minutes of a window have too little history for a pace reading:
// 2% used against 1% elapsed would paint the bar red. Until the window has
// meaningfully started, the bar stays green unless usage itself is already
// high enough to be a real burst.
const PACE_START_THEORY_PCT = 5
const PACE_START_USED_PCT = 10
// Saturation kept from the theme's feedback tokens when drawing the meter.
// A full-width 20-cell block of the raw token glares in the sidebar, while the
// three-character percentage still needs enough colour to read as a status.
// Hue and lightness are preserved, so only the vividness changes.
const FILL_SATURATION = 0.4
const TEXT_SATURATION = 0.7
// The header badge is a brand element, not a status colour. A medium steel
// blue with white ink keeps the classic blue-chip look without the weight of
// black, on both light and dark themes.
const BADGE_BG = "#4678ac"
const BADGE_INK = "#ffffff"

const FIVE_HOUR_MS = 5 * 3_600_000
const WEEK_MS = 7 * 86_400_000

type Meter = {
  startsAt?: string
  resetsAt?: string
  limitMicroCents?: string
  usedMicroCents?: string
}

type GoStatus = {
  product?: string
  access?: {
    startsAt?: string
    endsAt?: string
    meters?: { fiveHour?: Meter; week?: Meter; month?: Meter }
  }
}

type Snapshot =
  | { state: "loading" }
  | { state: "empty" }
  | { state: "inactive" }
  | { state: "error"; message: string }
  | { state: "ok"; status: GoStatus }

const MICRO_CENTS_PER_DOLLAR = 100_000_000

function dollars(microCents?: string | number | null): number {
  const n = Number(microCents ?? NaN)
  return Number.isFinite(n) ? n / MICRO_CENTS_PER_DOLLAR : NaN
}

function money(value: number): string {
  if (!Number.isFinite(value)) return "?"
  if (value === 0) return "$0"
  if (Number.isInteger(value)) return `$${value}`
  return `$${value.toFixed(2)}`
}

function usedPct(m?: Meter): number {
  const used = dollars(m?.usedMicroCents)
  const limit = dollars(m?.limitMicroCents)
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return NaN
  return (used / limit) * 100
}

function theoryPct(startMs: number, endMs: number, nowMs: number): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return NaN
  return ((nowMs - startMs) / (endMs - startMs)) * 100
}

// Time left in the window, hour precision: "3h 45m", "4d 16h", "22d 17h".
function until(endMs: number, nowMs: number): string {
  if (!Number.isFinite(endMs)) return ""
  const ms = endMs - nowMs
  if (ms <= 0) return "now"
  const minutes = Math.floor(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function rgb(color: any): [number, number, number] | null {
  if (typeof color === "string") {
    const match = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i)
    if (!match) return null
    let hex = match[1]
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("")
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ]
  }
  if (color && typeof color === "object") {
    if (typeof color.rgba === "string") return rgb(color.rgba)
    if ([color.r, color.g, color.b].every((n) => typeof n === "number")) {
      const scale = color.r <= 1 && color.g <= 1 && color.b <= 1 ? 255 : 1
      return [Math.round(color.r * scale), Math.round(color.g * scale), Math.round(color.b * scale)]
    }
  }
  return null
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("")}`
}

/**
 * Scale a colour's HSL saturation by `keep`, leaving hue and lightness alone.
 * The theme's feedback tokens are picked for short text at full strength; the
 * meter needs the same hue with less glare. Returns the input unchanged when it
 * is not a colour this plugin can parse.
 */
function desaturate(color: any, keep: number): any {
  const channels = rgb(color)
  if (!channels) return color
  const [r, g, b] = channels.map((n) => n / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const delta = max - min
  if (delta === 0) return color
  const s = delta / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === r) h = ((g - b) / delta) % 6
  else if (max === g) h = (b - r) / delta + 2
  else h = (r - g) / delta + 4
  h *= 60
  if (h < 0) h += 360

  const s2 = Math.max(0, Math.min(1, s * keep))
  const c = (1 - Math.abs(2 * l - 1)) * s2
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r2 = 0
  let g2 = 0
  let b2 = 0
  if (h < 60) [r2, g2, b2] = [c, x, 0]
  else if (h < 120) [r2, g2, b2] = [x, c, 0]
  else if (h < 180) [r2, g2, b2] = [0, c, x]
  else if (h < 240) [r2, g2, b2] = [0, x, c]
  else if (h < 300) [r2, g2, b2] = [x, 0, c]
  else [r2, g2, b2] = [c, 0, x]
  return toHex((r2 + m) * 255, (g2 + m) * 255, (b2 + m) * 255)
}

type Row = {
  label: string
  fill: number
  marker: number
  pct: number
  theory: number
  left: string
}

function buildRow(
  label: string,
  m: Meter | undefined,
  options: { fallbackStartISO?: string; durationMs?: number },
): Row {
  const nowMs = Date.now()
  const endMs = Date.parse(m?.resetsAt ?? "")

  // If a rolling/periodic window has already passed its reset timestamp while
  // the session was idle, treat usage as reset (0%) until the next request.
  if (Number.isFinite(endMs) && nowMs >= endMs) {
    return { label, fill: 0, marker: -1, pct: 0, theory: NaN, left: "—" }
  }

  let startMs = Date.parse(m?.startsAt ?? options.fallbackStartISO ?? "")
  if (!Number.isFinite(startMs) && Number.isFinite(endMs) && options.durationMs) {
    startMs = endMs - options.durationMs
  }

  const pct = usedPct(m)
  const theory = theoryPct(startMs, endMs, nowMs)
  return {
    label,
    fill: Number.isFinite(pct)
      ? pct > 0
        ? clamp(Math.round((pct / 100) * BAR_WIDTH), 1, BAR_WIDTH)
        : 0
      : 0,
    marker: Number.isFinite(theory)
      ? clamp(Math.round((theory / 100) * (BAR_WIDTH - 1)), 0, BAR_WIDTH - 1)
      : -1,
    pct,
    theory,
    left: until(endMs, nowMs),
  }
}

function quotaLevel(row: Row): 0 | 1 | 2 {
  if (!Number.isFinite(row.pct)) return 0
  return row.pct >= 90 ? 2 : row.pct >= 75 ? 1 : 0
}

function paceLevel(row: Row): 0 | 1 | 2 {
  if (!Number.isFinite(row.pct) || !Number.isFinite(row.theory)) return 0
  if (row.theory < PACE_START_THEORY_PCT && row.pct < PACE_START_USED_PCT) return 0
  if (row.pct > row.theory) return 2
  return row.theory - row.pct <= PACE_WARN_GAP_PCT ? 1 : 0
}

function barRuns(row: Row, fillColor: any, trackColor: any, markerColor: any) {
  const runs: Array<{ text: string; color: any }> = []
  // Avoid hiding the single filled cell when both fill and marker land on cell 0.
  const effectiveMarker = row.fill === 1 && row.marker === 0 ? 1 : row.marker
  for (let i = 0; i < BAR_WIDTH; i++) {
    const marker = i === effectiveMarker
    const filled = i < row.fill
    const ch = marker ? "┃" : filled ? "█" : "░"
    const color = marker ? markerColor : filled ? fillColor : trackColor
    const last = runs[runs.length - 1]
    if (last && last.color === color) last.text += ch
    else runs.push({ text: ch, color })
  }
  return runs
}

function palette(theme: any) {
  return {
    muted: theme?.text?.muted ?? "#808080",
    strong: theme?.text?.base ?? "#eeeeee",
    success: theme?.text?.feedback?.success?.base ?? "#4e9a63",
    warning: theme?.text?.feedback?.warning?.base ?? "#f5a742",
    error: theme?.text?.feedback?.error?.base ?? "#e06c75",
  }
}

export default Plugin.define({
  id: "go-usage",
  setup(context) {
    async function readAuth(): Promise<{ access: string; orgID: string } | null> {
      try {
        const client: any = context.client
        const result: any = await client.credential.list()
        const list: any[] = Array.isArray(result) ? result : (result?.data ?? [])
        const entry = list.find((c) => c?.integrationID === "opencode" && c?.active !== false)
        const raw = entry?.value
        const value = typeof raw === "string" ? JSON.parse(raw) : raw
        const access = value?.access
        const orgID = value?.metadata?.orgID
        if (!access || !orgID) return null
        return { access: String(access), orgID: String(orgID) }
      } catch {
        return null
      }
    }

    const [snapshot, setSnapshot] = createSignal<Snapshot>({ state: "loading" })
    let inFlight: Promise<void> | null = null

    async function doRefresh(): Promise<void> {
      const auth = await readAuth()
      if (!auth) {
        setSnapshot({ state: "empty" })
        return
      }
      try {
        const res = await fetch(GO_STATUS_URL, {
          headers: {
            Authorization: `Bearer ${auth.access}`,
            "x-org-id": auth.orgID,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        if (res.status === 404) {
          setSnapshot({ state: "inactive" })
          return
        }
        if (res.status === 401 || res.status === 403) {
          setSnapshot({ state: "error", message: "console rejected the credential (run /connect)" })
          return
        }
        if (!res.ok) {
          if (snapshot().state !== "ok") {
            setSnapshot({ state: "error", message: `console responded ${res.status}` })
          }
          return
        }
        setSnapshot({ state: "ok", status: (await res.json()) as GoStatus })
      } catch (e: any) {
        // Keep the last known good meters on transient network errors.
        if (snapshot().state !== "ok") {
          setSnapshot({ state: "error", message: String(e?.message ?? e) })
        }
      }
    }

    function refresh(): Promise<void> {
      if (!inFlight) {
        inFlight = doRefresh().finally(() => {
          inFlight = null
        })
      }
      return inFlight
    }

    void refresh()
    const timer = setInterval(() => void refresh(), REFRESH_MS)
    const stopEvent = context.data.on("session.execution.succeeded", () => {
      void refresh()
    })

    const stateLine = (s: Snapshot): string =>
      s.state === "loading"
        ? "loading…"
        : s.state === "empty"
          ? "/connect to link Console"
          : s.state === "inactive"
            ? "no active subscription"
            : s.message.includes("credential")
              ? "/connect to re-link"
              : "offline"

    const Meters = (props: { status: GoStatus }) => {
      const colors = palette(context.theme)
      const access = props.status.access
      const meters = access?.meters
      const rows = [
        buildRow("5h", meters?.fiveHour, { durationMs: FIVE_HOUR_MS }),
        buildRow("wk", meters?.week, { durationMs: WEEK_MS }),
        buildRow("mo", meters?.month, { fallbackStartISO: access?.startsAt }),
      ]
      const month = `${money(dollars(meters?.month?.usedMicroCents))}/${money(dollars(meters?.month?.limitMicroCents))}`
      return (
        <box width="100%" flexDirection="column" marginTop={1}>
          <box
            width="100%"
            flexDirection="row"
            justifyContent="space-between"
            alignItems="center"
            marginBottom={1}
          >
            <box paddingLeft={1} paddingRight={1} backgroundColor={BADGE_BG}>
              <text fg={BADGE_INK}>
                <b>Go Usage</b>
              </text>
            </box>
            <text fg={colors.muted}>{month}</text>
          </box>
          {rows.map((row) => {
            const quota = quotaLevel(row)
            const pace = paceLevel(row)
            const quotaTone = quota === 2 ? colors.error : quota === 1 ? colors.warning : colors.success
            const paceTone = pace === 2 ? colors.error : pace === 1 ? colors.warning : colors.success
            const barTone = desaturate(paceTone, FILL_SATURATION)
            const textTone = desaturate(quotaTone, TEXT_SATURATION)
            const pctText = Number.isFinite(row.pct) ? `${Math.round(row.pct)}%` : "—"
            return (
              <box flexDirection="row" height={1}>
                <text fg={colors.muted}>{row.label.padEnd(3)}</text>
                {barRuns(row, barTone, colors.muted, colors.strong).map((run) => (
                  <text fg={run.color}>{run.text}</text>
                ))}
                <text fg={textTone}>
                  {quota > 0 ? <b>{pctText.padStart(4)}</b> : pctText.padStart(4)}
                </text>
                <text fg={colors.muted}>{row.left.padStart(8)}</text>
              </box>
            )
          })}
        </box>
      )
    }

    const Usage = () => {
      const colors = palette(context.theme)
      return (
        <Show when={snapshot()} keyed>
          {(s: Snapshot) =>
            s.state === "ok" ? (
              <Meters status={s.status} />
            ) : (
              <box width="100%" flexDirection="column" marginTop={1}>
                <box width="100%" flexDirection="row" marginBottom={1}>
                  <box paddingLeft={1} paddingRight={1} backgroundColor={BADGE_BG}>
                    <text fg={BADGE_INK}>
                      <b>Go Usage</b>
                    </text>
                  </box>
                </box>
                <text fg={colors.muted}>{stateLine(s)}</text>
              </box>
            )
          }
        </Show>
      )
    }

    const stopSlot = context.ui.slot({
      append: "sidebar.content",
      render: () => <Usage />,
    })

    return () => {
      clearInterval(timer)
      stopEvent?.()
      stopSlot?.()
    }
  },
})
