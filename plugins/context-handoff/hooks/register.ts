import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { HandoffPhase } from '../types'

// Lifecycle: idle → nudged (in the band) → pending (Handoff written, turn
// ending) → compacting (handoff rewound off the transcript, then summarised)
// → resuming (Claude reads the file) → idle (file deleted).

const TOOL = 'Handoff'
const TOOL_ID = 'mcp__context-handoff__Handoff'
const MIN_CONTENT = 200
const COMPACT_RETRY_MS = 500
const COMPACT_ATTEMPTS = 20

const phaseRef = { plugin: 'context-handoff', key: 'phase' } as const
const pathRef = { plugin: 'context-handoff', key: 'handoffPath' } as const
const firmRef = { plugin: 'context-handoff', key: 'isFirmSent' } as const
const overshootRef = { plugin: 'context-handoff', key: 'isOvershootSent' } as const
const disabledRef = { plugin: 'context-handoff', key: 'isDisabled' } as const
const countRef = { plugin: 'context-handoff', key: 'handoffCount' } as const
const resumeTurnRef = { plugin: 'context-handoff', key: 'resumeTurnId' } as const
const lateRef = { plugin: 'context-handoff', key: 'lateMessages' } as const
const outcomeRef = { plugin: 'context-handoff', key: 'compactOutcome' } as const

const TOOL_DESCRIPTION = [
  'Saves a note you resume from after the session compacts.',
  'Call it only when a `[context-handoff]` note asks you to, at a natural boundary, never mid-edit.',
  'In a git repo, first run `git status -sb` and `git log -1 --oneline`, then call it alone in its own message.',
  '`content` is markdown for a future you with no memory of this session: state, not narrative. Use extremely concise language and minimize text, except in Pending specs, where exact wording matters more than brevity.',
  'Reference what is on disk by path or commit; copy what is not. Anything the user said in conversation that is not in a file is not on disk, so copy it. Never include secret values.',
  'Use these sections in order, writing "None" for an empty one:',
  "## Goal (the user's current request in their words, and what done looks like);",
  '## Constraints (every user rule still in force, verbatim);',
  '## Status (each item: verified with a command and result from after its last change, unverified, or not started);',
  '## Pending specs (verbatim) (for every item not yet done that the user or a plan specified: copy the exact text, including conditions, fail-closed shapes, required tests or witness mutants, and where it wires in, e.g. build sessions vs rewrite attempts, live-only vs testable in dry runs; never reduce an item to a label; write any detail that was never decided as an open question under that item);',
  '## Next action (one step: the file or command, and the expected result);',
  '## Failed approaches (what failed and why, with the exact error);',
  '## Decisions (each choice, what was ruled out, and why);',
  '## Open issues (bugs and failing tests with exact errors, questions for the user);',
  '## Environment (branch, HEAD, uncommitted changes, files changed this session, running processes);',
  '## Verify (read-only commands, each with its expected result).',
].join(' ')

const softNote = (pct: number) =>
  `[context-handoff] Context is at ${pct}%. At the next natural boundary ` +
  `(a task finished, tests green, before starting a new subtask) call the ` +
  `${TOOL} tool with your handoff note, then end your turn. Do not do it mid-edit.`

const firmNote = (pct: number) =>
  `[context-handoff] Context is at ${pct}%. Finish the step in hand, then call ` +
  `the ${TOOL} tool now and end your turn.`

const overshootPrompt = (pct: number) =>
  `Context is at ${pct}%, past the handoff band. Call the ${TOOL} tool now with ` +
  `your handoff note, then end your turn.`

const nowPrompt =
  `The user asked for a context handoff. Finish the step in hand, then call the ${TOOL} ` +
  `tool now with your handoff note and end your turn.`

const COMPACT_INSTRUCTIONS =
  'Summarize the work so far. A handoff note written by the assistant ' +
  'will be read right after this summary and takes precedence on next steps. ' +
  'Preserve verbatim any binding specs, exact conditions and per-item requirements ' +
  'the user gave; never shorten them to labels.'

const RESUME_PREFIX = 'Resuming after a context handoff.'

const resumePrompt = (path: string, late: string) =>
  `${RESUME_PREFIX} Read the note at ${path} with the Read tool. ` +
  `Before any edits, run its Verify commands and check git against its Environment section; ` +
  `where they differ, trust the repo and never revert or discard work to match the note. ` +
  `Follow its Constraints and treat its Pending specs as binding; if a pending item is only a label with no conditions, tell the user before implementing it and do not guess. Then continue from its Next action without waiting for confirmation.` +
  (late === '' ? '' :
    `\n\nThese messages arrived after the note was written, so it does not cover them. ` +
    `Tools were blocked once the note was saved, so none was acted on and no reply was sent. ` +
    `Handle them first if they change the plan, and send any reply they ask for:\n${late}`)

type Band = { low: number; high: number; overshoot: number }

const num = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

export const register: Register = (on, options) => {
  const band: Band = {
    low: num(options.bandLow, 60),
    high: num(options.bandHigh, 70),
    overshoot: num(options.overshoot, 75),
  }

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: TOOL,
      description: TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The whole handoff note, in markdown.' },
        },
        required: ['content'],
      },
    })
    await $.command.register({
      name: 'handoff',
      description: 'Context handoff: status, on, off, or now (hand off at the next boundary)',
      argumentHint: '[status|on|off|now]',
    })
    return next(e)
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off') {
      await $.state.set(disabledRef, true)
      $.ui.status(undefined)
      return { text: 'Context handoff is off for this session.' }
    }
    if (arg === 'on') {
      await $.state.set(disabledRef, false)
      return { text: 'Context handoff is on.' }
    }
    if (arg === 'now') {
      if ((await phaseOf($)) !== 'idle' && (await phaseOf($)) !== 'nudged') {
        return { text: `A handoff is already under way (${await phaseOf($)}).` }
      }
      await $.state.set(phaseRef, 'nudged')
      await $.state.set(firmRef, true)
      // A command's `context` is only recorded, it starts no turn, so submit
      // a prompt to make Claude act now.
      $.clock.after(0, () => void $.prompt.submit({ text: nowPrompt }))
      return { text: 'Asked Claude to hand off.' }
    }
    const pct = (await $.session.usage()).context.percent
    const isDisabled = (await $.state.get(disabledRef)).value === true
    const path = (await $.state.get(pathRef)).value
    const count = (await $.state.get(countRef)).value ?? 0
    return {
      text: [
        `context-handoff: ${isDisabled ? 'off' : 'on'}, phase ${await phaseOf($)}`,
        `context ${pct ?? '?'}%, band ${band.low}–${band.high}%, overshoot ${band.overshoot}%`,
        `handoffs this session: ${count}${path ? `, current file ${path}` : ''}`,
      ].join('\n'),
    }
  })

  // The Handoff tool: write the note, then hold the turn to its end.
  on('tool.call', { tool: TOOL_ID }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: 'Only the main conversation hands off.' }
    const phase = await phaseOf($)
    if (phase !== 'nudged') {
      return { deny: phase === 'idle'
        ? 'Context is not in the handoff band yet; keep working.'
        : `A handoff is already under way (${phase}).` }
    }
    const content = (e as { content?: unknown }).content
    if (typeof content !== 'string' || content.trim().length < MIN_CONTENT) {
      return { deny: `content must be the whole handoff note in markdown (at least ${MIN_CONTENT} characters).` }
    }
    const count = (await $.state.get(countRef)).value ?? 0
    const path = `${await handoffDir($)}/handoff-${count + 1}.md`
    await $.fs.write(path, content)
    await $.state.set(pathRef, path)
    // Each handoff's late window starts at its own call, even after an abort.
    await $.state.set(lateRef, '')
    await $.state.set(outcomeRef, '')
    await $.state.set(phaseRef, 'pending')
    $.ui.status('handoff: saved · compacting when this turn ends')
    return {
      result: `Handoff saved to ${path}. End your turn now: one line, no further tool calls. ` +
        'The session will compact and resume from this file.',
    }
  })

  // Every other tool: hold the turn once the handoff is written, delete the
  // file once it has been read back, and tell Claude when it is in the band.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined || e.tool === TOOL_ID) return next(e)
    const phase = await phaseOf($)
    if (phase === 'pending') {
      return { deny: 'The handoff is saved; end your turn now with no further tool calls.' }
    }
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    if (phase === 'resuming' && e.tool === 'Read' && ran.isError !== true) {
      await cleanup($, e.file_path)
    }
    const note = await bandNote($, band)
    return note === undefined ? ran : { ...ran, context: [...(ran.context ?? []), note] }
  })

  // A turn with no tool calls still hears about the band, with the prompt.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin') return next(e)
    const note = await bandNote($, band)
    return note === undefined ? next(e) : next({ ...e, context: [...(e.context ?? []), note] })
  })

  // Marks which turn is the resume turn, so another turn ending first (a
  // message from another session, say) is not taken for it.
  on('turn.start', async ($, e, next) => {
    if ((await phaseOf($)) === 'resuming' && e.text.startsWith(RESUME_PREFIX)) {
      await $.state.set(resumeTurnRef, e.turnId)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const answered = await next(e)
    if (e.agentId !== undefined) return answered
    const phase = await phaseOf($)

    if (phase === 'pending') {
      if (e.isAborted) {
        const path = (await $.state.get(pathRef)).value
        await $.state.set(phaseRef, 'nudged')
        await $.state.set(pathRef, '')
        $.ui.toast(`Handoff cancelled by the interrupt; the note stays at ${path}.`)
        return answered
      }
      await $.state.set(phaseRef, 'compacting')
      $.clock.after(0, () => void compactAndResume($, 1))
      return answered
    }

    if (phase === 'resuming') {
      // Only the resume turn's end counts; any other turn ends and waits.
      if ((await $.state.get(resumeTurnRef)).value !== e.turnId) return answered
      // The resume turn ended without a successful Read of the note: keep it.
      const path = (await $.state.get(pathRef)).value
      await finish($, false)
      if (path) $.ui.toast(`Resumed, but the handoff was not read back; kept at ${path}.`)
      return answered
    }

    if ((phase === 'idle' || phase === 'nudged') && e.reason === 'answer') {
      const pct = await percentOf($)
      const isDisabled = (await $.state.get(disabledRef)).value === true
      const isSent = (await $.state.get(overshootRef)).value === true
      if (!isDisabled && !isSent && pct !== undefined && pct >= band.overshoot) {
        await $.state.set(overshootRef, true)
        await $.state.set(phaseRef, 'nudged')
        void $.prompt.submit({ text: overshootPrompt(pct) })
      }
    }
    return answered
  })

  // A message that reaches Claude after the Handoff call (another session, a
  // teammate, a task) is drained into the handoff turn as a delivery row, which
  // the rewind cuts off. Quote it for the resume prompt; the row is kept as is.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId !== undefined || (e.door !== 'delivery' && e.door !== 'prompt')) return stored
    if (stored.message === undefined || (await phaseOf($)) !== 'pending') return stored
    if (e.origin.kind === 'plugin' && 'name' in e.origin && e.origin.name === 'context-handoff') return stored
    const text = textOf(stored.message.content)
    if (text === '') return stored
    const late = (await $.state.get(lateRef)).value ?? ''
    await $.state.set(lateRef, `${late === '' ? '' : `${late}\n\n`}> ${text.replace(/\n/g, '\n> ')}`)
    return stored
  })

  // The rewind: the summary runs over the transcript with the saved Handoff
  // call cut out, up to the next turn's start, so writing the note (and the
  // turn's last words) never reach the summary. Our own `$.session.compact` is
  // skipped as re-entry, so compactAndResume runs `/compact`, which raises this
  // hook with trigger 'manual'. Records how it ended for compactAndResume.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || (e.trigger !== 'manual' && e.trigger !== 'plugin')) return next(e)
    if ((await phaseOf($)) !== 'compacting') return next(e)
    const done = async (r: Awaited<ReturnType<typeof next>>) => {
      await $.state.set(outcomeRef, r.skip === undefined ? 'compacted' : `skipped: ${r.skip}`)
      return r
    }
    const cut = Array.isArray(e.messages) ? handoffCut(e.messages, (await $.state.get(pathRef)).value ?? '') : undefined
    if (cut === undefined || cut.at <= 0) {
      if (Array.isArray(e.messages)) {
        $.ui.log('context-handoff: no saved Handoff call in the transcript; compacting it whole', { to: 'debug' })
      }
      return done(await next(e))
    }
    return done(await next({ ...e, messages: [...e.messages.slice(0, cut.at), ...e.messages.slice(cut.end)] }))
  })
}

async function compactAndResume($: EngineInterface, attempt: number): Promise<void> {
  const path = (await $.state.get(pathRef)).value
  if (!path) return finish($, false)
  $.ui.status('handoff: compacting')
  try {
    await $.command.run({ command: 'compact', args: COMPACT_INSTRUCTIONS })
  } catch (err) {
    // Refused while a turn still runs: try again shortly.
    if (attempt < COMPACT_ATTEMPTS) {
      $.clock.after(COMPACT_RETRY_MS, () => void compactAndResume($, attempt + 1))
      return
    }
    $.ui.toast(`Handoff: compaction failed (${String(err)}); the note stays at ${path}.`)
    return finish($, false)
  }
  // Before the read: this `$` sees the hook's write only after one of its own.
  await $.state.set(phaseRef, 'resuming')
  const outcome = (await $.state.get(outcomeRef)).value ?? ''
  if (outcome !== 'compacted') {
    $.ui.toast(`Handoff: compaction ${outcome === '' ? 'did not run' : outcome}; the note stays at ${path}.`)
    return finish($, false)
  }
  $.ui.status('handoff: resuming')
  const late = (await $.state.get(lateRef)).value ?? ''
  await $.prompt.submit({ text: resumePrompt(path, late) })
}

// Deletes the note only when the Read was of exactly the file this plugin
// wrote, and that file lies under this session's handoff folder.
async function cleanup($: EngineInterface, readPath: string): Promise<void> {
  const path = (await $.state.get(pathRef)).value
  if (!path) return
  const dir = await handoffDir($)
  const [file, read, root] = await Promise.all([
    $.fs.stat(path, { resolve: true }).catch(() => undefined),
    $.fs.stat(readPath, { resolve: true }).catch(() => undefined),
    $.fs.stat(dir, { resolve: true }).catch(() => undefined),
  ])
  const real = file?.realPath
  if (real === undefined || read?.realPath !== real) return
  if (file?.kind !== 'file' || root?.realPath === undefined || !real.startsWith(`${root.realPath}/`)) {
    $.ui.log(`context-handoff: refused to delete ${real}: not a file under ${dir}`)
    return
  }
  const removed = await $.process.run(['rm', '--', real])
  if (removed.exitCode !== 0) {
    $.ui.log(`context-handoff: could not delete ${real}: ${removed.stderr.trim()}`)
    return
  }
  // Leaves the folder alone when another handoff of this session is in it.
  await $.process.run(['rmdir', '--', root.realPath]).catch(() => undefined)
  await finish($, true)
}

async function finish($: EngineInterface, isDone: boolean): Promise<void> {
  if (isDone) {
    const count = (await $.state.get(countRef)).value ?? 0
    await $.state.set(countRef, count + 1)
  }
  await $.state.set(phaseRef, 'idle')
  await $.state.set(pathRef, '')
  await $.state.set(firmRef, false)
  await $.state.set(overshootRef, false)
  await $.state.set(lateRef, '')
  await $.state.set(outcomeRef, '')
  await $.state.set(resumeTurnRef, '')
  $.ui.status(undefined)
}

// The note for Claude when the context is in the band, at most once per
// level per window; undefined otherwise.
async function bandNote($: EngineInterface, band: Band): Promise<string | undefined> {
  if ((await $.state.get(disabledRef)).value === true) return undefined
  const pct = await percentOf($)
  if (pct === undefined) return undefined
  const phase = await phaseOf($)
  if (phase === 'idle' && pct >= band.low) {
    await $.state.set(phaseRef, 'nudged')
    $.ui.status(`handoff: ${pct}% · waiting for a good point`)
    return softNote(pct)
  }
  if (phase === 'nudged') {
    $.ui.status(`handoff: ${pct}% · waiting for a good point`)
    if (pct >= band.high && (await $.state.get(firmRef)).value !== true) {
      await $.state.set(firmRef, true)
      return firmNote(pct)
    }
  }
  return undefined
}

async function phaseOf($: EngineInterface): Promise<HandoffPhase> {
  return (await $.state.get(phaseRef)).value ?? 'idle'
}

async function percentOf($: EngineInterface): Promise<number | undefined> {
  return (await $.session.usage()).context.percent
}

async function handoffDir($: EngineInterface): Promise<string> {
  const home = await $.env.get('HOME')
  if (!home) throw new Error('HOME is not set')
  return `${home}/.claude/handoffs/${await $.session.id()}`
}

function textOf(content: readonly { type: string; text?: unknown }[]): string {
  return content
    .flatMap(b => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
    .join('\n')
    .trim()
}

// The cut around the saved Handoff call: from its assistant message to the
// next turn's first user text, so a turn that ran before the compaction stays.
// A denied Handoff call has no "saved" result and never moves it.
function handoffCut(messages: readonly SessionMessage[], path: string): { at: number; end: number } | undefined {
  if (path === '') return undefined
  const saved = `Handoff saved to ${path}`
  const id = messages
    .flatMap(m => m.toolResults ?? [])
    .findLast(r => r.text.startsWith(saved))?.tool_use_id
  const at = id === undefined ? -1 : messages.findIndex(m => m.role === 'assistant' && m.toolUses.some(u => u.tool_use_id === id))
  if (at < 0) return undefined
  const next = messages.findIndex((m, i) => i > at && m.role === 'user' && m.text.trim() !== '' && (m.toolResults ?? []).length === 0)
  return { at, end: next < 0 ? messages.length : next }
}
