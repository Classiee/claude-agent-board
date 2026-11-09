import type { AgentCard, Board, LogEntry } from '../types'
import { modelFamily, modelLabel } from './models'

// A dark terminal-window board: the main session on top, delegation lines
// down to subagent cards, the advisor column on the left, a session log and a
// status line. Animated with SMIL (drawn isInteractive).
//
// Nothing here assumes which models the user runs. Every model name comes from
// the board's data; a model this does not know is drawn with its own id and a
// neutral colour, and a model nobody has reported is drawn as "unknown".

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
  other: '#a7adb8',
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

export function cut(s: string, n: number): string {
  if (s.length <= n) return s
  let head = s.slice(0, Math.max(0, n - 1))
  if (/[\ud800-\udbff]$/.test(head)) head = head.slice(0, -1) // do not split a surrogate pair
  return head + '…'
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** A colour per known model family; any other model gets a neutral one. */
export function familyColor(family: string | undefined): string {
  if (family === 'haiku') return C.haiku
  if (family === 'opus') return C.opus
  if (family === 'fable') return C.fable
  if (family === 'sonnet') return C.sonnet
  return C.other
}

function logColor(l: LogEntry): string {
  if (l.who === 'commit') return l.tone === 'bad' ? C.bad : C.ok
  return l.family ? familyColor(l.family) : C.dim
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
  /** The advisor: consulted during the current turn, or not. */
  advisorState: 'asleep' | 'advising'
  /** Whether a reviewer subagent is running. That is a subagent, not the advisor. */
  reviewing: boolean
  running: AgentCard[]
  shown: AgentCard[]
}

export function view(b: Board, now: number): View {
  const running = b.agents.filter(a => a.status === 'running')
  const finished = b.agents.filter(a => a.status !== 'running').reverse()
  const shown = [...running, ...finished].slice(0, 3)
  const reviewing = running.some(a => a.reviewer)
  const advising = b.advisorLastAt !== undefined && b.advisorLastAt >= b.mainTurnAt && b.mainStatus !== 'idle'
  const advisorState = advising ? 'advising' : 'asleep'
  const mainState = running.length > 0 ? 'delegating' : b.mainStatus
  return { now, mainState, advisorState, reviewing, running, shown }
}

/** The model labels the board shows, from its data alone. */
export function names(b: Board) {
  const main = b.mainModel ? modelLabel(b.mainModel) : 'unknown'
  const advisor = b.advisorModel ? modelLabel(b.advisorModel) : b.advisorCalls > 0 ? 'model not stated' : 'none found'
  const shell = b.shellCheck ? (b.shellCheck.model ? modelLabel(b.shellCheck.model) : 'model not stated') : 'none found'
  const mainNote =
    !b.mainModel ? 'no model seen yet' : b.mainSource === 'observed' ? 'observed in the last response' : 'configured, not yet observed'
  // A model that was only asked for (a setting, /model, a step's request) is marked "(cfg)"
  // wherever it is named, as the advisor and shell check always are: the board never sees those answer.
  const mainConfigured = b.mainModel !== '' && b.mainSource === 'configured'
  const mainChip = mainConfigured ? `${cut(main, 12)} (cfg)` : main
  const backTo = b.mainModel ? cut(main, 22) + (mainConfigured ? ' (cfg)' : '') : 'main session'
  const advisorChip = b.advisorModel ? `${cut(advisor, 12)} (cfg)` : advisor
  const shellChip = b.shellCheck?.model ? `${cut(shell, 12)} (cfg)` : shell
  // the same model, worded for text: the board has only read these from settings
  const advisorText = b.advisorModel ? `${advisor} (configured)` : advisor
  const shellText = b.shellCheck?.model ? `${shell} (configured)` : shell
  return {
    main,
    advisor,
    shell,
    mainChip,
    backTo,
    advisorChip,
    shellChip,
    advisorText,
    shellText,
    mainNote,
    mainColor: familyColor(modelFamily(b.mainModel)),
    advisorColor: familyColor(modelFamily(b.advisorModel)),
    reviewerColor: familyColor(modelFamily(b.agents.filter(a => a.reviewer).at(-1)?.model)),
    shellColor: familyColor(modelFamily(b.shellCheck?.model)),
  }
}

/**
 * A subagent's model as drawn; "(cfg)" marks one that was asked for but has not
 * yet been seen answering. With `max`, the model is cut to fit and the marker stays.
 */
export function agentModel(a: AgentCard, max?: number): string {
  const label = modelLabel(a.model)
  return (max === undefined ? label : cut(label, max)) + (a.modelSource === 'configured' && a.model ? ' (cfg)' : '')
}

export function boardSvg(b: Board, now: number): string {
  clockMs = now
  const v = view(b, now)
  const n = names(b)
  const t0 = b.startedAt || now
  const out: string[] = []
  const add = (s: string) => out.push(s)

  // window + chrome
  add(`<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${C.bg}" stroke="${C.line}"/>`)
  for (const [i, x] of [16, 28, 40].entries()) add(`<circle cx="${x}" cy="14" r="3.5" fill="${['#ff5f57', '#febc2e', '#28c840'][i]}" opacity="0.55"/>`)
  add(t(W / 2, 18, 'claude code · agent board', { fill: C.dim, size: 10, anchor: 'middle' }))
  add(`<line x1="0" y1="28" x2="${W}" y2="28" stroke="${C.line}"/>`)

  // header + role chips: which model is in which role, as far as it is known
  add(t(16, 50, 'CLAUDE CODE · AGENT BOARD', { size: 13, weight: 700, spacing: 1.2 }))
  const chips: Array<[string, string, string, boolean]> = [
    ['MAIN', n.mainChip, n.mainColor, v.mainState !== 'idle'],
    ['ADVISOR', n.advisorChip, n.advisorColor, v.advisorState === 'advising'],
    ['SHELL', n.shellChip, n.shellColor, false],
  ]
  chips.forEach(([role, label, color, on], i) => {
    const x = 16 + i * 178
    add(rect(x, 60, 170, 20, on ? color : C.line, on ? '#16192099' : C.panel))
    add(`<text x="${x + 8}" y="74" font-size="10"><tspan fill="${on ? color : C.text}" font-weight="700">${esc(role)}</tspan><tspan fill="${C.dim}"> ${esc(cut(label, 18))}</tspan></text>`)
  })

  // ── advisor / reviewer column ────────────────────────────────
  const ox = 16
  const ow = 154
  add(rect(ox, 92, ow, 352))
  add(t(ox + 12, 112, 'ADVISOR', { weight: 700, size: 12 }))
  add(t(ox + 12, 126, n.advisorChip, { fill: C.dim, size: 10 }))
  if (b.advisorModel) add(t(ox + 12, 140, 'runtime model unobserved', { fill: C.faint, size: 9 }))
  add(t(ox + 12, 170, v.advisorState, { fill: v.advisorState === 'asleep' ? C.faint : n.advisorColor, size: 16, weight: 600 }))

  // each checkpoint has its own colour: the advisor's model, the reviewer subagent's model, neutral
  const checkpoints: Array<[string, string, boolean, boolean, string]> = [
    ['advisor', 'consultations', b.advisorCalls > 0, v.advisorState === 'advising', n.advisorColor],
    ['reviewer', 'reports a verdict', b.agents.some(a => a.reviewer), v.reviewing, n.reviewerColor],
    ['commits', 'commit calls seen', b.commit !== undefined, false, C.other],
  ]
  add(`<line x1="${ox + 16}" y1="180" x2="${ox + 16}" y2="276" stroke="${C.faint}"/>`)
  checkpoints.forEach(([name, note, lit, live, color], i) => {
    const y = 180 + i * 48
    add(`<circle cx="${ox + 16}" cy="${y}" r="5" fill="${lit ? color : C.bg}" stroke="${lit ? color : C.dim}">${live ? `<animate attributeName="r" values="5;7;5" dur="1.2s"${sync(1.2)} repeatCount="indefinite"/>` : ''}</circle>`)
    add(t(ox + 28, y + 4, name, { size: 11, weight: 600, fill: lit ? C.text : C.dim }))
    add(t(ox + 28, y + 18, note, { size: 9, fill: C.dim }))
    // reviewer → main session wiring
    add(path(`M${ox + 100 + i * 8} ${y} H${ox + ow + 6 + i * 5} V${112 + i * 16} H190`, live ? color : C.faint, live))
  })
  add(`<line x1="${ox}" y1="346" x2="${ox + ow}" y2="346" stroke="${C.line}"/>`)
  add(t(ox + 12, 364, 'advisor calls', { size: 10, fill: C.dim }))
  add(t(ox + 12, 398, String(b.advisorCalls), { size: 30, weight: 300, fill: b.advisorCalls ? C.text : C.faint }))
  add(t(ox + 12, 418, 'last verdict reported', { size: 10, fill: C.dim }))
  const vColor = !b.verdict ? C.faint : b.verdict.status === 'APPROVED' ? C.ok : C.bad
  add(t(ox + 12, 434, b.verdict ? b.verdict.status.toLowerCase() : '—', { size: 12, weight: 600, fill: vColor }))

  // ── main session ─────────────────────────────────────────────
  const sx = 190
  const sw = 354
  const active = v.mainState !== 'idle'
  const acc = n.mainColor
  add(rect(sx, 92, sw, 70, active ? '#2a2a30' : C.line))
  add(t(sx + 14, 112, `${b.mainModel ? cut(n.main, 30) : 'unknown model'} · main session`, { weight: 700, size: 12 }))
  add(t(sx + 14, 128, n.mainNote, { fill: C.dim, size: 10 }))
  add(t(sx + 14, 150, b.mainModel ? cut(b.mainModel, 34) : '', { fill: C.faint, size: 10 }))
  add(t(sx + sw - 14, 152, cut(v.mainState, 16), { fill: active ? acc : C.faint, size: 16, weight: 600, anchor: 'end' }))

  // ── delegation lines + subagent cards ────────────────────────
  const cw = 112
  const gap = 9
  const cy = 214
  const cx = (i: number) => sx + i * (cw + gap)
  const mid = (i: number) => cx(i) + cw / 2
  const anyRunning = v.running.length > 0
  const trunk = anyRunning ? acc : C.faint
  const first = v.running[0] ?? v.shown[0]
  add(path(`M${sx + sw / 2} 162 V190`, trunk, anyRunning))
  add(t(sx + sw / 2 + 8, 182, first ? `delegate → ${agentModel(first, first.modelSource === 'configured' ? 10 : 16)}` : 'delegate → subagents', { size: 10, fill: anyRunning ? C.text : C.dim }))
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
    const mc = familyColor(modelFamily(a.model))
    const sc = run ? acc : a.status === 'done' ? C.ok : C.bad
    add(path(`M${mid(i)} 190 V${cy}`, run ? acc : C.faint, run))
    add(dot(mid(i), 190, run ? acc : C.faint, run))
    add(rect(x, cy, cw, 92, run ? mc : C.line))
    add(t(x + 10, cy + 18, cut(a.type || 'agent', 13), { weight: 700, size: 12 }))
    add(t(x + 10, cy + 32, agentModel(a, 10), { fill: mc, size: 10 }))
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
      add(t(x + 10, cy + 80, 'working…', { size: 10, fill: C.dim }))
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

  // back to the main session
  const last = b.agents.filter(a => a.status !== 'running').at(-1)
  add(rect(sx, 332, sw, 48))
  add(t(sx + 14, 351, `back to ${n.backTo}`, { weight: 700, size: 12 }))
  add(t(sx + 14, 368, last ? cut(`${last.type} ${last.status} in ${clock((last.endedAt ?? now) - last.startedAt)}`, 34) : 'results land here', { size: 10, fill: C.dim }))
  add(t(sx + sw - 14, 360, anyRunning ? 'waiting' : last ? 'received' : '—', { size: 11, fill: anyRunning ? acc : C.dim, anchor: 'end' }))

  // shell calls: how many the board saw, and whether a model-backed check is configured
  add(rect(sx, 392, sw, 52))
  // The refusal count is every PreToolUse refusal, whichever hook made it: it is drawn on its
  // own line, apart from the configured model check named below it.
  add(t(sx + 14, 411, cut(`SHELL CALLS · ${b.shell.seen} seen · ${b.shell.blocked} blocked by a hook`, 50), { weight: 700, size: 11 }))
  const checkLine = b.shellCheck ? `model check: ${cut(n.shell, 16)}${b.shellCheck.model ? ' (configured)' : ''}` : 'no model check found'
  add(t(sx + 14, 430, checkLine, { size: 11, fill: b.shellCheck ? n.shellColor : C.dim }))

  // session log
  add(rect(16, 458, W - 32, 152))
  add(t(28, 477, 'SESSION LOG', { size: 10, fill: C.dim, spacing: 1.5 }))
  const rows = b.log.slice(-6)
  if (rows.length === 0) add(t(28, 500, 'nothing yet', { size: 10, fill: C.faint }))
  rows.forEach((l, i) => {
    const y = 497 + i * 18
    const newest = i === rows.length - 1
    add(t(28, y, clock(l.at - t0), { size: newest ? 11 : 10, fill: newest ? C.text : C.dim, weight: newest ? 600 : 400 }))
    add(t(84, y, cut(l.who, 11), { size: 10, fill: logColor(l) }))
    const tc = l.tone === 'bad' ? C.bad : newest ? C.text : C.dim
    add(t(176, y, cut(l.text, 50), { size: newest ? 11 : 10, fill: tc, weight: newest ? 600 : 400 }))
  })

  // prompt + status line
  const prompt = ' /agent-board'
  add(`<text x="16" y="640" font-size="12"><tspan fill="${acc}">&gt;</tspan><tspan fill="${C.text}">${esc(prompt)}</tspan></text>`)
  add(`<rect x="${Math.round(16 + 7.05 * (prompt.length + 1) + 8)}" y="630" width="7" height="13" fill="${C.text}"><animate attributeName="opacity" values="1;1;0;0" dur="1.1s"${sync(1.1)} repeatCount="indefinite"/></rect>`)
  add(`<line x1="0" y1="660" x2="${W}" y2="660" stroke="${C.line}"/>`)
  const verdict = b.verdict ? b.verdict.status.toLowerCase() : '—'
  // two rows: one row would run past the board once the review and verdict segments are in
  add(
    `<text x="16" y="676" font-size="10">` +
      `<tspan fill="${acc}">subagents</tspan><tspan fill="${C.text}"> [${v.running.length}/${b.agents.length}]</tspan>` +
      `<tspan fill="${C.dim}">  ·  </tspan><tspan fill="${n.advisorColor}">advisor</tspan><tspan fill="${C.text}"> [${v.advisorState}]</tspan>` +
      `<tspan fill="${C.dim}">  ·  </tspan><tspan fill="${n.reviewerColor}">review</tspan><tspan fill="${C.text}"> [${v.reviewing ? 'reviewing' : 'idle'}]</tspan>` +
      `</text>`,
  )
  add(
    `<text x="16" y="691" font-size="10">` +
      `<tspan fill="${C.text}">shell [${b.shell.seen}/${b.shell.blocked}✗]</tspan>` +
      `<tspan fill="${C.dim}">  ·  </tspan><tspan fill="${C.text}">reported [${esc(verdict)}]</tspan>` +
      `</text>`,
  )

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">${out.join('')}</svg>`
}

export function boardAlt(b: Board, now: number): string {
  const v = view(b, now)
  const n = names(b)
  const agents = v.shown.map(a => `${a.type || 'agent'} (${agentModel(a)}) ${a.status}`).join(', ') || 'no subagents'
  return `Agent board: main session ${v.mainState} on ${n.main} (${n.mainNote}); advisor ${n.advisorText}, ${v.advisorState}, ${b.advisorCalls} advisor calls; reviewer ${v.reviewing ? 'reviewing' : 'idle'}; subagents: ${agents}; last verdict reported ${b.verdict?.status ?? 'none'}; shell ${b.shell.seen} seen, ${b.shell.blocked} blocked by a hook.`
}
