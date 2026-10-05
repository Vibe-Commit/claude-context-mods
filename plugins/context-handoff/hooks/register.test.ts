import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

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
  hold?: Promise<void>
}

// The engine beneath the plugin, answered from memory.
function world(on: On, pct: number | undefined): World {
  const w: World = { pct, files: new Map(), realOf: new Map(), runs: [], submitted: [], compacts: [] }
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
    if (!Array.isArray(e.messages) && w.hold) await w.hold
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }
  })
  on('prompt.submit', (_$, e) => { w.submitted.push(e.text); return { text: e.text } })
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  return w
}

const bash = { tool: 'Bash', command: 'ls' } as const
const turnEnd = { answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const

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

  await $.turn.complete({ ...turnEnd, turnId: 't2' })
  expect(w.runs).toHaveLength(0)
  expect(w.files.has(PATH)).toBe(true)
  w.pct = 20
  await $.tool.call({ tool: 'Read', file_path: PATH })
  expect(w.runs).toHaveLength(0)
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
    msg('user', 'saved'),
    msg('assistant', 'done, compacting'),
  ]
  await $.session.compact({ trigger: 'plugin', messages: transcript } as never)
  const seen = w.compacts.find(c => Array.isArray(c.messages))
  expect(seen?.messages).toHaveLength(3)
  expect(JSON.stringify(seen?.messages)).not.toContain(TOOL_ID)
  expect(JSON.stringify(seen?.messages)).not.toContain('done, compacting')

  release()
  await clock.settle()
  expect(w.submitted[0]).toContain(PATH)
})

test('a configured band replaces the default', { options: { bandLow: 30, bandHigh: 40, overshoot: 50 } }, async ($, on) => {
  world(on, 35)
  const r = await $.tool.call(bash)
  expect(await contextOf(r as never)).toContain('Context is at 35%')
})
