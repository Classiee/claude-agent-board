# agent-board

A live agent board for Claude Code: the main session, its advisor,
subagents with animated delegation lines, shell calls, a reviewer's verdict
and a session log. It draws as an animated diagram in the desktop app,
VS Code and mobile, and as a text tree in the terminal. Open it with
`/agent-board`.

Nothing about your setup is assumed. A model is shown as seen when a response
reported it, and marked as configured when only your settings, `/model` or a
spawn named it:

- **Main session and subagents:** the model a response reports is shown as
  seen. Until a response has come, the model you asked for is shown and marked
  as configured.
- **Advisor and shell check:** the models your settings name (`advisorModel`,
  and a PreToolUse prompt or agent hook that covers shell calls). Claude Code
  does not report which model ran an advisor call or a hook, so these are
  always the configured ones. With none found the board says so. Shell
  refusals are counted for every PreToolUse hook, so the count is not credited to
  any model.
- **Anything else:** a model the board has no name for is shown with its own
  id and a neutral colour. A model nobody has reported is shown as unknown.

The board only reports what it sees. A reviewer's verdict is the last line of
its report (`VERDICT: APPROVED` or `VERDICT: REJECTED`), shown as reported, not
as an acceptance of any particular change. A commit is shown as having run
without error, or as refused, with the reason the commit gate gave.

A commit the gate refuses is recognised by the `[commit-gate]` tag in the
refusal message; other refusals are shown as "commit not completed".

A shell check is a PreToolUse prompt or agent hook whose matcher covers shell
calls. Matchers are read as text, never run as patterns: an empty matcher or `*`,
a tool name, an `A|B` list, and `.*` as a wildcard inside a name are understood.
A matcher written any other way is not evaluated, and the board then shows no
model-backed shell check.

## Upgrading from 0.2

- Every model name now comes from your setup. The fixed Sonnet, Haiku and Opus
  labels, the invented command line and the window title are gone.
- "checked" is now "seen": the board counts the shell calls it saw, and does not
  know whether a model checked them.
- The saved board resets once, because its fields changed.
- The helper exports `shortModel`, `lastVerdict`, `familyOf` and `modelColor`
  are gone, and `Board.shell.checked` is now `Board.shell.seen`.

## Options

- **Open on session start** (off by default): open the board by itself.
- **Reviewer agent name** (`skeptic` by default): the subagent type whose
  final line may carry a verdict.

## Install

At the prompt of a terminal session:

```
/plugin install agent-board --marketplace Classiee/claude-agent-board
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install agent-board --marketplace Classiee/claude-agent-board
```

In the desktop app: click + next to the prompt box, then Plugins, then
Add marketplace with `Classiee/claude-agent-board`, then Add plugin.
