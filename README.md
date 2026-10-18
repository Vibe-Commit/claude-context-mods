# claude-context-mods

Three Claude Code mods for keeping long sessions healthy and readable:

| Mod | What it does |
| --- | --- |
| **context-meter** | Shows context-window usage in the prompt footer (`207k / 1.0M (21%)`), followed by five-hour and weekly limit usage when your plan reports it (`· 5h 34% · 7d 12%`), and shows a notice once when context usage passes 80%. |
| **context-handoff** | When context is 60–70% full, Claude picks a natural stopping point and writes itself a handoff note. The mod then cuts the note-writing out of the transcript (a rewind), runs `/compact`, and has Claude read the note and carry on. What binds the work (your rules and rulings, other sessions' specs) is kept in a ledger the mod carries across the handoff unchanged. The note is deleted once Claude has read it back. |
| **prompt-timestamp** | Puts the local date and time at the front of every prompt you type (`[10-02 14:03 EDT] fix the bug`), so the transcript and Claude both see when it was sent. |

All three are function-hook mods (plugins written as TypeScript hook modules). That API is **early access**, so it can change between Claude Code releases. context-meter was built and tested on **Claude Code 2.1.289**; context-handoff 0.2.0 needs **2.1.302 or later**, since it relies on behavior confirmed there (a typed prompt reaching `prompt.submit` at typing time, the sending session's wrapper on a delivery); prompt-timestamp needs 2.1.287 or later.

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
2. **Write.** Claude calls the mod's `Handoff` tool with two inputs. `content` is the state, as a markdown note with fixed sections: status (verified or not, with proof), the next action, pending work (citing the ledger items that bind it), failed approaches, open issues, git and environment state, and commands to verify. `ledger` is a list of changes to the ledger: `add`, `amend` or `retire` an item. The note is saved to `~/.claude/handoffs/<session-id>/handoff-N.md`, numbered past every note already in the folder so a restart or a retry never overwrites one. After Claude's state it carries two sections the mod writes itself: the ledger as it will stand once this handoff completes, and the messages since the last handoff that no ledger item cites (your typed prompts up to 600 characters in full, everything else as a line with its first 100 characters; the list is capped at about 8,000 characters, with the rest left in `ledger.json`). The `Handoff` call is never refused over the ledger: an op that cannot be applied, a source that cannot be found or a quote that is not in the record is reported in the result and in the note, and the call goes through. Claude is then held to ending its turn.
3. **Rewind and compact.** When the turn ends, the mod compacts the session. The mod runs `/compact` for this, and the summary only covers the transcript up to the `Handoff` call, so writing the note never ends up in context. A `Handoff` call that was refused earlier in the same turn is cut out too.
4. **Resume.** The mod sends a prompt telling Claude to read the note, run its verify commands, and check git state against it before any edits, trusting the repo where they differ. The ledger binds, each item with its source's authority: your ruling binds, another session's message binds within what it decides, an unverified message is only evidence. The summary is the story of how the work got here and never overrides the ledger or the note. Claude then continues from the note's next action. After the compaction, every tool except reading the note is refused until the whole note has been read (a note read in pages counts once the pages cover every line). So if something else starts the first turn (a prompt you type during `/compact`, a background task finishing), Claude still reads the note before it acts.
   - **Messages wait for the note.** From the `Handoff` call until the note is read back, messages from other sessions, teammates, relays and Remote Control are held instead of queued, so none starts or joins a turn ahead of the note. Each held message shows as a notice row, and the status line counts them. Claude gets each one exactly once: quoted on the resume prompt, or attached to its read of the note. If the handoff ends any other way, or after 10 minutes, they are sent in one prompt of their own. A prompt you type during the handoff turn is quoted on the resume prompt.
5. **Clean up.** After Claude reads the note back, the mod deletes it. It only deletes a file it wrote itself, and only if that file is inside the session's handoff folder. If the note is never read, it is kept and a notice shows its path.

**The ledger and the record.** Rules and rulings decay when each note and summary re-says them shorter, so the mod keeps them itself. `~/.claude/handoffs/<session-id>/ledger.json` holds the *ledger* (your intent and every rule, ruling, spec and decision in force, each with its conditions, who decided and the messages it cites) and the *record* (every prompt you type, every message from another session and every answer you give to a question, as received and dated; a text over 20,000 characters is cut). Relay events, scheduled tasks, subagents and the mod's own prompts are not recorded. Claude edits the ledger only by `add`, `amend` and `retire`; items it does not mention are carried byte for byte, and the result tells it when the ledger passes 12,000 characters so it can retire or merge items. The `/compact` summary is told to write only the story, so the note and the summary no longer repeat or contradict each other.
- Ledger changes made in a `Handoff` call are staged and only take effect once the note is read back; an interrupt or a failed compaction discards them.
- Nothing is recorded while `/handoff off`. A message from another session is recorded when it arrives but stays out of the note, and cannot be cited, until the engine has let it through (if you declined it, it never reaches Claude). A write failure never blocks a prompt, a message or the handoff: the mod keeps the ledger in memory, retries on the next write, and says so in the `Handoff` result or with a notice.
- Reading the note back completes the handoff: the staged changes join the ledger, and messages older than the previous handoff that no item cites are dropped from the record.
- Because the record holds message text, the session folder (`~/.claude/handoffs/<session-id>/`) now persists after a handoff and holds `ledger.json`. Delete it to forget a session's record.

Safeguards:
- Subagents are ignored.
- If a turn ends at 75% or more with no handoff, Claude is asked once to write one.
- If you interrupt the turn after the note is saved, the compaction is cancelled, the note is kept, and any held messages are sent right away.

Command: `/handoff [status|on|off|now]`. `status` shows the phase, the thresholds, how many handoffs this session has completed, and how many ledger items are in force and messages recorded. `now` asks for a handoff right away, which is the quickest way to try the mod.

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
