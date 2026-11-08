import { expect, test } from 'claude-code/testing'

import { boardSvg, familyOf } from '../hooks/board-svg'
import { isCommitCommand } from '../hooks/register'

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

// The v0.2.0 pattern: whatever real commit it caught, the scanner must catch too.
const OLD_COMMIT_RE = /\bgit(?:\.exe)?(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--?[\w-]+(?:=\S+)?))*\s+commit(?=\s|$|[;&|)])/

const REAL_COMMITS = [
  'git commit -m x',
  'cd repo && git commit -m x',
  'cd repo\ngit commit -m x',
  'git add -A\ngit commit -m x',
  'git -C "C:/a b" commit',
  'git -c user.name=x commit',
  'git -c user.name="A B" commit',
  'git --no-pager commit',
  'git --git-dir /x commit',
  'git --work-tree /x commit',
  'git commit',
  'git commit>log.txt',
  'git commit\\\n  -m x',
  'git -C "C:/x" `\n  commit -m y',
  'git `\r\n commit -m y',
  'bash -c "git commit"',
  'bash -c "git commit -m x" 2>&1',
  'bash -c "git commit -m x" arg0',
  'pwsh -Command "cd x; git commit -m y"',
  'pwsh -Command { git commit -m x }',
  'cmd /c git commit',
  'sudo git commit',
  'sudo -u bob git commit',
  'env X=1 git commit',
  'env -u FOO git commit',
  'nice -n 10 git commit',
  'timeout 60 git commit -m x',
  'GIT_DIR=x git commit',
  '`git commit`',
  'if git diff --cached --quiet; then echo none; else git commit -m x; fi',
  'if [ -n "$(git status --porcelain)" ]; then git commit -m x; fi',
  'for r in a b; do git -C $r commit -m x; done',
  '{ git commit -m x; }',
  '! git commit -m x',
  'if ($LASTEXITCODE -eq 0) { git commit -m x }',
  'try { git commit -m x } catch { }',
  'foreach ($r in $repos) { git -C $r commit -m x }',
  'git -C a\\ b commit',
  '& "C:\\Program Files\\Git\\cmd\\git.exe" commit -m x',
  'C:/tools/git/bin/git.exe commit -m x',
  'git commit -m "fix: git log output"',
  'git -C "C:\\repo\\" commit -m x',
  'git -C "C:\\Users\\krist\\repo\\" commit -m "msg"',
  'git -C "C:\\\\repo\\\\" commit -m x',
  'git -C "C:\\repo\\" add -A; git -C "C:\\repo\\" commit -m x',
  '$r=git commit -m x',
  '& $git commit -m x',
  'echo "$(git commit -m x)"',
  'echo $(git commit -m x)',
  'Write-Output (git commit -m x)',
  '<# note #> git commit -m x',
]

// Not counted. (Some text-only commands, such as `echo git commit`, do count:
// v0.2.0 counted them too, and a stray "commit allowed" line is the accepted
// price of never missing a real commit.)
const NOT_COMMITS = [
  'git log --grep commit',
  'git commit-tree abc',
  'git show -- commit.txt',
  'git status',
  'git commit --dry-run',
  'echo "git commit"',
  'rg "git commit" README.md',
  'grep -n \'git commit\' x',
  'Get-Content log.txt | Select-String "git commit"',
  'gitk commit',
]

test('only a real git commit counts as a commit', () => {
  for (const c of REAL_COMMITS) expect([c, isCommitCommand(c)]).toEqual([c, true])
  for (const c of NOT_COMMITS) expect([c, isCommitCommand(c)]).toEqual([c, false])
})

test('every real commit the v0.2.0 pattern caught is still caught', () => {
  for (const c of REAL_COMMITS) {
    if (OLD_COMMIT_RE.test(c)) expect([c, isCommitCommand(c)]).toEqual([c, true])
  }
})

test('crafted commands are checked fast', () => {
  const crafted = [
    'git ' + Array(5000).fill('-C "a"').join(' ') + ' status ' + '--x'.repeat(5000),
    'git -c ;'.repeat(25000),
    ';git -C "a'.repeat(10000),
    ';git -C a'.repeat(10000) + '"',
    'bash -c "'.repeat(10000),
    'git '.repeat(50000),
    '"git commit '.repeat(20000),
    '{ ( git -C '.repeat(20000),
    // just under the pattern limit, so the v0.2.0 pattern runs too
    'git -c ;'.repeat(510),
    'git ' + Array(580).fill('-C "a"').join(' ') + ' status',
    ('git ' + '--x '.repeat(20)).repeat(40),
    'git -C "'.repeat(500),
  ]
  for (const c of crafted) {
    const t0 = Date.now()
    isCommitCommand(c)
    expect([c.slice(0, 20), Date.now() - t0 < 200]).toEqual([c.slice(0, 20), true])
  }
})

test('a skeptic grepping for a verdict does not set one', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 's1' }))
  on('tool.call', () => ({ result: 'no matches' }))
  await $.agent.spawn({
    prompt: 'review', subagentType: 'skeptic', description: 'review diff', tool_use_id: 't1',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-sonnet-5-5', background: true, fork: false,
  })
  await $.tool.call({ tool: 'Bash', command: 'grep -r "VERDICT: APPROVED" .', agentId: 's1' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const src = await svgSource(ui)
  expect(src.includes('VERDICT APPROVED')).toBe(false)
  await ui.unmount()
})

const SKEPTIC = {
  prompt: 'review', subagentType: 'skeptic', description: 'review diff', tool_use_id: 't1',
  provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-sonnet-5-5', background: true, fork: false,
} as const
const endTurn = (answer: string) => ({ agentId: 's1', answer, reason: 'end_turn', isAborted: false }) as never
const handBack = (text: string) => ({ tool: 'SubagentHandback', message: text, agentId: 's1' }) as never
async function verdictLines(ui: { find: (q: { type: string }) => Promise<{ props: Record<string, unknown> } | undefined> }, v: string) {
  return ((await svgSource(ui)).match(new RegExp(`VERDICT ${v}`, 'g')) ?? []).length
}

test('a hand-back and the end of the same turn log the verdict once, in either order', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 's1' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', () => ({ text: '' }) as never)
  await $.agent.spawn(SKEPTIC)
  await $.tool.call(handBack('x\nVERDICT: REJECTED'))
  await $.turn.complete(endTurn('x\nVERDICT: REJECTED'))
  // the other order, for a second run of the same skeptic with the same verdict
  await $.agent.spawn(SKEPTIC)
  await $.turn.complete(endTurn('VERDICT: REJECTED'))
  await $.tool.call(handBack('VERDICT: REJECTED'))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await verdictLines(ui, 'REJECTED')).toBe(2) // once per run, never twice in one
  await ui.unmount()
})

test('a failed hand-back sets no verdict, and its retry sets one', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 's1' }))
  let n = 0
  on('tool.call', () => (n++ === 0 ? { isError: true, result: undefined, text: 'hand-back failed' } : { result: 'ok' }) as never)
  await $.agent.spawn(SKEPTIC)
  await $.tool.call(handBack('VERDICT: APPROVED'))
  const before = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await verdictLines(before, 'APPROVED')).toBe(0)
  await before.unmount()
  await $.tool.call(handBack('VERDICT: APPROVED'))
  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await verdictLines(after, 'APPROVED')).toBe(1)
  await after.unmount()
})

for (const [name, options, opens] of [
  ['off by default', {}, 0],
  ['on', { openOnStart: true }, 1],
  ['off', { openOnStart: false }, 0],
] as const) {
  test(`open on session start: ${name}`, { options }, async ($, on) => {
    let opened = 0
    on('clock.now', () => ({ value: 1_000 }))
    on('command.register', () => ({ value: {} }) as never)
    on('ui.open', () => {
      opened++
      return { value: {} } as never
    })
    on('session.start', () => ({ cwd: 'C:/x' }) as never)
    await $.session.start({ cwd: 'C:/x' } as never)
    expect(opened).toBe(opens)
  })
}

test('a denied hand-back sets no verdict', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 's1' }))
  on('tool.call', () => ({ deny: 'not allowed' }) as never)
  await $.agent.spawn(SKEPTIC)
  await $.tool.call(handBack('VERDICT: APPROVED'))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await verdictLines(ui, 'APPROVED')).toBe(0)
  await ui.unmount()
})

test('the same verdict from a new run or a new turn is logged again', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 's1' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', () => ({ text: '' }) as never)
  on('turn.start', () => ({ turnId: 't2' }) as never)
  await $.agent.spawn(SKEPTIC)
  await $.tool.call(handBack('VERDICT: REJECTED'))
  await $.turn.complete(endTurn('VERDICT: REJECTED'))
  // resumed under the same id: a new turn, the same verdict
  await $.turn.start({ text: '', turnId: 't2', agentId: 's1' })
  await $.tool.call(handBack('VERDICT: REJECTED'))
  // a new run of the same id, the same verdict again
  await $.agent.spawn(SKEPTIC)
  await $.turn.complete(endTurn('VERDICT: REJECTED'))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await verdictLines(ui, 'REJECTED')).toBe(3)
  await ui.unmount()
})
