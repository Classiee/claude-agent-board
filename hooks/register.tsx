import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentCard, Board, LogEntry, LogTone } from '../types'
import { boardAlt, boardSvg, clock, view } from './board-svg'
import { isCommitCommand } from './commit-scan'

export { isCommitCommand }

const PANE = 'agent-board'
const TITLE = 'Agent board'
const MAX_AGENTS = 30
const MAX_LOG = 40

const EMPTY: Board = {
  startedAt: 0,
  mainModel: '',
  mainStatus: 'idle',
  mainTurnAt: 0,
  advisorCalls: 0,
  agents: [],
  shell: { checked: 0, blocked: 0 },
  log: [],
}

// Bump the tag when Board's fields change: a value an older version stored
// outlives a reload and is then read as EMPTY instead.
const board = atom({ plugin: 'agent-board', key: 'board' } as const, EMPTY, {
  shape: 'board-2',
})

const VERDICT_RE = /VERDICT\s*:\s*[*_`]*\s*(APPROVED|REJECTED)\b/gi
/** claude-haiku-5-5 -> "haiku 5.5"; aliases pass through. */
export function shortModel(model: string | undefined): string {
  if (!model) return '?'
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model)
  if (!m) return model
  return m[3] ? `${m[1]} ${m[2]}.${m[3]}` : `${m[1]} ${m[2]}`
}

export function lastVerdict(text: string): 'APPROVED' | 'REJECTED' | undefined {
  let found: 'APPROVED' | 'REJECTED' | undefined
  for (const m of text.matchAll(VERDICT_RE)) {
    found = (m[1] ?? '').toUpperCase() === 'REJECTED' ? 'REJECTED' : 'APPROVED'
  }
  return found
}

function addLog(b: Board, at: number, who: string, text: string, tone: LogTone): Board {
  const entry: LogEntry = { at, who, text, tone }
  return { ...b, log: [...b.log, entry].slice(-MAX_LOG) }
}

/** Writes only when the board really changed: every write redraws the pane. */
async function change($: Parameters<typeof read>[0], fn: (b: Board) => Board): Promise<void> {
  const before = await read($, board)
  const after = fn(before)
  if (after === before || JSON.stringify(after) === JSON.stringify(before)) return
  await update($, board, fn)
}

// Counted in memory and written only at moments that matter (an agent ends,
// a call is blocked, a commit, the main turn ends), so a working subagent
// never redraws the board and its animation runs uninterrupted.
const pendingTools = new Map<string, number>()
let pendingChecked = 0
function takeChecked(): number {
  const n = pendingChecked
  pendingChecked = 0
  return n
}

// The verdict each skeptic put on the board in its current turn. A hand-back
// and the end of the same turn carry the same verdict, in either order: it is
// logged once. A new turn or a new run starts afresh.
const verdictShown = new Map<string, 'APPROVED' | 'REJECTED'>()

function patchAgent(b: Board, id: string, fn: (a: AgentCard) => AgentCard): Board {
  return { ...b, agents: b.agents.map(a => (a.id === id ? fn(a) : a)) }
}

export const register: Register = (on, options) => {
  const openOnStart = options.openOnStart === true

  on('session.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, board, b => (b.startedAt ? b : addLog({ ...b, startedAt: now }, now, 'session', 'session start', 'info')))
    await $.command.register({
      name: 'agent-board',
      description: 'Open the agent board: main session, advisor, subagents, commit gate',
    })
    if (openOnStart) void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'agent-board' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Agent board opened.' }
  })

  // Main loop: thinking / idle, and when its turn began.
  on('turn.start', async ($, e, next) => {
    // a skeptic's new turn (resumed under its id) is a new review: its verdict is news
    if (e.agentId !== undefined) verdictShown.delete(e.agentId)
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await change($, b => ({ ...b, mainStatus: 'thinking', mainTurnAt: now }))
    }
    return next(e)
  })

  // Each model request of the main loop: its model, and advisor consultations.
  on('turn.step', async function* ($, e, next) {
    const res = yield* next(e)
    if (e.agentId === undefined) {
      const advisor = (res.serverToolUses ?? []).filter(u => u.name === 'advisor').length
      const model = res.usage?.model ?? e.model
      const now = await $.clock.now()
      await change($, b => {
        let nb: Board = b.mainModel === model ? b : { ...b, mainModel: model }
        if (advisor > 0) {
          nb = { ...nb, advisorCalls: b.advisorCalls + advisor, advisorLastAt: now }
          nb = addLog(nb, now, 'opus', `advisor consulted (#${nb.advisorCalls})`, 'info')
        }
        return nb
      })
    }
    return res
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.agentId === undefined) {
      const checked = takeChecked()
      await change($, b => ({
        ...b,
        mainStatus: 'idle',
        shell: { ...b.shell, checked: b.shell.checked + checked },
      }))
      return next(e)
    }
    const id = e.agentId
    const failed = e.reason === 'error' || e.reason === 'refusal' || e.isAborted
    const verdict = lastVerdict(e.answer)
    const tools = pendingTools.get(id) ?? 0
    pendingTools.delete(id)
    const checked = takeChecked()
    // Decide and mark in one step (no await between the check and the mark),
    // so a hand-back finishing meanwhile sees it; undo the mark if the board
    // write fails, so the verdict isn't lost.
    const isSkeptic = (await read($, board)).agents.find(a => a.id === id)?.type === 'skeptic'
    const freshVerdict = verdict !== undefined && isSkeptic && verdictShown.get(id) !== verdict ? verdict : undefined
    if (freshVerdict) verdictShown.set(id, freshVerdict)
    try {
    await update($, board, b => {
      const card = b.agents.find(a => a.id === id)
      if (!card) return b
      let nb = patchAgent(b, id, a => ({ ...a, status: failed ? 'failed' : 'done', endedAt: now, tools: a.tools + tools }))
      nb = { ...nb, shell: { ...nb.shell, checked: nb.shell.checked + checked } }
      nb = addLog(nb, now, card.type, failed ? `stopped (${e.reason})` : `done in ${clock(now - card.startedAt)}`, failed ? 'bad' : 'ok')
      if (freshVerdict) {
        nb = { ...nb, verdict: { status: freshVerdict, at: now } }
        nb = addLog(nb, now, 'skeptic', `VERDICT ${freshVerdict}`, freshVerdict === 'APPROVED' ? 'ok' : 'bad')
      }
      return nb
    })
    } catch (err) {
      if (freshVerdict && verdictShown.get(id) === freshVerdict) verdictShown.delete(id)
      throw err
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const res = await next(e)
    if (res.agentId) {
      verdictShown.delete(res.agentId) // a new run: its verdict is news
      const now = await $.clock.now()
      const card: AgentCard = {
        id: res.agentId,
        type: e.subagentType,
        model: shortModel(res.model),
        task: e.description,
        status: 'running',
        startedAt: now,
        tools: 0,
      }
      await update($, board, b => {
        const nb = { ...b, agents: [...b.agents.filter(a => a.id !== card.id), card].slice(-MAX_AGENTS) }
        return addLog(nb, now, 'sonnet', `delegate → ${card.type} (${card.model})`, 'info')
      })
    }
    return res
  }).catch(($, e, next) => next(e)) // a board failure must never stop a subagent

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId !== undefined) pendingTools.set(agentId, (pendingTools.get(agentId) ?? 0) + 1)

    const res = await next(e)
    const now = await $.clock.now()

    // A skeptic that hands its report back through a tool call carries its
    // verdict there. Only that call counts: a grep or an edit that merely
    // contains the words is not a verdict.
    // (the hand-back tool is not in the typed tool list, so compare as a string)
    const handedBack = !('isError' in res && res.isError) && !('deny' in res && res.deny)
    if (agentId !== undefined && (e.tool as string) === 'SubagentHandback' && handedBack) {
      const verdict = lastVerdict(JSON.stringify(e))
      const card = (await read($, board)).agents.find(a => a.id === agentId)
      if (verdict && card?.type === 'skeptic' && verdictShown.get(agentId) !== verdict) {
        verdictShown.set(agentId, verdict) // marked before the write; undone if it fails
        try {
          await update($, board, b => {
            const nb: Board = { ...b, verdict: { status: verdict, at: now } }
            return addLog(nb, now, 'skeptic', `VERDICT ${verdict}`, verdict === 'APPROVED' ? 'ok' : 'bad')
          })
        } catch (err) {
          if (verdictShown.get(agentId) === verdict) verdictShown.delete(agentId)
          throw err
        }
      }
    }

    if (e.tool === 'Bash' || e.tool === 'PowerShell') {
      const command = 'command' in e && typeof e.command === 'string' ? e.command : ''
      const errText = 'isError' in res && res.isError ? res.text ?? '' : 'deny' in res && res.deny ? res.deny : ''
      const hookBlocked = /hook error|hook stopped|blocked/i.test(errText) && /PreToolUse|commit-gate/.test(errText)
      const gateBlocked = errText.includes('[commit-gate]')
      const isCommit = isCommitCommand(command)
      pendingChecked++
      const worthDrawing = (hookBlocked && !gateBlocked) || (isCommit && (gateBlocked || !errText))
      if (!worthDrawing) return res
      const checked = takeChecked()
      await update($, board, b => {
        let nb: Board = {
          ...b,
          shell: {
            checked: b.shell.checked + checked,
            blocked: b.shell.blocked + (hookBlocked && !gateBlocked ? 1 : 0),
          },
        }
        const who = agentId === undefined ? 'sonnet' : b.agents.find(a => a.id === agentId)?.type ?? 'agent'
        if (hookBlocked && !gateBlocked) nb = addLog(nb, now, 'haiku', `blocked a ${e.tool} call (${who})`, 'bad')
        if (isCommit && gateBlocked) {
          nb = { ...nb, commit: { outcome: 'blocked', at: now } }
          nb = addLog(nb, now, 'gate', 'commit blocked: no approved verdict', 'bad')
        } else if (isCommit && !errText) {
          nb = { ...nb, commit: { outcome: 'allowed', at: now } }
          nb = addLog(nb, now, 'gate', 'commit allowed', 'ok')
        }
        return nb
      })
    }

    return res
  }).catch(($, e, next) => next(e)) // a board failure must never stop a tool call

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const b = await read($, board)
    const now = await $.clock.now()

    // Desktop, VS Code and mobile draw the animated diagram.
    // (The terminal's table can list an Svg it cannot draw, so ask the surface.)
    if (e.surface !== 'terminal' && 'Svg' in table) {
      const { Svg, Box } = table
      // An interactive (animated) Svg is a sandboxed frame: without a size it
      // falls back to a tiny default. The pane gives its width in code-font
      // cells (~8.5 CSS px each on desktop, measured); keep the board's 560×700 ratio.
      const width = Math.round(Math.min(1100, Math.max(320, (e.props.bodyColumns || 70) * 8.5)))
      const height = Math.round((width * 700) / 560)
      return (
        <Box flexDirection="column">
          <Svg source={boardSvg(b, now)} alt={boardAlt(b, now)} width={width} height={height} isInteractive />
        </Box>
      )
    }

    // The terminal has no Svg: a text tree with the same facts.
    const { Box, Text } = table
    const v = view(b, now)
    const t0 = b.startedAt || now
    const toneColor = (tone: LogTone) => (tone === 'ok' ? 'success' : tone === 'bad' ? 'error' : 'subtle')
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>CLAUDE CODE · 3 MODELS</Text>
        <Text>
          <Text color="claude" bold>
            {shortModel(b.mainModel || 'claude-sonnet-5-5')}
          </Text>{' '}
          main session · <Text color={v.mainState === 'idle' ? 'inactive' : 'claude'}>{v.mainState}</Text>
        </Text>
        <Text>
          <Text color="suggestion">opus</Text> {v.opusState} · advisor calls {b.advisorCalls} · verdict{' '}
          {b.verdict ? b.verdict.status.toLowerCase() : '—'}
        </Text>
        {v.shown.length === 0 && <Text dimColor>└╌ no subagents yet</Text>}
        {v.shown.map((a, i) => (
          <Box key={a.id}>
            <Text>
              {i === v.shown.length - 1 ? '└╌ ' : '├╌ '}
              <Text bold>{a.type}</Text> <Text dimColor>({a.model})</Text>{' '}
              <Text color={a.status === 'running' ? 'claude' : a.status === 'done' ? 'success' : 'error'}>{a.status}</Text>{' '}
              <Text dimColor>· {a.tools} tools</Text>
            </Text>
          </Box>
        ))}
        <Text dimColor>
          haiku shell check · {b.shell.checked} checked · {b.shell.blocked} blocked
        </Text>
        <Text dimColor>SESSION LOG</Text>
        {b.log.slice(-6).map((l, i) => (
          <Box key={`log-${i}`}>
            <Text>
              <Text dimColor>{clock(l.at - t0)}</Text> <Text color={toneColor(l.tone)}>{l.who}</Text> {l.text}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })
}
