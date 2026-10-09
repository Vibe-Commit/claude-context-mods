# prompt-timestamp

A Claude Code mod that puts the local date and time (month-day, hour:minute) at the front of every prompt you type:

```
> [10-02 14:03 EDT] fix the bug
```

The timestamp is part of the prompt text, so it shows in the transcript and Claude reads it too.

## What gets stamped

Only prompts a person sent: typed at the terminal, or sent through Remote Control. Background task
notifications, scheduled `/loop` prompts, other plugins, and peer sessions are left alone.

## Prerequisites

Claude Code 2.1.287 or later (mods support).

## Install

```bash
claude plugin marketplace add Vibe-Commit/claude-context-mods
claude plugin install prompt-timestamp@claude-context-mods
```

To try a local checkout instead: `claude --plugin-dir ./prompt-timestamp`.

## Develop

```bash
claude plugin validate ./prompt-timestamp
claude plugin test ./prompt-timestamp
```

`.claude-plugin/types/` is written by Claude Code when the mod loads and is git-ignored. Once it
exists, `tsc -p ./prompt-timestamp` type-checks the mod.
