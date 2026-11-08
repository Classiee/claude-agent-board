// Is a shell command a `git commit`? This only decides what the board shows
// (the real commit gate is a separate hook), and it runs on every Bash and
// PowerShell call, so it is built to two rules:
//
//   1. One pass, never backwards: the time grows with the command's length
//      and nothing else.
//   2. Miss no real commit. It does not try to know where a command starts
//      (after `then`, `{`, `sudo -u bob`, `timeout 60` ...): any `git` word,
//      or a path to git / git.exe, followed by git's global options and then
//      `commit`, is a commit, unless `--dry-run` follows. Showing a commit
//      that wasn't one costs a stray log line; missing one hides the gate.
//
// The command is split into segments at newlines and ; & | (outside quotes),
// and each segment into words. A quoted string is one word (so a quoted
// option value stays with its option), and its text is also read as a
// command, for `bash -c "git commit"`. A segment that starts with a text
// command (echo, grep, rg, Select-String ...) is skipped: its words are data.
//
// A command also counts when the v0.2.0 pattern (below) matches it, so this
// never misses a commit the published version caught.

type Word = { text: string; quoted: boolean }

const SEPARATORS = new Set(['\n', ';', '&', '|'])
// > and < end a word too (redirects: git commit>log.txt)
const SPACE = new Set([' ', '\t', '\r', '{', '}', '(', ')', '>', '<'])
const ESCAPABLE = new Set([' ', '\t', ';', '&', '|', '#', '(', ')', '{', '}', '`'])
const VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'])
const TEXT_COMMANDS = new Set([
  'echo', 'printf', 'rg', 'grep', 'egrep', 'fgrep', 'findstr',
  'select-string', 'write-host', 'write-output', 'sls',
])
const MAX_DEPTH = 2

function lex(command: string): Word[][] {
  const segments: Word[][] = []
  let segment: Word[] = []
  let text = ''
  let started = false
  let quoted = false
  const endWord = () => {
    if (started) segment.push({ text, quoted })
    text = ''
    started = false
    quoted = false
  }
  const endSegment = () => {
    endWord()
    if (segment.length > 0) segments.push(segment)
    segment = []
  }
  const n = command.length
  for (let i = 0; i < n; i++) {
    const c = command[i] ?? ''
    const next = command[i + 1] ?? ''
    if (c === '"') {
      // double quotes: \" and `" are a quote inside; a backslash stays (Windows paths)
      let j = i + 1
      for (; j < n; j++) {
        const d = command[j] ?? ''
        if ((d === '\\' || d === '`') && command[j + 1] === '"') {
          text += '"'
          j++
        } else if (d === '"') break
        else text += d
      }
      started = true
      quoted = true
      i = j
    } else if (c === "'") {
      const close = command.indexOf("'", i + 1)
      const stop = close < 0 ? n : close
      text += command.slice(i + 1, stop)
      started = true
      quoted = true
      i = stop
    } else if ((c === '\\' || c === '`') && next === '\n') {
      endWord() // line continuation: bash \ and PowerShell `
      i++
    } else if ((c === '\\' || c === '`') && next === '\r' && command[i + 2] === '\n') {
      endWord()
      i += 2
    } else if (c === '\\' && ESCAPABLE.has(next)) {
      text += next // an escaped space or separator is part of the word
      started = true
      i++
    } else if (c === '#' && !started) {
      // a comment runs to the end of the line
      const eol = command.indexOf('\n', i)
      i = (eol < 0 ? n : eol) - 1
    } else if (SEPARATORS.has(c)) {
      endSegment()
    } else if (SPACE.has(c) || c === '`') {
      endWord()
    } else {
      text += c
      started = true
    }
  }
  endSegment()
  return segments
}

function baseName(word: string): string {
  const parts = word.split(/[\\/]/)
  return (parts[parts.length - 1] ?? '').toLowerCase().replace(/\.exe$/, '')
}

function commits(command: string, depth: number): boolean {
  return lex(command).some(s => segmentCommits(s, depth))
}

function segmentCommits(words: Word[], depth: number): boolean {
  const first = words[0]
  if (first && !first.quoted && TEXT_COMMANDS.has(baseName(first.text))) return false
  const NONE = 0
  const GIT = 1
  const AFTER = 2
  let state = NONE
  let skipValue = false
  let commit = false
  let dryRun = false
  for (const w of words) {
    if (skipValue) {
      skipValue = false // a value of -C, -c, --git-dir ...
      continue
    }
    // a quoted command, as in bash -c "git commit" or pwsh -Command "..."
    if (w.quoted && depth < MAX_DEPTH && /[\s;&|]/.test(w.text) && commits(w.text, depth + 1)) return true
    const t = w.text
    if (state === AFTER) {
      if (t === '--dry-run') dryRun = true
      continue
    }
    if (state === GIT) {
      if (VALUE_OPTIONS.has(t)) {
        skipValue = true
        continue
      }
      if (t.startsWith('-')) continue
      if (t === 'commit') {
        commit = true
        state = AFTER
        continue
      }
      state = NONE // another git subcommand: look for the next git
    }
    if (baseName(t) === 'git') state = GIT
  }
  return commit && !dryRun
}

// The v0.2.0 pattern, made backtrack-free: each global option is matched as
// an atomic group ((?=(...))\1 commits to its first match), and a quoted value
// must end at whitespace, so no input can make it retry exponentially. It
// still scans forward from every `git`, so it only runs on commands up to
// PATTERN_LIMIT characters, where that stays fast. It matches what v0.2.0
// matched, so together with the scanner no commit v0.2.0 caught is missed.
const V020_RE = /\bgit(?:\.exe)?(?:\s+(?=(-[Cc]\s+(?:"[^"]*"(?=\s|$)|'[^']*'(?=\s|$)|\S+)|--?[\w-]+(?:=\S+)?))\1)*\s+commit(?=\s|$|[;&|)])/
const DRY_RUN_RE = /\s--dry-run(?=\s|$)/
const PATTERN_LIMIT = 4096

export function isCommitCommand(command: string): boolean {
  if (commits(command, 0)) return true
  if (command.length > PATTERN_LIMIT) return false
  const m = V020_RE.exec(command)
  return m !== null && !DRY_RUN_RE.test(command.slice(m.index))
}
