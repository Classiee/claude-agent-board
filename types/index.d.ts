export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentCard = {
  id: string
  type: string
  model: string
  task: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  tools: number
  lastTool?: string
}

export type LogTone = 'ok' | 'bad' | 'info'

export type LogEntry = { at: number; who: string; text: string; tone: LogTone }

export type Board = {
  startedAt: number
  mainModel: string
  mainStatus: string
  /** When the main loop's current (or last) turn began. */
  mainTurnAt: number
  advisorCalls: number
  advisorLastAt?: number
  agents: AgentCard[]
  verdict?: { status: 'APPROVED' | 'REJECTED'; at: number }
  commit?: { outcome: 'blocked' | 'allowed'; at: number }
  shell: { checked: number; blocked: number }
  log: LogEntry[]
}

declare module 'claude-code' {
  interface PluginState {
    'agent-board': { board: Shaped<Board> }
  }
}
