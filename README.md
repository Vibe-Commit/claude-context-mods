# claude-context-mods

Three Claude Code mods for keeping long sessions healthy and readable:

| Mod | What it does |
| --- | --- |
| **context-meter** | Shows context-window usage in the prompt footer (`207k / 1.0M (21%)`), followed by five-hour and weekly limit usage when your plan reports it (`· 5h 34% · 7d 12%`), and shows a notice once when context usage passes 80%. |
| **context-handoff** | When context is 60–70% full, Claude picks a natural stopping point and writes itself a handoff note. The mod then cuts the note-writing out of the transcript (a rewind), runs `/compact`, and has Claude read the note and carry on. The note is deleted once Claude has read it back. |
| **prompt-timestamp** | Puts the local date and time at the front of every prompt you type (`[10-02 14:03 EDT] fix the bug`), so the transcript and Claude both see when it was sent. |

All three are function-hook mods (plugins written as TypeScript hook modules). That API is **early access**, so it can change between Claude Code releases. context-meter and context-handoff were built and tested on **Claude Code 2.1.289**; prompt-timestamp needs 2.1.287 or later.

## Install

Inside Claude Code:

```
/plugin marketplace add Vibe-Commit/claude-context-mods
/plugin install context-meter@claude-context-mods
/plugin install context-handoff@claude-context-mods
/plugin install prompt-timestamp@claude-context-mods
```

Or from a shell:

```sh
claude plugin marketplace add Vibe-Commit/claude-context-mods
claude plugin install context-meter@claude-context-mods
claude plugin install context-handoff@claude-context-mods
claude plugin install prompt-timestamp@claude-context-mods
```

Restart Claude Code afterwards (or run `/reload-plugins`). Install any or all of them; they work independently.

## Update and uninstall

```sh
claude plugin marketplace update claude-context-mods
claude plugin update context-handoff@claude-context-mods   # restart to apply
claude plugin uninstall context-handoff@claude-context-mods
```

## context-handoff in detail

1. **In the band.** Once context passes 60%, Claude gets a hidden note telling it to hand off at the next natural boundary: a task finished, tests green, or before a new subtask, never mid-edit. At 70% the note says to do it now. The status line shows the current phase.
2. **Write.** Claude calls the mod's `Handoff` tool with a markdown note. The note has fixed sections: goal, the user's constraints, status (verified or not, with proof), the next action, failed approaches, decisions and their reasons, open issues, git and environment state, and commands to verify. It is saved to `~/.claude/handoffs/<session-id>/handoff-N.md`. Claude is then held to ending its turn.
3. **Rewind and compact.** When the turn ends, the mod compacts the session. The summary only covers the transcript up to the `Handoff` call, so writing the note never ends up in context.
4. **Resume.** The mod sends a prompt telling Claude to read the note, run its verify commands, and check git state against it before any edits, trusting the repo where they differ. Claude then keeps to the note's constraints and continues from its next action.
5. **Clean up.** After Claude reads the note back, the mod deletes it. It only deletes a file it wrote itself, and only if that file is inside the session's handoff folder. If the note is never read, it is kept and a notice shows its path.

Safeguards:
- Subagents are ignored.
- If a turn ends at 75% or more with no handoff, Claude is asked once to write one.
- If you interrupt the turn after the note is saved, the compaction is cancelled and the note is kept.

Command: `/handoff [status|on|off|now]`. `now` asks for a handoff right away, which is the quickest way to try the mod.

Thresholds (60 / 70 / 75 by default) can be changed per user. You can use `/plugin configure context-handoff@claude-context-mods` inside Claude Code, or a shell:

```sh
echo '{"bandLow":"55","bandHigh":"65","overshoot":"75"}' \
  | claude plugin configure context-handoff@claude-context-mods --values-stdin
```

When you install, Claude Code reports "3 userConfig options not yet set". That's expected: unset options use the defaults.

## Developing

Each mod has tests:

```sh
claude plugin validate plugins/context-handoff
claude plugin test plugins/context-handoff
```

To work on a mod with hot reload, load it from your checkout with `claude --plugin-dir ./plugins/context-handoff`, or list the folder in `CLAUDE_CODE_PLUGIN_DIRS`. Uninstall the marketplace copy first so it doesn't load twice. Bump `version` in the mod's `plugin.json` and in `.claude-plugin/marketplace.json` together. `claude plugin validate .` checks that they agree.
