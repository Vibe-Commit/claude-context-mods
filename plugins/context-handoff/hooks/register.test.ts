import { expect, mock, test as run } from 'claude-code/testing'
import type { Args, EngineInterface, On } from 'claude-code'

// The `$` of the running test. The world's /compact raises session.compact
// from it: a hook's own `$` may not call it, and the engine's /compact is not
// the plugin's own code.
let engine: EngineInterface
const test: typeof run = (name, ...rest) => {
  const body = rest.at(-1) as ($: EngineInterface, on: On) => Promise<void>
  const wrapped = ($: EngineInterface, on: On) => { engine = $; return body($, on) }
  return run(name, ...([...rest.slice(0, -1), wrapped] as never as Parameters<typeof run> extends [string, ...infer R] ? R : never))
}

const TOOL_ID = 'mcp__context-handoff__Handoff'
const HOME = '/home/t'
const SID = 'sid-1'
const DIR = `${HOME}/.claude/handoffs/${SID}`
const PATH = `${DIR}/handoff-1.md`
const NOTE = `## Goal\nShip it.\n## Next steps\n1. ${'x'.repeat(300)}`

type World = {
  pct: number | undefined
  files: Map<string, string>
  realOf: Map<string, string>
  runs: string[][]
  submitted: string[]
  compacts: { instructions?: string; messages?: readonly unknown[] }[]
  commands: string[]
  hold?: Promise<void>
  // What the engine's /compact raises session.compact over; absent, one message.
  transcript?: readonly unknown[]
  // Makes /compact end without ever raising session.compact.
  noCompact?: boolean
  // Makes the compaction itself end in a skip.
  skip?: string
}

// The engine beneath the plugin, answered from memory.
function world(on: On, pct: number | undefined): World {
  const w: World = { pct, files: new Map(), realOf: new Map(), runs: [], submitted: [], compacts: [], commands: [] }
  mock.env(on, { HOME })
  on('session.id', () => ({ value: SID }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent: w.pct }, rateLimits: [] } }))
  on('fs.write', (_$, e) => { w.files.set(e.path, e.text); return { value: undefined } })
  on('fs.stat', async (_$, e) => {
    const isDir = e.path === DIR
    if (!isDir && !w.files.has(e.path)) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: isDir ? 'dir' : 'file', size: 0, mtimeMs: 0, isLink: false, realPath: w.realOf.get(e.path) ?? e.path } }
  })
  on('process.run', (_$, e) => {
    w.runs.push([...e.argv])
    if (e.argv[0] === 'rm') w.files.delete(e.argv[2] ?? '')
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.compact', async (_$, e) => {
    w.compacts.push({ instructions: e.instructions, messages: e.messages })
    // Only the /compact the plugin runs (it carries instructions) is held.
    if (e.instructions !== undefined && w.hold) await w.hold
    if (w.skip !== undefined) return { skip: w.skip }
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }
  })
  // The engine's /compact raises session.compact with trigger 'manual'.
  on('command.run', { command: 'compact' }, async (_$, e) => {
    w.commands.push(e.args)
    if (!w.noCompact) {
      await engine.session.compact({ trigger: 'manual', instructions: e.args, messages: w.transcript ?? [{ role: 'user', text: 'work', toolUses: [] }] } as never)
    }
    return { text: 'Compacted' }
  })
  on('prompt.submit', (_$, e) => { w.submitted.push(e.text); return { text: e.text } })
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  return w
}

const bash = { tool: 'Bash', command: 'ls' } as const
const turnEnd = { answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const

// A row the engine appends to the main conversation, typed so a change in the
// event's shape fails typecheck. A message from another session drained into a
// running turn is an attachment row with door `delivery`.
const DELIVERY: Args<'session.append'> = {
  message: {
    type: 'attachment',
    name: 'queued_command',
    content: [{ type: 'text', text: '<cross-session-message from-name="VK">use port 4000</cross-session-message>' }],
  },
  door: 'delivery',
  origin: { kind: 'peer' },
  uuid: 'row-delivery-1',
}
const DELIVERY_2: Args<'session.append'> = {
  ...DELIVERY,
  message: { ...DELIVERY.message, content: [{ type: 'text', text: '<cross-session-message from-name="VK">and keep the old route</cross-session-message>' }] },
  uuid: 'row-delivery-2',
}

// The transcript the engine hands the compaction once the handoff turn is
// over: the delivery rows are not in it, only the call, its saved result and
// the final answer.
const HANDOFF_TURN = [
  { role: 'user', text: 'build the thing', toolUses: [] },
  { role: 'assistant', text: 'handing off', toolUses: [{ tool_use_id: 'h-0', tool: TOOL_ID, input: {} }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'h-0', text: `Handoff saved to ${PATH}. End your turn now.`, isError: false }] },
  { role: 'assistant', text: 'done, compacting', toolUses: [] },
] as const

async function contextOf(r: { context?: readonly string[] }) {
  return (r.context ?? []).join('\n')
}

test('below the band, no note', async ($, on) => {
  world(on, 55)
  const r = await $.tool.call(bash)
  expect(await contextOf(r as never)).not.toContain('context-handoff')
})

test('in the band, the soft note comes once', async ($, on) => {
  world(on, 62)
  const first = await $.tool.call(bash)
  expect(await contextOf(first as never)).toContain('Context is at 62%')
  const second = await $.tool.call(bash)
  expect(await contextOf(second as never)).not.toContain('context-handoff')
})

test('at the band top, the firm note comes once', async ($, on) => {
  const w = world(on, 62)
  await $.tool.call(bash)
  w.pct = 71
  const firm = await $.tool.call(bash)
  expect(await contextOf(firm as never)).toContain('call the Handoff tool now')
  const after = await $.tool.call(bash)
  expect(await contextOf(after as never)).not.toContain('context-handoff')
})

test('Handoff is refused below the band', async ($, on) => {
  const w = world(on, 40)
  await $.tool.call(bash)
  const r = await $.tool.call({ tool: TOOL_ID, content: NOTE } as never)
  expect((r as { deny?: string; text?: string }).deny ?? (r as { text?: string }).text).toContain('not in the handoff band')
  expect(w.files.size).toBe(0)
})

test('Handoff refuses a thin note', async ($, on) => {
  const w = world(on, 62)
  await $.tool.call(bash)
  const r = await $.tool.call({ tool: TOOL_ID, content: 'todo' } as never)
  expect(JSON.stringify(r)).toContain('whole handoff note')
  expect(w.files.size).toBe(0)
})

test('the whole cycle: write, hold, compact, resume, read, delete', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, 62)
  await $.tool.call(bash)

  const saved = await $.tool.call({ tool: TOOL_ID, content: NOTE } as never)
  expect(JSON.stringify(saved)).toContain(PATH)
  expect(w.files.get(PATH)).toBe(NOTE)

  const held = await $.tool.call(bash)
  expect(JSON.stringify(held)).toContain('end your turn now')

  await $.turn.complete(turnEnd)
  await clock.settle()
  expect(w.compacts).toHaveLength(1)
  expect(w.submitted).toHaveLength(1)
  expect(w.submitted[0]).toContain(PATH)
  expect(w.compacts[0]?.instructions).toContain('never shorten them to labels')
  expect(w.submitted[0]).toContain('treat its Pending specs as binding')

  w.pct = 20
  await $.tool.call({ tool: 'Read', file_path: '/elsewhere.md' })
  expect(w.runs).toHaveLength(0)

  await $.tool.call({ tool: 'Read', file_path: PATH })
  expect(w.runs[0]).toEqual(['rm', '--', PATH])
  expect(w.runs[1]).toEqual(['rmdir', '--', DIR])
  expect(w.files.has(PATH)).toBe(false)
})

test('a note that resolves outside the handoff folder is never deleted', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, 62)
  await $.tool.call(bash)
  await $.tool.call({ tool: TOOL_ID, content: NOTE } as never)
  await $.turn.complete(turnEnd)
  await clock.settle()

  w.realOf.set(PATH, '/etc/passwd')
  await $.tool.call({ tool: 'Read', file_path: PATH })
  expect(w.runs).toHaveLength(0)
  expect(w.files.has(PATH)).toBe(true)
})

test('a resume turn that never reads the note keeps it', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, 62)
  await $.tool.call(bash)
  await $.tool.call({ tool: TOOL_ID, content: NOTE } as never)
  await $.turn.complete(turnEnd)
  await clock.settle()

  await $.turn.start({ text: w.submitted[0] ?? '', turnId: 't2' })
  await $.turn.complete({ ...turnEnd, turnId: 't2' })
  expect(w.runs).toHaveLength(0)
  expect(w.files.has(PATH)).toBe(true)
  w.pct = 20
  await $.tool.call({ tool: 'Read', file_path: PATH })
  expect(w.runs).toHaveLength(0)
})

test("another turn ending during the resume does not end the handoff", async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, 62)
  await $.tool.call(bash)
  await $.tool.call({ tool: TOOL_ID, content: NOTE } as never)
  await $.turn.complete(turnEnd)
  await clock.settle()

  // A message from another session runs and ends before the resume turn.
  await $.turn.start({ text: 'from session B', turnId: 'other' })
  await $.turn.complete({ ...turnEnd, turnId: 'other' })
  await $.turn.start({ text: w.submitted[0] ?? '', turnId: 't2' })
  w.pct = 20
  await $.tool.call({ tool: 'Read', file_path: PATH })
  expect(w.runs[0]?.[0]).toBe('rm')
  expect(w.files.has(PATH)).toBe(false)
})

test("a subagent's turn end does not compact", async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, 62)
  await $.tool.call(bash)
  await $.tool.call({ tool: TOOL_ID, content: NOTE } as never)
  await $.turn.complete({ ...turnEnd, agentId: 'sub-1' })
  await clock.settle()
  expect(w.compacts).toHaveLength(0)
})

test('the overshoot prompt comes once when a turn ends past it', async ($, on) => {
  const w = world(on, 76)
  await $.turn.complete(turnEnd)
  await $.turn.complete({ ...turnEnd, turnId: 't2' })
  expect(w.submitted).toHaveLength(1)
  expect(w.submitted[0]).toContain('76%')
})

test('the rewind: the summary runs over the transcript before the Handoff call', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, 62)
  let release = () => {}
  w.hold = new Promise<void>(r => { release = r })
  await $.tool.call(bash)
  await $.tool.call({ tool: TOOL_ID, content: NOTE } as never)
  await $.turn.complete(turnEnd)
  await clock.settle()
  // The plugin's own compaction is held mid-flight, so the phase reads compacting.

  const msg = (role: 'user' | 'assistant', text: string, tools: string[] = []) => ({
    role, text, toolUses: tools.map((tool, i) => ({ tool_use_id: `${text}-${i}`, tool, input: {} })),
  })
  const transcript = [
    msg('user', 'build the thing'),
    msg('assistant', 'working', ['Bash']),
    msg('user', 'tool results'),
    msg('assistant', 'handing off', [TOOL_ID]),
    { ...msg('user', ''), toolResults: [{ tool_use_id: 'handing off-0', text: `Handoff saved to ${PATH}. End your turn now.`, isError: false }] },
    msg('assistant', 'done, compacting'),
  ]
  await $.session.compact({ trigger: 'manual', messages: transcript } as never)
  const seen = w.compacts.find(c => JSON.stringify(c.messages).includes('build the thing'))
  expect(seen?.messages).toHaveLength(3)
  expect(JSON.stringify(seen?.messages)).not.toContain(TOOL_ID)
  expect(JSON.stringify(seen?.messages)).not.toContain('done, compacting')

  release()
  await clock.settle()
  expect(w.submitted[0]).toContain(PATH)
})

test('messages delivered into the handoff turn ride on the resume prompt', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, 62)
  let release = () => {}
  w.hold = new Promise<void>(r => { release = r })
  await $.tool.call(bash)
  await $.tool.call({ tool: TOOL_ID, content: NOTE } as never)
  await $.session.append(DELIVERY)
  await $.session.append(DELIVERY_2)
  await $.turn.complete(turnEnd)
  await clock.settle()
  await $.session.compact({ trigger: 'manual', messages: HANDOFF_TURN } as never)
  release()
  await clock.settle()

  const prompt = w.submitted[0] ?? ''
  expect(prompt).toContain(PATH)
  expect(prompt).toContain('> <cross-session-message from-name="VK">use port 4000</cross-session-message>')
  expect(prompt).toContain('no reply was sent')
  const first = prompt.indexOf('use port 4000')
  const second = prompt.indexOf('and keep the old route')
  expect(first).toBeGreaterThan(-1)
  expect(second).toBeGreaterThan(first)
  expect(prompt).toContain('</cross-session-message>\n\n> <cross-session-message')
  expect(prompt).not.toContain('build the thing')
})

// Rows that must never ride on the resume prompt. Each carries its own text
// block, so only its guard (phase, door, origin or agentId) keeps it out and a
// failure shows which one leaked.
const rowOf = (text: string, over: Partial<Args<'session.append'>> = {}): Args<'session.append'> => ({
  ...DELIVERY,
  message: { ...DELIVERY.message, content: [{ type: 'text', text }] },
  ...over,
})
const NOT_CARRIED: { phase: 'nudged' | 'pending' | 'compacting'; row: Args<'session.append'> }[] = [
  { phase: 'nudged', row: rowOf('a delivery before the Handoff call', { uuid: 'r1' }) },
  { phase: 'compacting', row: rowOf('a delivery after the handoff turn ended', { uuid: 'r2' }) },
  {
    phase: 'pending',
    row: rowOf('a tool result', {
      message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'a tool result' }] },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Bash' },
      uuid: 'r3',
    }),
  },
  {
    phase: 'pending',
    row: rowOf("this plugin's own prompt", {
      message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text: "this plugin's own prompt" }] },
      door: 'prompt',
      origin: { kind: 'plugin', name: 'context-handoff' },
      uuid: 'r4',
    }),
  },
  { phase: 'pending', row: rowOf("a subagent's delivery", { agentId: 'sub-1', uuid: 'r5' }) },
]

test('rows that are not late messages are never carried to the resume prompt', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, 62)
  let release = () => {}
  w.hold = new Promise<void>(r => { release = r })
  const appendAll = async (phase: 'nudged' | 'pending' | 'compacting') => {
    for (const { row } of NOT_CARRIED.filter(r => r.phase === phase)) await $.session.append(row)
  }

  await $.tool.call(bash)
  await appendAll('nudged')
  await $.tool.call({ tool: TOOL_ID, content: NOTE } as never)
  await appendAll('pending')
  await $.turn.complete(turnEnd)
  await clock.settle()
  await appendAll('compacting')
  await $.session.compact({ trigger: 'manual', messages: HANDOFF_TURN } as never)
  release()
  await clock.settle()

  expect(w.submitted[0]).toContain(PATH)
  expect(w.submitted[0]).not.toContain('These messages arrived')
})

test("an aborted handoff's late messages are not carried by the next one", async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, 62)
  let release = () => {}
  w.hold = new Promise<void>(r => { release = r })
  await $.tool.call(bash)
  await $.tool.call({ tool: TOOL_ID, content: NOTE } as never)
  await $.session.append(DELIVERY)
  await $.turn.complete({ ...turnEnd, isAborted: true })

  await $.tool.call({ tool: TOOL_ID, content: NOTE } as never)
  await $.turn.complete(turnEnd)
  await clock.settle()
  await $.session.compact({ trigger: 'manual', messages: HANDOFF_TURN } as never)
  release()
  await clock.settle()

  expect(w.submitted[0]).toContain(PATH)
  expect(w.submitted[0]).not.toContain('These messages arrived')
})

// A transcript around a saved Handoff call (id `h-0`), for the cut tests.
const turn = (role: 'user' | 'assistant', text: string, over: object = {}) => ({ role, text, toolUses: [], ...over })
const call = (text: string, id: string) => turn('assistant', text, { toolUses: [{ tool_use_id: id, tool: TOOL_ID, input: {} }] })
const result = (id: string, text: string) => turn('user', '', { toolResults: [{ tool_use_id: id, text, isError: false }] })
const SAVED = result('h-0', `Handoff saved to ${PATH}. End your turn now.`)
const BEFORE = [turn('user', 'build the thing'), turn('assistant', 'working'), result('b-0', 'ok')]

// Runs a handoff to the compaction over `transcript`, as /compact raises it.
async function compactOver($: EngineInterface, on: On, transcript: readonly unknown[], tweak: (w: World) => void = () => {}) {
  const clock = mock.clock(on)
  const w = world(on, 62)
  w.transcript = transcript
  tweak(w)
  await $.tool.call(bash)
  await $.tool.call({ tool: TOOL_ID, content: NOTE } as never)
  await $.turn.complete(turnEnd)
  await clock.settle()
  return w
}

test('the compaction runs through /compact, and the resume follows its outcome', async ($, on) => {
  const w = await compactOver($, on, [...BEFORE, call('handing off', 'h-0'), SAVED, turn('assistant', 'done')])
  expect(w.commands).toHaveLength(1)
  expect(w.commands[0]).toContain('never shorten them to labels')
  expect(w.compacts).toHaveLength(1)
  expect(w.submitted[0]).toContain(PATH)
})

test('the cut keeps a turn that ran before the compaction', async ($, on) => {
  const w = await compactOver($, on, [
    ...BEFORE, call('handing off', 'h-0'), SAVED, turn('assistant', 'done'),
    turn('user', '  '), turn('user', 'PEER MESSAGE'), turn('assistant', 'reply'),
  ])
  expect(w.compacts[0]?.messages).toEqual([...BEFORE, turn('user', 'PEER MESSAGE'), turn('assistant', 'reply')])
})

test('the cut starts at the latest saved call, not an earlier aborted one', async ($, on) => {
  const aborted = [call('first try', 'h-a'), result('h-a', `Handoff saved to ${PATH}. End your turn now.`), turn('assistant', 'stopped'), turn('user', 'carry on')]
  const w = await compactOver($, on, [...BEFORE, ...aborted, call('handing off', 'h-0'), SAVED, turn('assistant', 'done')])
  expect(w.compacts[0]?.messages).toEqual([...BEFORE, ...aborted])
})

test('a denied Handoff call in a later turn does not move the cut', async ($, on) => {
  const w = await compactOver($, on, [
    ...BEFORE, call('handing off', 'h-0'), SAVED, turn('assistant', 'done'),
    turn('user', 'PEER MESSAGE'), call('again', 'h-1'),
    result('h-1', 'A handoff is already under way (compacting).'), turn('assistant', 'ok'),
  ])
  const seen = JSON.stringify(w.compacts[0]?.messages)
  expect(w.compacts[0]?.messages).toHaveLength(7)
  expect(seen).toContain('PEER MESSAGE')
  expect(seen).toContain('already under way')
  expect(seen).not.toContain('Handoff saved to')
  expect(seen).not.toContain('handing off')
})

test('a compaction that never ran keeps the note and resumes nothing', async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } })
  const w = await compactOver($, on, [], w => { w.noCompact = true })
  expect(w.commands).toHaveLength(1)
  expect(w.submitted).toHaveLength(0)
  expect(toasts.join('\n')).toContain(`compaction did not run; the note stays at ${PATH}`)
  expect(w.files.has(PATH)).toBe(true)
  expect(((await $.command.run({ command: 'handoff', args: '' })) as { text?: string }).text).toContain('phase idle')
})

test('a skipped compaction keeps the note and resumes nothing', async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } })
  const w = await compactOver($, on, [...BEFORE, call('handing off', 'h-0'), SAVED], w => { w.skip = 'blocked by a hook' })
  expect(w.submitted).toHaveLength(0)
  expect(toasts.join('\n')).toContain(`compaction skipped: blocked by a hook; the note stays at ${PATH}`)
  expect(w.files.has(PATH)).toBe(true)
})

test('a configured band replaces the default', { options: { bandLow: 30, bandHigh: 40, overshoot: 50 } }, async ($, on) => {
  world(on, 35)
  const r = await $.tool.call(bash)
  expect(await contextOf(r as never)).toContain('Context is at 35%')
})

test('/handoff now submits a prompt so Claude acts without another message', async ($, on) => {
  const w = world(on, 30)
  const clock = mock.clock(on)
  const r = await $.command.run({ command: 'handoff', args: 'now' })
  expect((r as { text?: string }).text).toContain('Asked Claude to hand off')
  await clock.settle()
  expect(w.submitted.join('\n')).toContain('call the Handoff tool now')
})
