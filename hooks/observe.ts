// What the board learns from events, as plain functions of the board: the
// model a response reports, the settings that name models, and a reviewer's
// verdict. No engine calls here, so each rule can be tested on its own.

import type { Board } from '../types'

export type Verdict = 'APPROVED' | 'REJECTED'

// the verdict is the whole line: nothing but markdown emphasis or a full stop may follow it
const VERDICT_LINE = /^[\s>*_`#-]*VERDICT\s*:[\s*_`]*(APPROVED|REJECTED)[*_`\s.]*$/i
// A verdict line is short; a longer last line is not one, and is not matched at all.
const MAX_VERDICT_LINE = 200

/**
 * The verdict a report ends with: its last non-empty line must be
 * `VERDICT: APPROVED` or `VERDICT: REJECTED`. Text that merely mentions a
 * verdict earlier in the report, or after a different verdict, is not one.
 */
export function finalVerdict(text: string): Verdict | undefined {
  const t = text.trimEnd()
  const last = t.slice(t.lastIndexOf('\n') + 1)
  if (last.length > MAX_VERDICT_LINE) return undefined
  const m = VERDICT_LINE.exec(last)
  if (!m) return undefined
  return (m[1] ?? '').toUpperCase() === 'REJECTED' ? 'REJECTED' : 'APPROVED'
}

/**
 * The verdict a tool call's input ends with: its text fields, whatever they
 * are called, each judged by `finalVerdict`; the last one that has a verdict.
 */
export function verdictOfInput(value: unknown, depth = 0): Verdict | undefined {
  if (typeof value === 'string') return finalVerdict(value)
  if (depth > 4 || value === null || typeof value !== 'object') return undefined
  let found: Verdict | undefined
  for (const v of Object.values(value)) {
    const r = verdictOfInput(v, depth + 1)
    if (r) found = r
  }
  return found
}

/** A main-loop response: the model it reports is observed; the model the step asked for is only configured. */
export function applyMainModel(b: Board, observed: string | undefined, requested: string): Board {
  if (observed) {
    return b.mainModel === observed && b.mainSource === 'observed' ? b : { ...b, mainModel: observed, mainSource: 'observed' }
  }
  if (b.mainModel || !requested) return b
  return { ...b, mainModel: requested, mainSource: 'configured' }
}

/** A subagent's response reported this model: that is what ran. */
export function applyAgentModel(b: Board, id: string, observed: string): Board {
  return {
    ...b,
    agents: b.agents.map(a =>
      a.id !== id || (a.model === observed && a.modelSource === 'observed') ? a : { ...a, model: observed, modelSource: 'observed' },
    ),
  }
}

export type Configured = {
  main?: string
  advisor?: string
  shell?: { model?: string }
  /** The settings could not be read this time: the advisor and shell check keep what they were. */
  settingsUnread?: boolean
}

/** The advisor and shell-check models the merged settings name. */
export function configuredFromSettings(settings: unknown): Pick<Configured, 'advisor' | 'shell'> {
  const s = (settings ?? {}) as Record<string, unknown>
  const out: Pick<Configured, 'advisor' | 'shell'> = {}
  if (typeof s.advisorModel === 'string' && s.advisorModel) out.advisor = s.advisorModel
  const pre = (s.hooks as Record<string, unknown> | undefined)?.PreToolUse
  if (Array.isArray(pre)) {
    let found: { model?: string } | undefined
    for (const entry of pre as Array<Record<string, unknown> | null>) {
      const matcher = typeof entry?.matcher === 'string' ? entry.matcher : ''
      if (!matchesShellTool(matcher) || !Array.isArray(entry?.hooks)) continue
      for (const h of entry.hooks as Array<Record<string, unknown> | null>) {
        if (h?.type !== 'prompt' && h?.type !== 'agent') continue
        if (typeof h.model === 'string' && h.model) {
          out.shell = { model: h.model }
          return out
        }
        found ??= {}
      }
    }
    if (found) out.shell = found
  }
  return out
}

const SHELL_TOOLS = ['Bash', 'PowerShell']

/**
 * Whether a hook matcher covers a shell tool. A matcher is read as text and never
 * compiled as a regular expression (one written to backtrack could freeze the host
 * on every event). Understood: empty or `*` (every tool), tool names, `A|B` lists,
 * and `.*` as a wildcard inside a name. Any other form is not evaluated: the hook
 * is then not counted as a shell check.
 */
function matchesShellTool(matcher: string): boolean {
  if (matcher === '' || matcher === '*') return true
  if (matcher.length > 200) return false
  return matcher.split('|').some(alt => /^\w*$/.test(alt.split('.*').join('')) && SHELL_TOOLS.some(name => globMatches(alt, name)))
}

/** `alt` with `.*` standing for any run of characters, against the whole of `name`. Linear. */
function globMatches(alt: string, name: string): boolean {
  const parts = alt.split('.*')
  const first = parts[0] ?? ''
  if (parts.length === 1) return alt === name
  if (!name.startsWith(first)) return false
  let pos = first.length
  for (const mid of parts.slice(1, -1)) {
    const at = name.indexOf(mid, pos)
    if (at < 0) return false
    pos = at + mid.length
  }
  const last = parts[parts.length - 1] ?? ''
  return name.length - last.length >= pos && name.endsWith(last)
}

/** What settings and `/model` name. The main model only fills a gap: an observed one is never replaced. */
export function applyConfigured(b: Board, c: Configured): Board {
  let nb = b
  if (!c.settingsUnread) {
    if (b.advisorModel !== c.advisor) nb = { ...nb, advisorModel: c.advisor }
    if (JSON.stringify(b.shellCheck) !== JSON.stringify(c.shell)) nb = { ...nb, shellCheck: c.shell }
  }
  if (c.main && b.mainSource !== 'observed' && b.mainModel !== c.main) nb = { ...nb, mainModel: c.main, mainSource: 'configured' }
  return nb
}
