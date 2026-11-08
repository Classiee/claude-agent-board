import type { AgentCard, Board, LogTone } from '../types'

// A dark terminal-window board: Sonnet main session on top, delegation lines
// down to subagent cards, the Opus reviewer column on the left, a session log,
// the prompt and a status line. Animated with SMIL (drawn isInteractive).

const W = 560
const H = 700
const FONT = "ui-monospace, 'SF Mono', 'Cascadia Mono', Consolas, Menlo, monospace"

const C = {
  bg: '#0e0f11',
  panel: '#141518',
  line: '#2a2c31',
  text: '#e7e7e9',
  dim: '#8b9099',
  faint: '#4a4e56',
  sonnet: '#e8833a',
  haiku: '#5b8def',
  opus: '#b49cf5',
  fable: '#4fc1b9',
  ok: '#5fc48a',
  bad: '#ef6b6b',
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function cut(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function modelColor(model: string): string {
  if (model.includes('haiku')) return C.haiku
  if (model.includes('opus')) return C.opus
  if (model.includes('fable')) return C.fable
  return C.sonnet
}

function whoColor(who: string, tone: LogTone): string {
  if (who === 'gate') return tone === 'bad' ? C.bad : C.ok
  if (who === 'sonnet') return C.sonnet
  if (who === 'opus' || who === 'skeptic') return C.opus
  if (who === 'haiku' || who === 'test-runner' || who === 'Explore') return C.haiku
  return C.dim
}

function t(x: number, y: number, s: string, o: { fill?: string; size?: number; weight?: number; anchor?: string; spacing?: number } = {}): string {
  return `<text x="${x}" y="${y}" fill="${o.fill ?? C.text}" font-size="${o.size ?? 11}" font-weight="${o.weight ?? 400}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.spacing ? ` letter-spacing="${o.spacing}"` : ''}>${esc(s)}</text>`
}

function rect(x: number, y: number, w: number, h: number, stroke = C.line, fill = C.panel, extra = ''): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="${fill}" stroke="${stroke}" stroke-width="1"${extra}/>`
}

// Every redraw replaces the whole SVG, which would restart each animation
// from frame 0. Starting each one at the phase the wall clock says it should
// be at makes a redraw invisible: the motion carries on where it was.
let clockMs = 0
function sync(dur: number): string {
  const into = ((clockMs / 1000) % dur + dur) % dur
  return ` begin="-${into.toFixed(3)}s"`
}

/** A connector; `flow` makes its dashes march (SMIL). */
function path(d: string, color: string, flow: boolean, dashed = true): string {
  const dash = dashed ? ' stroke-dasharray="4 4"' : ''
  const anim = flow
    ? `<animate attributeName="stroke-dashoffset" from="16" to="0" dur="0.8s"${sync(0.8)} repeatCount="indefinite"/>`
    : ''
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.4"${dash}>${anim}</path>`
}

function dot(x: number, y: number, color: string, pulse: boolean): string {
  const anim = pulse ? `<animate attributeName="r" values="3;5;3" dur="1.2s"${sync(1.2)} repeatCount="indefinite"/>` : ''
  return `<circle cx="${x}" cy="${y}" r="3.5" fill="${color}">${anim}</circle>`
}

export type View = {
  now: number
  mainState: string
  opusState: 'asleep' | 'advising' | 'reviewing'
  activeTab: 'sonnet' | 'haiku' | 'opus' | 'none'
  /** The main session's model family: sonnet, opus, haiku, fable. */
  mainFamily: string
  running: AgentCard[]
  shown: AgentCard[]
}

export function view(b: Board, now: number): View {
  const running = b.agents.filter(a => a.status === 'running')
  const finished = b.agents.filter(a => a.status !== 'running').reverse()
  const shown = [...running, ...finished].slice(0, 3)
  const skepticRunning = running.some(a => a.type === 'skeptic')
  const advising = b.advisorLastAt !== undefined && b.advisorLastAt >= b.mainTurnAt && b.mainStatus !== 'idle'
  const opusState = skepticRunning ? 'reviewing' : advising ? 'advising' : 'asleep'
  const mainState = running.length > 0 ? 'delegating' : b.mainStatus
  const mainFamily = familyOf(b.mainModel)
  const mainTab = mainFamily === 'sonnet' || mainFamily === 'opus' || mainFamily === 'haiku' ? mainFamily : 'none'
  const activeTab =
    opusState !== 'asleep' ? 'opus' : running.some(a => a.model.includes('haiku')) ? 'haiku' : mainTab
  return { now, mainState, opusState, activeTab, mainFamily, running, shown }
}

export function boardSvg(b: Board, now: number): string {
  clockMs = now
  const v = view(b, now)
  const t0 = b.startedAt || now
  const out: string[] = []
  const add = (s: string) => out.push(s)

  // window + chrome
  add(`<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${C.bg}" stroke="${C.line}"/>`)
  for (const [i, x] of [16, 28, 40].entries()) add(`<circle cx="${x}" cy="14" r="3.5" fill="${['#ff5f57', '#febc2e', '#28c840'][i]}" opacity="0.55"/>`)
  add(t(W / 2, 18, '~/repo · claude code', { fill: C.dim, size: 10, anchor: 'middle' }))
  add(`<line x1="0" y1="28" x2="${W}" y2="28" stroke="${C.line}"/>`)

  // header + model tabs
  add(t(16, 50, 'CLAUDE CODE · 3 MODELS', { size: 13, weight: 700, spacing: 1.2 }))
  const tabs: Array<[View['activeTab'], string, string, string]> = [
    ['sonnet', 'SONNET 5.5', 'builds', C.sonnet],
    ['haiku', 'HAIKU 5.5', 'checks', C.haiku],
    ['opus', 'OPUS 5.5', 'reviews', C.opus],
  ]
  tabs.forEach(([id, name, role, color], i) => {
    const x = 16 + i * 178
    const on = v.activeTab === id
    add(rect(x, 60, 170, 20, on ? color : C.line, on ? '#16192099' : C.panel))
    add(`<text x="${x + 8}" y="74" font-size="10"><tspan fill="${on ? color : C.text}" font-weight="700">${name}</tspan><tspan fill="${C.dim}"> ${role}</tspan></text>`)
  })

  // ── Opus reviewer column ─────────────────────────────────────
  const ox = 16
  const ow = 154
  add(rect(ox, 92, ow, 352))
  add(t(ox + 12, 112, 'OPUS 5.5', { weight: 700, size: 12 }))
  add(t(ox + 12, 127, 'reviewer · on call', { fill: C.dim, size: 10 }))
  add(t(ox + 12, 156, v.opusState, { fill: v.opusState === 'asleep' ? C.faint : C.opus, size: 18, weight: 600 }))

  const checkpoints: Array<[string, string, boolean, boolean]> = [
    ['advisor', 'key decisions', b.advisorCalls > 0, v.opusState === 'advising'],
    ['skeptic', 'breaks each diff', b.agents.some(a => a.type === 'skeptic'), v.opusState === 'reviewing'],
    ['gate', 'no verdict, no commit', b.commit !== undefined, false],
  ]
  add(`<line x1="${ox + 16}" y1="180" x2="${ox + 16}" y2="276" stroke="${C.faint}"/>`)
  checkpoints.forEach(([name, note, lit, live], i) => {
    const y = 180 + i * 48
    add(`<circle cx="${ox + 16}" cy="${y}" r="5" fill="${lit ? C.opus : C.bg}" stroke="${lit ? C.opus : C.dim}">${live ? `<animate attributeName="r" values="5;7;5" dur="1.2s"${sync(1.2)} repeatCount="indefinite"/>` : ''}</circle>`)
    add(t(ox + 28, y + 4, name, { size: 11, weight: 600, fill: lit ? C.text : C.dim }))
    add(t(ox + 28, y + 18, note, { size: 9, fill: C.dim }))
    // reviewer → main session wiring
    add(path(`M${ox + 100 + i * 8} ${y} H${ox + ow + 6 + i * 5} V${112 + i * 16} H190`, live ? C.opus : C.faint, live))
  })
  add(`<line x1="${ox + 12}" y1="318" x2="${ox + 12}" y2="334" stroke="${C.dim}"/>`)
  add(t(ox + 20, 330, 'wakes only when it matters', { size: 9, fill: C.dim }))
  add(`<line x1="${ox}" y1="346" x2="${ox + ow}" y2="346" stroke="${C.line}"/>`)
  add(t(ox + 12, 364, 'calls', { size: 10, fill: C.dim }))
  add(t(ox + 12, 398, String(b.advisorCalls), { size: 30, weight: 300, fill: b.advisorCalls ? C.text : C.faint }))
  add(t(ox + 12, 418, 'last verdict', { size: 10, fill: C.dim }))
  const vColor = !b.verdict ? C.faint : b.verdict.status === 'APPROVED' ? C.ok : C.bad
  add(t(ox + 12, 434, b.verdict ? b.verdict.status.toLowerCase() : '—', { size: 12, weight: 600, fill: vColor }))

  // ── Sonnet main session ──────────────────────────────────────
  const sx = 190
  const sw = 354
  const active = v.mainState !== 'idle'
  add(rect(sx, 92, sw, 70, active ? '#3a2a1e' : C.line))
  add(t(sx + 14, 112, `${shortName(b.mainModel || 'claude-sonnet-5-5')} · main session`, { weight: 700, size: 12 }))
  add(t(sx + 14, 128, 'writes the code', { fill: C.dim, size: 10 }))
  add(t(sx + 14, 150, `--model ${v.mainFamily} --advisor opus`, { fill: C.dim, size: 10 }))
  add(t(sx + sw - 14, 152, cut(v.mainState, 16), { fill: active ? modelColor(v.mainFamily) : C.faint, size: 16, weight: 600, anchor: 'end' }))

  // ── delegation lines + subagent cards ────────────────────────
  const cw = 112
  const gap = 9
  const cy = 214
  const cx = (i: number) => sx + i * (cw + gap)
  const mid = (i: number) => cx(i) + cw / 2
  const anyRunning = v.running.length > 0
  const trunk = anyRunning ? C.sonnet : C.faint
  const firstModel = v.running[0]?.model ?? v.shown[0]?.model
  add(path(`M${sx + sw / 2} 162 V190`, trunk, anyRunning))
  add(t(sx + sw / 2 + 8, 182, firstModel ? `delegate → ${firstModel}` : 'delegate → subagents', { size: 10, fill: anyRunning ? C.text : C.dim }))
  const slots = Math.max(1, v.shown.length)
  if (slots > 1) add(path(`M${mid(0)} 190 H${mid(slots - 1)}`, trunk, anyRunning))

  if (v.shown.length === 0) {
    add(path(`M${mid(0)} 190 V${cy}`, C.faint, false))
    add(rect(cx(0), cy, cw * 3 + gap * 2, 92, C.line, C.panel, ' stroke-dasharray="4 4"'))
    add(t(sx + sw / 2, cy + 50, 'no subagents yet', { fill: C.faint, size: 12, anchor: 'middle' }))
  }

  v.shown.forEach((a, i) => {
    const x = cx(i)
    const run = a.status === 'running'
    const mc = modelColor(a.model)
    const sc = run ? C.sonnet : a.status === 'done' ? C.ok : C.bad
    add(path(`M${mid(i)} 190 V${cy}`, run ? C.sonnet : C.faint, run))
    add(dot(mid(i), 190, run ? C.sonnet : C.faint, run))
    add(rect(x, cy, cw, 92, run ? mc : C.line))
    add(t(x + 10, cy + 18, cut(a.type, 13), { weight: 700, size: 12 }))
    add(t(x + 10, cy + 32, a.model, { fill: mc, size: 10 }))
    add(t(x + 10, cy + 46, cut(a.task, 17), { fill: C.dim, size: 9 }))
    // bar: indeterminate sweep while running, full when finished
    add(`<rect x="${x + 10}" y="${cy + 54}" width="${cw - 20}" height="4" rx="2" fill="${C.line}"/>`)
    if (run) {
      add(`<rect x="${x + 10}" y="${cy + 54}" width="30" height="4" rx="2" fill="${mc}"><animate attributeName="x" values="${x + 10};${x + cw - 40};${x + 10}" dur="1.6s"${sync(1.6)} repeatCount="indefinite"/></rect>`)
    } else {
      add(`<rect x="${x + 10}" y="${cy + 54}" width="${cw - 20}" height="4" rx="2" fill="${sc}" opacity="0.8"/>`)
    }
    // the count is written when the agent finishes; while it runs, the motion is the signal
    if (run) {
      add(t(x + 10, cy + 80, 'working…', { size: 11, fill: C.dim }))
    } else {
      add(t(x + 10, cy + 82, String(a.tools), { size: 18, weight: 300 }))
      add(t(x + 10 + String(a.tools).length * 11 + 4, cy + 82, 'tools', { size: 9, fill: C.dim }))
    }
    const when = a.endedAt ? clock(a.endedAt - a.startedAt) : a.status
    add(t(x + cw - 10, cy + 72, a.status, { size: 10, fill: sc, anchor: 'end' }))
    add(t(x + cw - 10, cy + 84, a.endedAt ? when : clock(now - a.startedAt), { size: 9, fill: C.dim, anchor: 'end' }))
    add(path(`M${mid(i)} ${cy + 92} V332`, run ? C.faint : a.status === 'done' ? C.ok : C.bad, false))
  })
  const extra = v.running.length - v.shown.filter(a => a.status === 'running').length
  if (extra > 0) add(t(sx + sw, cy - 4, `+${extra} more running`, { size: 9, fill: C.dim, anchor: 'end' }))

  // back to sonnet
  const last = b.agents.filter(a => a.status !== 'running').at(-1)
  add(rect(sx, 332, sw, 48))
  add(t(sx + 14, 351, `back to ${shortName(b.mainModel || 'claude-sonnet-5-5').toLowerCase()}`, { weight: 700, size: 12 }))
  add(t(sx + 14, 368, last ? cut(`${last.type} ${last.status} in ${clock((last.endedAt ?? now) - last.startedAt)}`, 34) : 'results land here', { size: 10, fill: C.dim }))
  add(t(sx + sw - 14, 360, anyRunning ? 'waiting' : last ? 'received' : '—', { size: 11, fill: anyRunning ? C.sonnet : C.dim, anchor: 'end' }))

  // haiku shell check
  add(rect(sx, 392, sw, 52))
  add(t(sx + 14, 411, 'HAIKU 5.5 · shell check', { weight: 700, size: 11, fill: C.haiku }))
  add(t(sx + 14, 430, `${b.shell.checked} checked · ${b.shell.blocked} blocked`, { size: 11, fill: C.text }))
  add(t(sx + sw - 14, 430, 'every bash call', { size: 9, fill: C.dim, anchor: 'end' }))

  // session log
  add(rect(16, 458, W - 32, 152))
  add(t(28, 477, 'SESSION LOG', { size: 10, fill: C.dim, spacing: 1.5 }))
  const rows = b.log.slice(-6)
  if (rows.length === 0) add(t(28, 500, 'nothing yet', { size: 10, fill: C.faint }))
  rows.forEach((l, i) => {
    const y = 497 + i * 18
    const newest = i === rows.length - 1
    add(t(28, y, clock(l.at - t0), { size: newest ? 11 : 10, fill: newest ? C.text : C.dim, weight: newest ? 600 : 400 }))
    add(t(84, y, cut(l.who, 11), { size: 10, fill: whoColor(l.who, l.tone) }))
    const tc = l.tone === 'bad' ? C.bad : newest ? C.text : C.dim
    add(t(176, y, cut(l.text, 50), { size: newest ? 11 : 10, fill: tc, weight: newest ? 600 : 400 }))
  })

  // prompt + status line
  const prompt = ` claude --model ${v.mainFamily} --advisor opus`
  add(`<text x="16" y="640" font-size="12"><tspan fill="${C.sonnet}">&gt;</tspan><tspan fill="${C.text}">${esc(prompt)}</tspan></text>`)
  add(`<rect x="${Math.round(16 + 7.05 * (prompt.length + 1) + 8)}" y="630" width="7" height="13" fill="${C.text}"><animate attributeName="opacity" values="1;1;0;0" dur="1.1s"${sync(1.1)} repeatCount="indefinite"/></rect>`)
  add(`<line x1="0" y1="660" x2="${W}" y2="660" stroke="${C.line}"/>`)
  const gate = b.verdict ? b.verdict.status.toLowerCase() : '—'
  add(
    `<text x="16" y="684" font-size="10">` +
      `<tspan fill="${C.haiku}">subagents</tspan><tspan fill="${C.text}"> [${v.running.length}/${b.agents.length}]</tspan>` +
      `<tspan fill="${C.dim}">  ·  </tspan><tspan fill="${C.opus}">opus</tspan><tspan fill="${C.text}"> [${v.opusState}]</tspan>` +
      `<tspan fill="${C.dim}">  ·  </tspan><tspan fill="${C.text}">shell [${b.shell.checked}/${b.shell.blocked}✗]</tspan>` +
      `<tspan fill="${C.dim}">  ·  </tspan><tspan fill="${C.text}">gate [${esc(gate)}]</tspan>` +
      `</text>`,
  )

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">${out.join('')}</svg>`
}

/** claude-opus-5-5 / opus 5.5 -> "opus"; unknown -> "sonnet" (the configured default). */
export function familyOf(model: string): string {
  const m = /(sonnet|opus|haiku|fable)/i.exec(model)
  return m?.[1] ? m[1].toLowerCase() : 'sonnet'
}

function shortName(model: string): string {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model)
  if (!m) return model.toUpperCase()
  return `${(m[1] ?? '').toUpperCase()} ${m[2]}${m[3] ? '.' + m[3] : ''}`
}

export function boardAlt(b: Board, now: number): string {
  const v = view(b, now)
  const agents = v.shown.map(a => `${a.type} (${a.model}) ${a.status}`).join(', ') || 'no subagents'
  return `Agent board: main session ${v.mainState}; Opus ${v.opusState}, ${b.advisorCalls} advisor calls; subagents: ${agents}; last verdict ${b.verdict?.status ?? 'none'}; shell ${b.shell.checked} checked, ${b.shell.blocked} blocked.`
}
