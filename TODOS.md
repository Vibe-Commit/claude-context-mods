## context-handoff

### Recover a handoff stranded by a restart
**What:** At session.start, when ledger.json shows a note written but not read back and the file exists,
send a resume prompt for it instead of starting idle.
**Why:** `$.state` (phase, path, gate, hold) is lost on restart, so a restart mid-handoff strands the note.
**Context:** register.ts:146 session.start; ledger.json lastNote/done from 0.2.0; start with probe 6 (what
`claude --resume` restores). Risk to weigh: a stale note read into a session that has moved on.
**Effort:** S
**Priority:** P2
**Depends on:** context-handoff 0.2.0 (ledger.json)
