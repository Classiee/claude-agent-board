import { expect, test } from 'claude-code/testing'

import { boardAlt, boardSvg } from '../hooks/board-svg'
import { parseModel } from '../hooks/models'
import {
  applyAgentModel,
  applyConfigured,
  applyMainModel,
  configuredFromSettings,
  finalVerdict,
  verdictOfInput,
} from '../hooks/observe'
import { isCommitCommand } from '../hooks/register'
import type { AgentCard, Board } from '../types'

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

const BOARD: Board = {
  startedAt: 1,
  mainModel: '',
  mainSource: 'configured',
  mainStatus: 'thinking',
  mainTurnAt: 1,
  advisorCalls: 0,
  agents: [],
  shell: { seen: 0, blocked: 0 },
  log: [],
}

const CARD: AgentCard = {
  id: 'a1',
  type: 'test-runner',
  model: 'claude-haiku-5-5',
  modelSource: 'observed',
  reviewer: false,
  task: 'run checks',
  status: 'running',
  startedAt: 1,
  tools: 0,
}

const NAMES_OF_THE_AUTHORS_SETUP = ['sonnet', 'haiku', 'opus', '--advisor', '3 models', '~/repo', 'writes the code']
const mentionsAny = (svg: string, words: string[]) => words.filter(w => svg.toLowerCase().includes(w))

test('an empty board draws the diagram where Svg exists, a text tree on the terminal', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  for (const surface of SVG_SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const src = await svgSource(ui)
    expect(src).toContain('CLAUDE CODE · AGENT BOARD')
    expect(src).toContain('no subagents yet')
    expect(src).toContain('asleep')
    // nothing is known yet, and the board says so instead of assuming a setup
    expect(src).toContain('unknown model · main session')
    expect(src).toContain('no model seen yet')
    expect(src).toContain('none found')
    expect(src).toContain('no model check found')
    expect(mentionsAny(src, NAMES_OF_THE_AUTHORS_SETUP)).toEqual([])
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

test('a spawned subagent gets a card, a live delegation line and its own colour', async ($, on) => {
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
  expect(src).toContain('haiku 5.5 (cfg)') // asked for at spawn, not yet seen answering
  expect(src).toContain('delegating')
  expect(src).toContain('delegate → haiku 5.5 (cfg)')
  expect(src).toContain('delegate → test-runner · haiku 5.5 (cfg)')
  expect(src).toContain('stroke-dashoffset') // marching dashes on the live line
  expect(src).toContain('stroke="#5b8def"') // the card is drawn in its model's colour
  expect(src).toContain('unknown model · main session') // the main model has not been seen
  await ui.unmount()

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: /test-runner/ })).toBeDefined()
  await term.unmount()
})

test('a commit the gate blocks reaches the log with the gate\'s own reason', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  on('tool.call', () => ({
    isError: true,
    result: undefined,
    text: 'PreToolUse:Bash hook error: [command hook]: [commit-gate] No APPROVED skeptic verdict',
  }))

  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const src = await svgSource(ui)
  expect(src).toContain('commit blocked: No APPROVED skeptic verdict')
  expect(src).toContain('1 seen · 0 blocked by a hook')
  await ui.unmount()
})

test('a commit that returns no error is logged as having run without error, no more', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  on('tool.call', () => ({ result: 'ok' }))
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const src = await svgSource(ui)
  expect(src).toContain('commit ran without error')
  expect(src.includes('commit allowed')).toBe(false)
  await ui.unmount()
})

test('a commit that was denied or failed is logged as not completed', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  on('tool.call', () => ({ deny: 'permission denied' }) as never)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const src = await svgSource(ui)
  expect(src).toContain('commit not completed: permission denied')
  expect(src.includes('commit ran without error')).toBe(false)
  await ui.unmount()
})

test('a shell call a hook blocks is counted as a hook block, and text is escaped', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  on('tool.call', () => ({
    isError: true,
    result: undefined,
    text: 'PreToolUse:Bash hook error: [You check one shell command...]: recursive delete blocked',
  }))

  await $.tool.call({ tool: 'Bash', command: 'rm -rf / <x>' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const src = await svgSource(ui)
  expect(src).toContain('1 seen · 1 blocked by a hook')
  expect(src).toContain('blocked a Bash call (main)')
  expect(src).toContain('>hook<') // which hook refused is not known, and not guessed
  expect(src.includes('<x>')).toBe(false)
  await ui.unmount()
})

test('the main model is drawn as observed or as configured, whichever it is', () => {
  const observed = boardSvg({ ...BOARD, mainModel: 'claude-opus-5-5', mainSource: 'observed' }, 2)
  expect(observed).toContain('opus 5.5 · main session')
  expect(observed).toContain('observed in the last response')
  expect(observed.includes('sonnet')).toBe(false)
  const configured = boardSvg({ ...BOARD, mainModel: 'claude-sonnet-5-5', mainSource: 'configured' }, 2)
  expect(configured).toContain('sonnet 5.5 · main session')
  expect(configured).toContain('configured, not yet observed')
})

test('a setup with other models shows those models and none of the author\'s', () => {
  const b: Board = {
    ...BOARD,
    mainModel: 'qwen3-coder',
    mainSource: 'observed',
    agents: [{ ...CARD, type: 'reviewer', model: 'my-gateway/gpt-x', task: 'review' }],
  }
  const src = boardSvg(b, 2)
  expect(src).toContain('qwen3-coder · main session')
  expect(src).toContain('my-gateway/gpt-x')
  expect(mentionsAny(src, NAMES_OF_THE_AUTHORS_SETUP)).toEqual([])
})

test('the advisor and shell-check models are the configured ones, and the advisor\'s run-time model is marked unobserved', () => {
  const b: Board = {
    ...BOARD,
    mainModel: 'my-model',
    mainSource: 'observed',
    advisorModel: 'claude-opus-4-1-20250805',
    advisorCalls: 1,
    shellCheck: { model: 'claude-haiku-4-5' },
  }
  const src = boardSvg(b, 2)
  expect(src).toContain('>opus 4.1 (cfg)</text>')
  expect(src).toContain('runtime model unobserved')
  expect(src).toContain('model check: haiku 4.5 (configured)')
  expect(src).toContain('my-model · main session')
  expect(boardSvg({ ...b, shellCheck: {} }, 2)).toContain('model check: model not stated')
})

test('model ids are read the same way for every provider\'s spelling', () => {
  const cases: Array<[string, string | undefined, string]> = [
    ['claude-sonnet-5-5', 'sonnet', 'sonnet 5.5'],
    ['claude-sonnet-4-20250514', 'sonnet', 'sonnet 4'],
    ['claude-opus-4-1-20250805', 'opus', 'opus 4.1'],
    ['claude-3-5-sonnet-20241022', 'sonnet', 'sonnet 3.5'],
    ['claude-3-opus-20240229', 'opus', 'opus 3'],
    ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'sonnet', 'sonnet 4.5'],
    ['claude-sonnet-4@20250514', 'sonnet', 'sonnet 4'],
    ['claude-haiku-4-5@20251001', 'haiku', 'haiku 4.5'],
    ['opus', 'opus', 'opus'],
    ['opus[1m]', 'opus', 'opus'],
    ['Sonnet', 'sonnet', 'sonnet'],
    ['claude-sonnet-4.5', 'sonnet', 'sonnet 4.5'],
    ['anthropic/claude-sonnet-4.5', 'sonnet', 'sonnet 4.5'],
    ['claude-3.5-sonnet', 'sonnet', 'sonnet 3.5'],
    ['claude-sonnet-4.20250514', undefined, 'claude-sonnet-4.20250514'],
    ['claude-sonnet-4-5-latest', 'sonnet', 'sonnet 4.5'],
    ['claude-sonnet-4-5-v2', 'sonnet', 'sonnet 4.5'],
    ['claude-sonnet-4-5x', undefined, 'claude-sonnet-4-5x'],
    ['claude-sonnet-4-5-6', undefined, 'claude-sonnet-4-5-6'],
    ['claude-sonnet-4-5-thinking', undefined, 'claude-sonnet-4-5-thinking'],
    ['my-claude-sonnet-4-5-finetune', undefined, 'my-claude-sonnet-4-5-finetune'],
    ['qwen3-coder', undefined, 'qwen3-coder'],
    ['my-gateway/gpt-x', undefined, 'my-gateway/gpt-x'],
    ['', undefined, 'unknown'],
  ]
  for (const [id, family, label] of cases) {
    const p = parseModel(id)
    expect([id, p.family, p.label]).toEqual([id, family, label])
  }
  expect(parseModel(undefined).label).toBe('unknown')
})

test('a response\'s model is observed; the model a step asked for is only configured', () => {
  const none = applyMainModel(BOARD, undefined, 'claude-opus-5-5')
  expect([none.mainModel, none.mainSource]).toEqual(['claude-opus-5-5', 'configured'])
  const seen = applyMainModel(none, 'claude-sonnet-5-5', 'claude-opus-5-5')
  expect([seen.mainModel, seen.mainSource]).toEqual(['claude-sonnet-5-5', 'observed'])
  // a later step that reports nothing does not undo what was observed
  expect(applyMainModel(seen, undefined, 'claude-opus-5-5')).toBe(seen)
  // the same answer again changes nothing, so nothing is redrawn
  expect(applyMainModel(seen, 'claude-sonnet-5-5', 'x')).toBe(seen)
  // a switch mid-session shows at the next response
  const switched = applyMainModel(seen, 'claude-opus-5-5', 'claude-opus-5-5')
  expect([switched.mainModel, switched.mainSource]).toEqual(['claude-opus-5-5', 'observed'])
})

test('each subagent keeps its own model, observed once it has answered', () => {
  const b: Board = {
    ...BOARD,
    agents: [
      { ...CARD, id: 'a1', model: 'haiku', modelSource: 'configured' },
      { ...CARD, id: 'a2', model: 'claude-opus-5-5', modelSource: 'configured' },
    ],
  }
  const one = applyAgentModel(b, 'a1', 'claude-haiku-5-5')
  expect(one.agents.map(a => [a.id, a.model, a.modelSource])).toEqual([
    ['a1', 'claude-haiku-5-5', 'observed'],
    ['a2', 'claude-opus-5-5', 'configured'],
  ])
  // the same report again: the same agent objects, so no redraw
  expect(applyAgentModel(one, 'a1', 'claude-haiku-5-5').agents[0]).toBe(one.agents[0])
  // an agent the board does not know changes nothing
  expect(applyAgentModel(one, 'zzz', 'x').agents).toEqual(one.agents)
})

test('settings name the advisor and shell-check models, and never replace an observed main model', () => {
  const settings = {
    advisorModel: 'claude-opus-5-5',
    hooks: {
      PreToolUse: [
        { matcher: 'Read', hooks: [{ type: 'prompt', model: 'not-this-one' }] },
        { matcher: 'Bash|PowerShell', hooks: [{ type: 'command' }, { type: 'prompt', model: 'claude-haiku-5-5' }] },
      ],
    },
  }
  expect(configuredFromSettings(settings)).toEqual({ advisor: 'claude-opus-5-5', shell: { model: 'claude-haiku-5-5' } })
  expect(configuredFromSettings({ hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'prompt' }] }] } })).toEqual({ shell: {} })
  expect(configuredFromSettings({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command' }] }] } })).toEqual({})
  expect(configuredFromSettings(undefined)).toEqual({})
  const hooksOf = (matcher: string, ...hooks: object[]) => ({ hooks: { PreToolUse: [{ matcher, hooks }] } })
  // a matcher is a pattern on the tool name
  expect(configuredFromSettings(hooksOf('.*', { type: 'prompt', model: 'm1' }))).toEqual({ shell: { model: 'm1' } })
  expect(configuredFromSettings(hooksOf('Edit|Write|NotBash', { type: 'prompt', model: 'm1' }))).toEqual({})
  expect(configuredFromSettings(hooksOf('(', { type: 'prompt', model: 'm1' }))).toEqual({})
  // a covering hook that names a model wins over one that does not
  expect(configuredFromSettings(hooksOf('Bash', { type: 'agent' }, { type: 'prompt', model: 'm2' }))).toEqual({ shell: { model: 'm2' } })
  expect(configuredFromSettings(hooksOf('Bash', { type: 'agent' }))).toEqual({ shell: {} })
  expect(configuredFromSettings({ advisorModel: 5, hooks: 'x' })).toEqual({})

  const observed = applyMainModel(BOARD, 'claude-sonnet-5-5', 'x')
  const withConfig = applyConfigured(observed, { main: 'something-else', advisor: 'claude-opus-5-5' })
  expect(withConfig.mainModel).toBe('claude-sonnet-5-5')
  expect(withConfig.advisorModel).toBe('claude-opus-5-5')
  // a setting that is removed disappears from the board
  expect(applyConfigured(withConfig, {}).advisorModel).toBeUndefined()
  // before any response, the configured main model fills the gap
  expect(applyConfigured(BOARD, { main: 'claude-opus-5-5' }).mainModel).toBe('claude-opus-5-5')
})

test('the board reads the configured models, follows a change, and names its actors by role', async ($, on) => {
  let model = 'claude-sonnet-5-5'
  on('clock.now', () => ({ value: 1_000 }))
  on('session.model', () => ({ value: model }) as never)
  on(
    'settings.read',
    () =>
      ({
        value: {
          advisorModel: 'claude-opus-5-5',
          hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'prompt', model: 'claude-haiku-5-5' }] }] },
        },
      }) as never,
  )
  on('command.register', () => ({ value: {} }) as never)
  on('session.start', () => ({ cwd: 'C:/x' }) as never)
  on('turn.start', () => ({ turnId: 't1' }) as never)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))

  await $.session.start({ cwd: 'C:/x' } as never)
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  let src = await svgSource(ui)
  expect(src).toContain('sonnet 5.5 · main session')
  expect(src).toContain('configured, not yet observed')
  expect(src).toContain('>opus 5.5 (cfg)</text>')
  expect(src).toContain('model check: haiku 5.5 (configured)')
  await ui.unmount()

  // /model changed before any response: the next turn shows it, no restart
  model = 'claude-opus-5-5'
  await $.turn.start({ text: '', turnId: 't2' })
  await $.agent.spawn({
    prompt: 'x', subagentType: 'test-runner', description: 'run checks', tool_use_id: 't1',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
  })
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  src = await svgSource(ui)
  expect(src).toContain('opus 5.5 · main session')
  // the log names the role, not a model the user may not run
  expect(src).toContain('>main<')
  expect(src.includes('>sonnet<')).toBe(false)
  await ui.unmount()
})

test('finalVerdict reads only the report\'s last line', () => {
  expect(finalVerdict('analysis\nVERDICT: APPROVED')).toBe('APPROVED')
  expect(finalVerdict('analysis\r\nVERDICT: REJECTED\r\n')).toBe('REJECTED')
  expect(finalVerdict('**VERDICT: REJECTED**')).toBe('REJECTED')
  expect(finalVerdict('verdict: approved\n\n')).toBe('APPROVED')
  // mentioned, quoted or conditional verdicts are not the report's verdict
  expect(finalVerdict('VERDICT: REJECTED\nIf you fix it I would write VERDICT: APPROVED')).toBeUndefined()
  expect(finalVerdict('The file has the line "VERDICT: APPROVED" as an example.\nREPO: x')).toBeUndefined()
  expect(finalVerdict('VERDICT: MAYBE')).toBeUndefined()
  // more text on the verdict line makes it something other than a verdict
  expect(finalVerdict('x\nVERDICT: APPROVED if you fix the bug')).toBeUndefined()
  expect(finalVerdict('x\nVERDICT: APPROVED or VERDICT: REJECTED')).toBeUndefined()
  expect(finalVerdict('x\nVERDICT: APPROVED-ish')).toBeUndefined()
  expect(finalVerdict('x\nVERDICT: APPROVED.')).toBe('APPROVED')
  expect(finalVerdict('x\n> **VERDICT: REJECTED**  ')).toBe('REJECTED')
  expect(finalVerdict('')).toBeUndefined()
})

test('a hand-back\'s verdict is read from its text fields, whatever they are called', () => {
  expect(verdictOfInput({ tool: 'SubagentHandback', agentId: 's1', message: 'ok\nVERDICT: REJECTED' })).toBe('REJECTED')
  expect(verdictOfInput({ tool: 'SubagentHandback', result: { text: 'ok\nVERDICT: APPROVED' } })).toBe('APPROVED')
  expect(verdictOfInput({ message: 'VERDICT: REJECTED\nbut VERDICT: APPROVED if fixed' })).toBeUndefined()
  expect(verdictOfInput({ n: 5, ok: true, list: [null, 'nothing here'] })).toBeUndefined()
})

test('animations start at the clock phase, so a redraw does not restart them', () => {
  // cursor blink is 1.1s: 1.5s in is 0.4s into the cycle, 2.6s in is 0.4s too
  expect(boardSvg(BOARD, 1_500)).toContain('dur="1.1s" begin="-0.400s"')
  expect(boardSvg(BOARD, 2_600)).toContain('dur="1.1s" begin="-0.400s"')
  expect(boardSvg(BOARD, 2_000)).toContain('dur="1.1s" begin="-0.900s"')
})

test('a working subagent shows motion, not a ticking count', () => {
  const b: Board = { ...BOARD, agents: [CARD] }
  const live = boardSvg(b, 2)
  expect(live).toContain('working…')
  expect(live.includes('>tools</text>')).toBe(false) // no count while it works
  const done = boardSvg({ ...b, agents: [{ ...CARD, status: 'done', endedAt: 2, tools: 12 }] }, 3)
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

test('a verdict quoted inside a report is not a verdict', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 's1' }))
  on('turn.complete', () => ({ text: '' }) as never)
  await $.agent.spawn(SKEPTIC)
  await $.turn.complete(endTurn('VERDICT: REJECTED\nI would write VERDICT: APPROVED if it were fixed'))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await verdictLines(ui, 'APPROVED')).toBe(0)
  expect(await verdictLines(ui, 'REJECTED')).toBe(0)
  await ui.unmount()
})

test('the reviewer agent name is configurable', { options: { reviewerAgent: 'code-critic' } }, async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 's1' }))
  on('tool.call', () => ({ result: 'ok' }))
  await $.agent.spawn({ ...SKEPTIC, subagentType: 'code-critic' })
  await $.tool.call(handBack('VERDICT: APPROVED'))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await verdictLines(ui, 'APPROVED')).toBe(1)
  await ui.unmount()
})

test('an agent that is not the reviewer sets no verdict', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 's1' }))
  on('tool.call', () => ({ result: 'ok' }))
  await $.agent.spawn({ ...SKEPTIC, subagentType: 'Explore' })
  await $.tool.call(handBack('VERDICT: APPROVED'))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await verdictLines(ui, 'APPROVED')).toBe(0)
  await ui.unmount()
})

test('long unrecognised ids are cut to fit, and the configured marker survives', () => {
  const arn = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/some-very-long-custom-model-identifier-v1:0'
  const b: Board = {
    ...BOARD,
    mainModel: arn,
    mainSource: 'observed',
    advisorModel: arn,
    advisorCalls: 1,
    agents: [{ ...CARD, model: 'my-gateway/gpt-x', modelSource: 'configured' }, { ...CARD, id: 'a2', model: arn, modelSource: 'configured' }],
  }
  const svg = boardSvg(b, 2)
  const runs = [...svg.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map(m => m[1] ?? '')
  expect(runs.filter(r => r.length > 50)).toEqual([])
  expect(svg).toContain('my-gatewa… (cfg)')
  expect(svg.includes(arn)).toBe(false)
})

test('an advisor that is in use but not named in the settings is not drawn as not configured', () => {
  const b: Board = { ...BOARD, advisorCalls: 2 }
  const svg = boardSvg(b, 2)
  expect(svg).toContain('> model not stated</tspan>')
  expect(svg).toContain('>model not stated</text>')
  expect(boardSvg(BOARD, 2).includes('model not stated')).toBe(false)
})

test('a commit another hook refuses is logged as a hook block and as not completed', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  on('tool.call', () => ({
    isError: true,
    result: undefined,
    text: 'PreToolUse:Bash hook error: [policy hook]: blocked by policy',
  }))
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const src = await svgSource(ui)
  expect(src).toContain('blocked a Bash call (main)')
  expect(src).toContain('commit not completed: PreToolUse:Bash hook erro')
  await ui.unmount()
})

const STEP = (model: string) =>
  ({
    turnId: 't1', // a result must name the step it answers
    index: 0,
    answer: '',
    toolUses: [],
    stopReason: 'end_turn',
    usage: { model, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }) as never

const STEP_INPUT = { turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 } as never

// For a caller, a model step is a stream: the board's hook runs as it is read to the end.
async function runStep($: { turn: { step: (e: never) => unknown } }): Promise<number> {
  let chunks = 0
  for await (const _chunk of $.turn.step(STEP_INPUT) as AsyncIterable<unknown>) chunks++
  return chunks
}

test('a model step shows the model that answered', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  on('turn.step', async function* () {
    return STEP('claude-opus-5-5')
  })
  await runStep($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const src = await svgSource(ui)
  expect(src).toContain('opus 5.5 · main session') // what answered, not what the step asked for
  expect(src).toContain('observed in the last response')
  await ui.unmount()
})

test('a subagent\'s step makes its card observed', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  on('turn.step', async function* () {
    return STEP('claude-haiku-5-5')
  })
  await $.agent.spawn({ ...SKEPTIC, subagentType: 'test-runner' })
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await svgSource(ui)).toContain('haiku (cfg)') // an alias, only asked for so far
  await ui.unmount()
  for await (const _chunk of $.turn.step({ ...(STEP_INPUT as object), agentId: 'a1' } as never) as AsyncIterable<unknown>) {
    // read to the end
  }
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const src = await svgSource(ui)
  expect(src).toContain('>haiku 5.5</text>') // seen answering: no (cfg)
  expect(src).toContain('>delegate → haiku 5.5</text>')
  expect(src.includes('>haiku (cfg)</text>')).toBe(false) // the card is no longer marked
  expect(src).toContain('delegate → test-runner · haiku (cfg)') // the log still records what was asked at spawn
  await ui.unmount()
})

test('a board failure after a model step cannot fail the step', async ($, on) => {
  let reads = 0
  on('clock.now', () => {
    if (reads++ === 0) throw new Error('clock down') // the board\'s own read, right after the model answered
    return { value: 1_000 }
  })
  on('turn.step', async function* () {
    return STEP('claude-opus-5-5')
  })
  let failed: unknown
  try {
    await runStep($)
  } catch (e) {
    failed = e
  }
  expect(failed).toBeUndefined() // the step completed
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const src = await svgSource(ui)
  expect(src).toContain('unknown model · main session') // and the board simply did not update
  await ui.unmount()
})

test('the verdict line is checked in time that grows with its length, not faster than it', () => {
  const crafted = [
    'VERDICT:' + ' '.repeat(160_000) + 'x',
    'VERDICT:' + ' *'.repeat(80_000) + 'x',
    'VERDICT:' + ' '.repeat(80_000) + 'APPROVED' + ' '.repeat(80_000) + 'x',
    '>'.repeat(160_000) + 'VERDICT',
    'x'.repeat(1_000_000),
    ('VERDICT: ' + ' '.repeat(50)).repeat(5_000),
  ]
  for (const text of crafted) {
    const t0 = Date.now()
    expect(finalVerdict(text)).toBeUndefined()
    expect(verdictOfInput({ message: text, nested: { more: [text] } })).toBeUndefined()
    expect([text.slice(0, 12), Date.now() - t0 < 300]).toEqual([text.slice(0, 12), true])
  }
  // and the short, real thing still works
  expect(finalVerdict('x\nVERDICT:   ***   APPROVED  ')).toBe('APPROVED')
})

test('a matcher that repeats a group is not run against tool names', () => {
  const t0 = Date.now()
  const hooks = { PreToolUse: [{ matcher: '(.*){25}X', hooks: [{ type: 'prompt', model: 'm1' }] }] }
  expect(configuredFromSettings({ hooks })).toEqual({})
  expect(Date.now() - t0 < 200).toBe(true)
})

test('a running reviewer is not drawn as the advisor working', () => {
  const b: Board = {
    ...BOARD,
    mainModel: 'claude-sonnet-5-5',
    mainSource: 'observed',
    advisorModel: 'claude-opus-4-1-20250805',
    agents: [{ ...CARD, type: 'skeptic', reviewer: true, model: 'claude-haiku-4-5', status: 'running' }],
  }
  const svg = boardSvg(b, 2)
  expect(svg).toContain('> [asleep]</tspan>') // the advisor has not been consulted
  expect(svg).toContain('> [reviewing]</tspan>') // the reviewer subagent is running
  expect(svg.includes('advisor</tspan><tspan fill="#e7e7e9"> [reviewing]')).toBe(false)
  const alt = boardAlt(b, 2)
  expect(alt).toContain('advisor opus 4.1 (configured), asleep')
  expect(alt).toContain('reviewer reviewing')
  // with no advisor configured there is nothing to contradict
  expect(boardAlt({ ...b, advisorModel: undefined }, 2).includes('none found, reviewing')).toBe(false)
  // and the advisor really working still shows as the advisor working
  const advising = boardSvg({ ...b, agents: [], advisorLastAt: 5, mainTurnAt: 1, advisorCalls: 1 }, 6)
  expect(advising).toContain('> [advising]</tspan>')
})

test('an agent with no type name is still drawn with a name', () => {
  const b: Board = { ...BOARD, agents: [{ ...CARD, type: '' }] }
  expect(boardSvg(b, 2)).toContain('>agent</text>')
  expect(boardAlt(b, 2)).toContain('agent (haiku 5.5)')
})

test('cutting a long name never splits an emoji', () => {
  const b: Board = { ...BOARD, agents: [{ ...CARD, task: 'x'.repeat(15) + '😀😀😀', type: 'a'.repeat(12) + '😀😀' }] }
  const svg = boardSvg(b, 2)
  // a half of an emoji left over would be a lone surrogate
  expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(svg)).toBe(false)
})

test('a very long model id is shown cut, and read in bounded time', () => {
  const t0 = Date.now()
  for (const id of ['['.repeat(200_000), 'claude-sonnet-4-5-' + 'x'.repeat(1_000_000), 'a'.repeat(5_000_000), '[a'.repeat(300_000), 'opus' + '['.repeat(100_000) + ']']) {
    const p = parseModel(id)
    expect([id.slice(0, 12), p.label.length <= 200]).toEqual([id.slice(0, 12), true])
  }
  expect(Date.now() - t0 < 300).toBe(true)
  // and a board holding such ids still draws quickly, and small
  const b: Board = {
    ...BOARD,
    mainModel: '['.repeat(200_000),
    mainSource: 'observed',
    advisorModel: 'x'.repeat(1_000_000),
    agents: [{ ...CARD, model: 'y'.repeat(1_000_000) }],
  }
  const t1 = Date.now()
  const svg = boardSvg(b, 2)
  expect(Date.now() - t1 < 300).toBe(true)
  expect(svg.length < 100_000).toBe(true)
  // the bracket suffix is still stripped from a real id
  expect(parseModel('claude-sonnet-4-5[1m]').label).toBe('sonnet 4.5')
})

test('a matcher with a chain of unbounded repeats is not run, a normal one is', () => {
  const t0 = Date.now()
  const prompt = { type: 'prompt', model: 'm1' }
  expect(configuredFromSettings({ hooks: { PreToolUse: [{ matcher: '.*'.repeat(95) + 'X', hooks: [prompt] }] } })).toEqual({})
  expect(Date.now() - t0 < 200).toBe(true)
  expect(configuredFromSettings({ hooks: { PreToolUse: [{ matcher: 'mcp__.*__.*|Bash', hooks: [prompt] }] } })).toEqual({ shell: { model: 'm1' } })
})

test('a settings read that fails once does not erase the advisor and shell check', () => {
  const known: Board = { ...BOARD, advisorModel: 'claude-opus-5-5', shellCheck: { model: 'claude-haiku-5-5' } }
  expect(applyConfigured(known, { settingsUnread: true })).toBe(known)
  // a read that worked and found nothing does remove them
  const cleared = applyConfigured(known, {})
  expect([cleared.advisorModel, cleared.shellCheck]).toEqual([undefined, undefined])
})

test('matchers are read as text: the forms hook matchers take work, patterns that could backtrack are never run', () => {
  const prompt = { type: 'prompt', model: 'm1' }
  const shellFor = (matcher: string) => configuredFromSettings({ hooks: { PreToolUse: [{ matcher, hooks: [prompt] }] } })
  const covered = { shell: { model: 'm1' } }
  for (const m of ['', '*', 'Bash', 'PowerShell', 'Bash|PowerShell', 'Edit|Bash', '.*', 'Power.*', '.*sh', 'B.*h', 'mcp__.*__.*|Bash', 'Bash|']) {
    expect([m, shellFor(m)]).toEqual([m, covered])
  }
  for (const m of ['Edit|Write|NotBash', 'Notebook.*', 'Read', 'bash', 'Bash(git *)', '(', 'Ba.sh', 'Bash?']) {
    expect([m, shellFor(m)]).toEqual([m, {}])
  }
  // the shapes that made a compiled matcher run for seconds or forever
  const t0 = Date.now()
  const hostile = [
    '.?'.repeat(45) + 'X',
    '.?'.repeat(99) + 'X',
    '(?:|)'.repeat(39) + 'X',
    '.{0,10}'.repeat(24) + 'X',
    '(.*){25}X',
    '.*'.repeat(95) + 'X',
    '(a|a)*'.repeat(30) + 'X',
    'x'.repeat(5_000),
    '.*'.repeat(100),
  ]
  for (const m of hostile) shellFor(m)
  expect(Date.now() - t0 < 200).toBe(true)
})

test('a configured advisor and shell check are marked as configured on the chips', () => {
  const b: Board = { ...BOARD, advisorModel: 'claude-opus-5-5', shellCheck: { model: 'claude-haiku-5-5' } }
  const svg = boardSvg(b, 2)
  expect(svg).toContain('> opus 5.5 (cfg)</tspan>')
  expect(svg).toContain('> haiku 5.5 (cfg)</tspan>')
  expect(svg).toContain('model check: haiku 5.5 (configured)')
  // nothing configured: nothing to mark
  expect(boardSvg(BOARD, 2).includes('(cfg)')).toBe(false)
})

test('a long configured model keeps its marker on the chips and the shell title', () => {
  const b: Board = {
    ...BOARD,
    advisorModel: 'claude-opus-4-5-thinking-extended-v2',
    shellCheck: { model: 'my-gateway/very-long-checker-model-name' },
  }
  const svg = boardSvg(b, 2)
  expect(svg).toContain(' (cfg)</tspan>')
  expect(svg).toContain('(configured)</text>')
  expect(boardSvg(BOARD, 2)).toContain('none found')
})

test('the alt text and the terminal tree say configured models are configured', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }) as never)
  on(
    'settings.read',
    () =>
      ({
        value: {
          advisorModel: 'claude-opus-5-5',
          hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'prompt', model: 'claude-haiku-5-5' }] }] },
        },
      }) as never,
  )
  on('command.register', () => ({ value: {} }) as never)
  on('session.start', () => ({ cwd: 'C:/x' }) as never)
  await $.session.start({ cwd: 'C:/x' } as never)

  const b: Board = {
    ...BOARD,
    mainModel: 'claude-sonnet-5-5',
    mainSource: 'observed',
    advisorModel: 'claude-opus-5-5',
    advisorCalls: 1,
    advisorLastAt: 5,
    mainTurnAt: 1,
    shellCheck: { model: 'claude-haiku-5-5' },
  }
  const alt = boardAlt(b, 6)
  expect(alt).toContain('advisor opus 5.5 (configured), advising')
  expect(alt.includes('advisor opus 5.5,')).toBe(false)

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: /advisor opus 5\.5 \(configured\) asleep/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /model check: haiku 5\.5 \(configured\)/ })).toBeDefined()
  await term.unmount()
})

test('every line that names a model says whether it was seen answering or only configured', () => {
  const runsOf = (svg: string) => [...svg.matchAll(/<(?:text|tspan)\b[^>]*>([^<]*)<\/(?:text|tspan)>/g)].map(m => m[1] ?? '')
  const configured: Board = {
    ...BOARD,
    mainModel: 'claude-sonnet-5-5',
    mainSource: 'configured',
    advisorModel: 'claude-opus-4-1-20250805',
    shellCheck: { model: 'claude-haiku-4-5' },
    agents: [{ ...CARD, model: 'claude-haiku-5-5', modelSource: 'configured' }],
  }
  const labels = ['sonnet 5.5', 'opus 4.1', 'haiku 4.5', 'haiku 5.5']
  const naming = runsOf(boardSvg(configured, 2)).filter(r => labels.some(l => r.includes(l)))
  expect(naming.length >= 8).toBe(true) // chips, titles, delegate, card, back-to, advisor, shell
  // the main card's title line is the one exception: the line under it says "configured, not yet observed"
  for (const run of naming) expect([run, /\(cfg\)|\(configured\)| · main session/.test(run)]).toEqual([run, true])

  // once both answered, the main model and the subagent are named without a marker
  const seen: Board = { ...configured, mainSource: 'observed', agents: [{ ...CARD, model: 'claude-haiku-5-5', modelSource: 'observed' }] }
  const seenRuns = runsOf(boardSvg(seen, 2)).filter(r => r.includes('sonnet 5.5') || r.includes('haiku 5.5'))
  expect(seenRuns.length >= 4).toBe(true)
  for (const run of seenRuns) expect([run, run.includes('(cfg)')]).toEqual([run, false])
})

test('a main model that is only configured is marked on the chip and the back-to label', () => {
  const configured = boardSvg({ ...BOARD, mainModel: 'claude-sonnet-5-5', mainSource: 'configured' }, 2)
  expect(configured).toContain('> sonnet 5.5 (cfg)</tspan>')
  expect(configured).toContain('back to sonnet 5.5 (cfg)')
  const observed = boardSvg({ ...BOARD, mainModel: 'claude-sonnet-5-5', mainSource: 'observed' }, 2)
  expect(observed.includes('(cfg)')).toBe(false)
  expect(observed).toContain('back to sonnet 5.5')
})

test('an agent whose model is not known is not drawn as configured unknown, and log text is cut safely', async ($, on) => {
  const svg = boardSvg({ ...BOARD, agents: [{ ...CARD, model: '', modelSource: 'configured' }] }, 2)
  expect(svg).toContain('>unknown</text>')
  expect(svg.includes('unknown (cfg)')).toBe(false)

  on('clock.now', () => ({ value: 1_000 }))
  on('tool.call', () => ({
    isError: true,
    result: undefined,
    text: '[commit-gate] ' + 'x'.repeat(38) + '😀😀',
  }))
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const src = await svgSource(ui)
  expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(src)).toBe(false)
  await ui.unmount()
})

test('the refusal count is not drawn under, or credited to, a model', () => {
  const b: Board = { ...BOARD, shell: { seen: 3, blocked: 2 }, shellCheck: { model: 'claude-haiku-4-5' } }
  const svg = boardSvg(b, 2)
  const runs = [...svg.matchAll(/<(?:text|tspan)\b[^>]*>([^<]*)<\/(?:text|tspan)>/g)].map(m => m[1] ?? '')
  // the line with the count names no model, and the line with the model names no count
  expect(runs.filter(r => r.includes('blocked by a hook')).every(r => !/haiku|\(cfg\)|\(configured\)/.test(r))).toBe(true)
  expect(runs.filter(r => r.includes('model check:')).every(r => !/blocked|seen/.test(r))).toBe(true)
  expect(boardAlt(b, 2)).toContain('2 blocked by a hook')
})

test('custom and raw ids are marked too, and the verdict is "reported" everywhere', () => {
  const runsOf = (svg: string) => [...svg.matchAll(/<(?:text|tspan)\b[^>]*>([^<]*)<\/(?:text|tspan)>/g)].map(m => m[1] ?? '')
  const configured: Board = {
    ...BOARD,
    mainModel: 'acme-custom-model',
    mainSource: 'configured',
    advisorModel: 'gw/opus-proxy',
    shellCheck: { model: 'my-checker' },
    agents: [{ ...CARD, model: 'my-llama-x', modelSource: 'configured' }],
    verdict: { status: 'APPROVED', at: 1 },
  }
  const runs = runsOf(boardSvg(configured, 2))
  const naming = runs.filter(r => ['acme-custom', 'gw/opus', 'my-checker', 'my-llama'].some(p => r.includes(p)))
  expect(naming.length >= 7).toBe(true)
  // the main card's raw-id line sits directly under the "configured, not yet observed" note
  for (const run of naming.filter(r => r !== 'acme-custom-model')) {
    expect([run, /\(cfg\)|\(configured\)| · main session/.test(run)]).toEqual([run, true])
  }
  const verdictRuns = runs.filter(r => r.includes('approved'))
  expect(verdictRuns.length >= 2).toBe(true)
  expect(verdictRuns.every(r => r.includes('reported') || r === 'approved')).toBe(true)
  expect(runs.some(r => r.includes('reported [approved]'))).toBe(true)
})

// How far right a text run reaches: its start plus its characters at about 0.6 em (plus any letter spacing).
function rightEdges(svg: string): Array<[string, number]> {
  const out: Array<[string, number]> = []
  for (const m of svg.matchAll(/<text\b([^>]*)>(.*?)<\/text>/g)) {
    const attrs = m[1] ?? ''
    if (/text-anchor=/.test(attrs)) continue // anchored runs grow from their anchor, checked separately
    const x = Number(/\bx="([\d.]+)"/.exec(attrs)?.[1])
    const size = Number(/font-size="([\d.]+)"/.exec(attrs)?.[1])
    const spacing = Number(/letter-spacing="([\d.]+)"/.exec(attrs)?.[1] ?? 0)
    const text = (m[2] ?? '').replace(/<[^>]+>/g, '').replace(/&amp;|&lt;|&gt;|&quot;|&gt;/g, '.')
    out.push([text, x + text.length * (size * 0.6 + spacing)])
  }
  return out
}

test('no normal state draws a line past the edge of the board', () => {
  const busy: Board = {
    ...BOARD,
    mainModel: 'claude-sonnet-5-5',
    mainSource: 'observed',
    mainStatus: 'thinking',
    mainTurnAt: 1,
    advisorModel: 'claude-opus-4-1-20250805',
    advisorCalls: 3,
    advisorLastAt: 5,
    shellCheck: { model: 'claude-haiku-4-5' },
    shell: { seen: 123456, blocked: 9876 },
    verdict: { status: 'APPROVED', at: 4 },
    agents: [
      { ...CARD, id: 'r', type: 'skeptic', reviewer: true, model: 'claude-opus-5-5', status: 'running' },
      { ...CARD, id: 'a', type: 'test-runner', status: 'running' },
      { ...CARD, id: 'b', type: 'Explore', status: 'done', endedAt: 3, tools: 12 },
    ],
    log: [{ at: 2, who: 'skeptic', text: 'reported VERDICT APPROVED and then some more words', tone: 'ok' as const }],
  }
  const longIds: Board = {
    ...busy,
    mainModel: 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/some-very-long-custom-model-identifier-v1:0',
    advisorModel: 'gw/' + 'opus-proxy-'.repeat(10),
    shellCheck: { model: 'my-checker-' + 'x'.repeat(40) },
    agents: busy.agents.map(a => ({ ...a, model: 'my-gateway/' + 'llama-'.repeat(10), modelSource: 'configured' as const })),
  }
  for (const [name, b] of [['empty', BOARD], ['busy', busy], ['long ids', longIds]] as const) {
    for (const [text, edge] of rightEdges(boardSvg(b, 2))) {
      expect([name, text.slice(0, 40), edge <= 546]).toEqual([name, text.slice(0, 40), true])
    }
  }
  // the verdict, which the bottom rows exist to show, is on a row that fits
  expect(rightEdges(boardSvg(busy, 2)).some(([text]) => text.startsWith('shell [123456/9876✗]') && text.includes('reported [approved]'))).toBe(true)
})
