# agent-board

A live agent board for Claude Code: the main session, its Opus advisor,
subagents with animated delegation lines, the Haiku shell check, the
skeptic's commit-gate verdict, and a session log. It draws as an animated
diagram in the desktop app, VS Code and mobile, and as a text tree in the
terminal. Open it with `/agent-board`.

To have it open by itself when a session starts, turn on the plugin's
"Open on session start" option.

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

The verdict and gate parts need your own skeptic subagent and commit-gate
hook. Without them, the board still shows sessions, subagents and the log.
