import { expect, test } from 'claude-code/testing'

import { boardSvg, familyOf } from '../hooks/board-svg'

const PANE = {
  plugin: 'agent-board',
  component: 'Pane',
  requestId: 'agent-board',
  props: {
    title: 'Agent board',
    isFocused: false,
    bodyColumns: 72,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const SVG_SURFACES = ['desktop', 'vscode', 'mobile'] as const

async function svgSource(ui: { find: (q: { type: string }) => Promise<{ props: Record<string, unknown> } | undefined> }) {
  const svg = await ui.find({ type: 'Svg' })
  expect(svg).toBeDefined()
  return String(svg?.props.source ?? '')
}

test('an empty board draws the diagram where Svg exists, a text tree on the terminal', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  for (const surface of SVG_SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const src = await svgSource(ui)
    expect(src).toContain('CLAUDE CODE · 3 MODELS')
    expect(src).toContain('no subagents yet')
    expect(src).toContain('asleep')
    // sized explicitly: 72 columns × 8.5 px, 560:700 ratio
    const svg = await ui.find({ type: 'Svg' })
    expect(svg?.props.width).toBe(612)
    expect(svg?.props.height).toBe(765)
    await ui.unmount()
  }
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: /no subagents yet/ })).toBeDefined()
  await term.unmount()
})

test('a spawned subagent gets a card, a live delegation line and the haiku tab', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))

  await $.agent.spawn({
    prompt: 'run tests',
    subagentType: 'test-runner',
    description: 'run checks in repo',
    tool_use_id: 't1',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-sonnet-5-5',
    background: true,
    fork: false,
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const src = await svgSource(ui)
  expect(src).toContain('test-runner')
  expect(src).toContain('haiku 5.5')
  expect(src).toContain('delegating')
  expect(src).toContain('delegate → haiku 5.5')
  expect(src).toContain('stroke-dashoffset') // marching dashes on the live line
  expect(src).toContain('stroke="#5b8def"') // haiku tab highlighted
  expect(src).toContain('--model sonnet --advisor opus') // no model seen yet: the configured default
  await ui.unmount()

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: /test-runner/ })).toBeDefined()
  await term.unmount()
})

test('a commit the gate blocks reaches the log', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  on('tool.call', () => ({
    isError: true,
    result: undefined,
    text: 'PreToolUse:Bash hook error: [command hook]: [commit-gate] No APPROVED skeptic verdict',
  }))

  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const src = await svgSource(ui)
  expect(src).toContain('commit blocked: no approved verdict')
  expect(src).toContain('1 checked · 0 blocked')
  await ui.unmount()
})

test('a shell call the haiku check blocks is counted, and text is escaped', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  on('tool.call', () => ({
    isError: true,
    result: undefined,
    text: 'PreToolUse:Bash hook error: [You check one shell command...]: recursive delete blocked',
  }))

  await $.tool.call({ tool: 'Bash', command: 'rm -rf / <x>' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const src = await svgSource(ui)
  expect(src).toContain('1 checked · 1 blocked')
  expect(src).toContain('blocked a Bash call (sonnet)')
  expect(src.includes('<x>')).toBe(false)
  await ui.unmount()
})

test('the board follows the real model of the main session', () => {
  const b = {
    startedAt: 1, mainModel: 'claude-opus-5-5', mainStatus: 'thinking', mainTurnAt: 1, advisorCalls: 0,
    agents: [], shell: { checked: 0, blocked: 0 }, log: [],
  }
  const src = boardSvg(b, 2)
  expect(src).toContain('OPUS 5.5 · main session')
  expect(src).toContain('claude --model opus --advisor opus')
  expect(src).toContain('<rect x="372" y="60" width="170" height="20" rx="5" fill="#16192099" stroke="#b49cf5"') // opus tab lit
  expect(src.includes('--model sonnet')).toBe(false)
  expect(familyOf('claude-haiku-5-5')).toBe('haiku')
  expect(familyOf('')).toBe('sonnet')
})

test('animations start at the clock phase, so a redraw does not restart them', () => {
  const b = {
    startedAt: 1, mainModel: '', mainStatus: 'thinking', mainTurnAt: 1, advisorCalls: 0,
    agents: [], shell: { checked: 0, blocked: 0 }, log: [],
  }
  // cursor blink is 1.1s: 1.5s in is 0.4s into the cycle, 2.6s in is 0.4s too
  expect(boardSvg(b, 1_500)).toContain('dur="1.1s" begin="-0.400s"')
  expect(boardSvg(b, 2_600)).toContain('dur="1.1s" begin="-0.400s"')
  expect(boardSvg(b, 2_000)).toContain('dur="1.1s" begin="-0.900s"')
})

test('a working subagent shows motion, not a ticking count', () => {
  const card = { id: 'a1', type: 'test-runner', model: 'haiku 5.5', task: 'run checks', status: 'running' as const, startedAt: 1, tools: 0 }
  const b = {
    startedAt: 1, mainModel: '', mainStatus: 'thinking', mainTurnAt: 1, advisorCalls: 0,
    agents: [card], shell: { checked: 0, blocked: 0 }, log: [],
  }
  const live = boardSvg(b, 2)
  expect(live).toContain('working…')
  expect(live.includes('>tools</text>')).toBe(false) // no count while it works
  const done = boardSvg({ ...b, agents: [{ ...card, status: 'done' as const, endedAt: 2, tools: 12 }] }, 3)
  expect(done).toContain('>12</text>')
  expect(done).toContain('>tools</text>')
  expect(done.includes('working…')).toBe(false)
})
