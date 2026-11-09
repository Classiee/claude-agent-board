export type AgentStatus = 'running' | 'done' | 'failed'

/**
 * Where a model id on the board came from. `observed`: a response from that
 * model reported it. `configured`: only a setting, `/model` or a spawn result
 * named it, so it says what was asked for, not what answered.
 */
export type ModelSource = 'observed' | 'configured'

export type AgentCard = {
  id: string
  type: string
  /** The model id (or alias) as last reported for this agent. */
  model: string
  modelSource: ModelSource
  /** True for the configured reviewer agent type, whose last line may carry a verdict. */
  reviewer: boolean
  task: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  tools: number
  lastTool?: string
}

export type LogTone = 'ok' | 'bad' | 'info'

/** `family` colours the actor's name; absent means a neutral colour. */
export type LogEntry = { at: number; who: string; text: string; tone: LogTone; family?: string }

export type Board = {
  startedAt: number
  /** The main session's model id; '' until one is known. */
  mainModel: string
  mainSource: ModelSource
  mainStatus: string
  /** When the main loop's current (or last) turn began. */
  mainTurnAt: number
  advisorCalls: number
  advisorLastAt?: number
  /**
   * The advisor model the settings name (`advisorModel`); undefined when none
   * is configured. Which model ran an advisor call is not observable.
   */
  advisorModel?: string
  /**
   * A PreToolUse prompt or agent hook that covers shell calls, with the model
   * it names (if any). Undefined: no model-backed shell check is configured.
   */
  shellCheck?: { model?: string }
  agents: AgentCard[]
  /** What the reviewer's report ended with. A report, not proof of acceptance. */
  verdict?: { status: 'APPROVED' | 'REJECTED'; at: number }
  /** The last commit command seen: the gate refused it, or it ran without an error. */
  commit?: { outcome: 'blocked' | 'ran'; at: number }
  /** Shell calls seen, and how many a PreToolUse hook refused. */
  shell: { seen: number; blocked: number }
  log: LogEntry[]
}

declare module 'claude-code' {
  interface PluginState {
    'agent-board': { board: Shaped<Board> }
  }
}
