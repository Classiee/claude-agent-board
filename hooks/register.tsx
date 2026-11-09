import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentCard, Board, LogEntry, LogTone } from '../types'
import { agentModel, boardAlt, boardSvg, clock, cut, names, view } from './board-svg'
import { isCommitCommand } from './commit-scan'
import { modelFamily } from './models'
import { applyAgentModel, applyConfigured, applyMainModel, configuredFromSettings, finalVerdict, verdictOfInput } from './observe'
import type { Configured } from './observe'

export { isCommitCommand }

const PANE = 'agent-board'
const TITLE = 'Agent board'
const MAX_AGENTS = 30
const MAX_LOG = 40

const EMPTY: Board = {
  startedAt: 0,
  mainModel: '',
  mainSource: 'configured',
  mainStatus: 'idle',
  mainTurnAt: 0,
  advisorCalls: 0,
  agents: [],
  shell: { seen: 0, blocked: 0 },
  log: [],
}

// Bump the tag when Board's fields change: a value an older version stored
// outlives a reload and is then read as EMPTY instead.
const board = atom({ plugin: 'agent-board', key: 'board' } as const, EMPTY, {
  shape: 'board-3',
})

function addLog(b: Board, at: number, who: string, text: string, tone: LogTone, family?: string): Board {
  const entry: LogEntry = family ? { at, who, text, tone, family } : { at, who, text, tone }
  return { ...b, log: [...b.log, entry].slice(-MAX_LOG) }
}

/** Writes only when the board really changed: every write redraws the pane. */
async function change($: Parameters<typeof read>[0], fn: (b: Board) => Board): Promise<void> {
  const before = await read($, board)
  const after = fn(before)
  if (after === before || JSON.stringify(after) === JSON.stringify(before)) return
  await update($, board, fn)
}

/** The models the user's settings and `/model` name. Whatever cannot be read stays unknown. */
type ConfigSource = {
  session: { model(): Promise<string> }
  settings: { read(): Promise<Readonly<Record<string, unknown>>> }
}
async function readConfigured($: ConfigSource): Promise<Configured> {
  const out: Configured = {}
  try {
    const m = await $.session.model()
    if (typeof m === 'string' && m) out.main = m
  } catch {
    // not available here: the main model is learned from its responses instead
  }
  try {
    Object.assign(out, configuredFromSettings(await $.settings.read()))
  } catch {
    // no settings to read this time: the board keeps what it knew
    out.settingsUnread = true
  }
  return out
}

// Counted in memory and written only at moments that matter (an agent ends,
// a call is blocked, a commit, the main turn ends), so a working subagent
// never redraws the board from its tool calls and its animation runs uninterrupted
// (it redraws once, when its first response shows which model ran).
const pendingTools = new Map<string, number>()
let pendingSeen = 0
function takeSeen(): number {
  const n = pendingSeen
  pendingSeen = 0
  return n
}

// The verdict each reviewer put on the board in its current turn. A hand-back
// and the end of the same turn carry the same verdict, in either order: it is
// logged once. A new turn or a new run starts afresh.
const verdictShown = new Map<string, 'APPROVED' | 'REJECTED'>()

function patchAgent(b: Board, id: string, fn: (a: AgentCard) => AgentCard): Board {
  return { ...b, agents: b.agents.map(a => (a.id === id ? fn(a) : a)) }
}

export const register: Register = (on, options) => {
  const openOnStart = options.openOnStart === true
  const reviewerType = typeof options.reviewerAgent === 'string' && options.reviewerAgent.trim() ? options.reviewerAgent.trim() : 'skeptic'

  on('session.start', async ($, e, next) => {
    const now = await $.clock.now()
    const configured = await readConfigured($)
    await update($, board, b =>
      applyConfigured(b.startedAt ? b : addLog({ ...b, startedAt: now }, now, 'session', 'session start', 'info'), configured),
    )
    await $.command.register({
      name: 'agent-board',
      description: 'Open the agent board: main session, advisor, subagents, reviewer verdicts, shell calls',
    })
    if (openOnStart) void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'agent-board' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Agent board opened.' }
  })

  // Main loop: thinking / idle, and when its turn began. The configured models
  // are read again here, so a changed setting shows without a restart.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // an agent's new turn (resumed under its id) is a new review: its verdict is news
      verdictShown.delete(e.agentId)
    } else {
      const now = await $.clock.now()
      const configured = await readConfigured($)
      await change($, b => applyConfigured({ ...b, mainStatus: 'thinking', mainTurnAt: now }, configured))
    }
    return next(e)
  })

  // Each model request: the model that answered is observed; the one the
  // step asked for is only configured. Advisor consultations are counted.
  on('turn.step', async function* ($, e, next) {
    const res = yield* next(e)
    // The model has already answered: nothing the board does from here may fail the step.
    try {
      const observed = res.usage?.model
      if (e.agentId === undefined) {
        const advisor = (res.serverToolUses ?? []).filter(u => u.name === 'advisor').length
        const now = await $.clock.now()
        await change($, b => {
          let nb = applyMainModel(b, observed, e.model)
          if (advisor > 0) {
            nb = { ...nb, advisorCalls: b.advisorCalls + advisor, advisorLastAt: now }
            nb = addLog(nb, now, 'advisor', `advisor consulted (#${nb.advisorCalls})`, 'info', modelFamily(nb.advisorModel))
          }
          return nb
        })
      } else if (observed) {
        const id = e.agentId
        await change($, b => applyAgentModel(b, id, observed))
      }
    } catch {
      // a board failure must never stop a model step
    }
    return res
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.agentId === undefined) {
      const seen = takeSeen()
      await change($, b => ({
        ...b,
        mainStatus: 'idle',
        shell: { ...b.shell, seen: b.shell.seen + seen },
      }))
      return next(e)
    }
    const id = e.agentId
    const failed = e.reason === 'error' || e.reason === 'refusal' || e.isAborted
    const verdict = finalVerdict(e.answer)
    const tools = pendingTools.get(id) ?? 0
    pendingTools.delete(id)
    const seen = takeSeen()
    // Decide and mark in one step (no await between the check and the mark),
    // so a hand-back finishing meanwhile sees it; undo the mark if the board
    // write fails, so the verdict isn't lost.
    const isReviewer = (await read($, board)).agents.find(a => a.id === id)?.reviewer === true
    const freshVerdict = verdict !== undefined && isReviewer && verdictShown.get(id) !== verdict ? verdict : undefined
    if (freshVerdict) verdictShown.set(id, freshVerdict)
    try {
      await update($, board, b => {
        const card = b.agents.find(a => a.id === id)
        if (!card) return b
        let nb = patchAgent(b, id, a => ({ ...a, status: failed ? 'failed' : 'done', endedAt: now, tools: a.tools + tools }))
        nb = { ...nb, shell: { ...nb.shell, seen: nb.shell.seen + seen } }
        nb = addLog(nb, now, card.type, failed ? `stopped (${e.reason})` : `done in ${clock(now - card.startedAt)}`, failed ? 'bad' : 'ok', modelFamily(card.model))
        if (freshVerdict) {
          nb = { ...nb, verdict: { status: freshVerdict, at: now } }
          nb = addLog(nb, now, card.type, `reported VERDICT ${freshVerdict}`, freshVerdict === 'APPROVED' ? 'ok' : 'bad', modelFamily(card.model))
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
        model: res.model,
        modelSource: 'configured', // what the spawn resolved; a response from the agent makes it observed
        reviewer: e.subagentType === reviewerType,
        task: e.description,
        status: 'running',
        startedAt: now,
        tools: 0,
      }
      await update($, board, b => {
        const nb = { ...b, agents: [...b.agents.filter(a => a.id !== card.id), card].slice(-MAX_AGENTS) }
        return addLog(nb, now, 'main', `delegate → ${card.type} · ${agentModel(card)}`, 'info', modelFamily(b.mainModel))
      })
    }
    return res
  }).catch(($, e, next) => next(e)) // a board failure must never stop a subagent

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId !== undefined) pendingTools.set(agentId, (pendingTools.get(agentId) ?? 0) + 1)

    const res = await next(e)
    const now = await $.clock.now()

    // A reviewer that hands its report back through a tool call carries its
    // verdict there, as the last line of its text. Only that call counts: a
    // grep or an edit that merely contains the words is not a verdict.
    // (the hand-back tool is not in the typed tool list, so compare as a string)
    const handedBack = !('isError' in res && res.isError) && !('deny' in res && res.deny)
    if (agentId !== undefined && (e.tool as string) === 'SubagentHandback' && handedBack) {
      const verdict = verdictOfInput(e)
      const card = (await read($, board)).agents.find(a => a.id === agentId)
      if (verdict && card?.reviewer && verdictShown.get(agentId) !== verdict) {
        verdictShown.set(agentId, verdict) // marked before the write; undone if it fails
        try {
          await update($, board, b => {
            const nb: Board = { ...b, verdict: { status: verdict, at: now } }
            return addLog(nb, now, card.type, `reported VERDICT ${verdict}`, verdict === 'APPROVED' ? 'ok' : 'bad', modelFamily(card.model))
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
      pendingSeen++
      const worthDrawing = (hookBlocked && !gateBlocked) || isCommit
      if (!worthDrawing) return res
      const seen = takeSeen()
      await update($, board, b => {
        let nb: Board = {
          ...b,
          shell: {
            seen: b.shell.seen + seen,
            blocked: b.shell.blocked + (hookBlocked && !gateBlocked ? 1 : 0),
          },
        }
        const who = agentId === undefined ? 'main' : b.agents.find(a => a.id === agentId)?.type ?? 'agent'
        // Which hook refused is not known: only that a PreToolUse hook did.
        if (hookBlocked && !gateBlocked) nb = addLog(nb, now, 'hook', `blocked a ${e.tool} call (${who})`, 'bad')
        if (isCommit && gateBlocked) {
          const reason = /\[commit-gate\]\s*([^\n]*)/.exec(errText)?.[1]?.trim() ?? ''
          nb = { ...nb, commit: { outcome: 'blocked', at: now } }
          nb = addLog(nb, now, 'commit', reason ? `commit blocked: ${cut(reason, 40)}` : 'commit blocked by the gate', 'bad')
        } else if (isCommit && !errText) {
          // No error came back. That is all this shows: not that the commit succeeded.
          nb = { ...nb, commit: { outcome: 'ran', at: now } }
          nb = addLog(nb, now, 'commit', 'commit ran without error', 'ok')
        } else if (isCommit) {
          nb = addLog(nb, now, 'commit', `commit not completed: ${cut(errText.split('\n')[0] ?? '', 30)}`, 'bad')
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
    const n = names(b)
    const t0 = b.startedAt || now
    const toneColor = (tone: LogTone) => (tone === 'ok' ? 'success' : tone === 'bad' ? 'error' : 'subtle')
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>CLAUDE CODE · AGENT BOARD</Text>
        <Text>
          <Text color={modelFamily(b.mainModel) ? 'claude' : undefined} bold>
            {b.mainModel ? n.main : 'unknown model'}
          </Text>{' '}
          main session · <Text color={v.mainState === 'idle' ? 'inactive' : 'claude'}>{v.mainState}</Text>{' '}
          <Text dimColor>({n.mainNote})</Text>
        </Text>
        <Text>
          advisor {n.advisorText} {v.advisorState} · advisor calls {b.advisorCalls} · reviewer {v.reviewing ? 'reviewing' : 'idle'} ·
          last verdict reported{' '}
          {b.verdict ? b.verdict.status.toLowerCase() : '—'}
        </Text>
        {v.shown.length === 0 && <Text dimColor>└╌ no subagents yet</Text>}
        {v.shown.map((a, i) => (
          <Box key={a.id}>
            <Text>
              {i === v.shown.length - 1 ? '└╌ ' : '├╌ '}
              <Text bold>{a.type}</Text> <Text dimColor>({agentModel(a)})</Text>{' '}
              <Text color={a.status === 'running' ? 'claude' : a.status === 'done' ? 'success' : 'error'}>{a.status}</Text>{' '}
              <Text dimColor>· {a.tools} tools</Text>
            </Text>
          </Box>
        ))}
        <Text dimColor>
          shell calls {b.shell.seen} seen · {b.shell.blocked} blocked by a hook · model check: {n.shellText}
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
