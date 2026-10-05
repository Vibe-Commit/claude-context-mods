import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionContextUsage } from 'claude-code'

const START = { cwd: '/tmp', surface: null, isInteractive: true }

function engineBeneath(on: On, readings: SessionContextUsage[]) {
  const footers: (readonly string[])[] = []
  const toasts: string[] = []
  let i = 0

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: readings[Math.min(i++, readings.length - 1)]!,
      rateLimits: [],
    },
  }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'SessionMode' }, (_$, e) => {
    footers.push(e.props.modes)
    return { type: 'Text', children: [e.props.modes.join(' & ')] }
  })

  return { footers, toasts }
}

async function footer($: Engine, seen: { footers: (readonly string[])[] }) {
  await $.ui.render({
    surface: 'terminal',
    component: 'SessionMode',
    requestId: 'footer',
    props: { modes: ['focus'] },
  })
  return seen.footers.at(-1)
}

test('adds used / window and percent to the footer, unprefixed', async ($, on) => {
  const seen = engineBeneath(on, [{ tokens: 207_321, window: 1_000_000, percent: 21 }])
  await $.session.start(START)
  expect(await footer($, seen)).toEqual(['focus', '207k / 1.0M (21%)'])
  expect(seen.toasts).toEqual([])
})

test('shows a dash before the first response', async ($, on) => {
  const seen = engineBeneath(on, [{ window: 200_000 }])
  await $.session.start(START)
  expect(await footer($, seen)).toEqual(['focus', '— / 200k'])
})

test('leaves the footer alone before any reading', async ($, on) => {
  const seen = engineBeneath(on, [])
  expect(await footer($, seen)).toEqual(['focus'])
})

test('warns once at 80%, and again only after dropping below', async ($, on) => {
  const seen = engineBeneath(on, [
    { tokens: 162_000, window: 200_000, percent: 81 },
    { tokens: 170_000, window: 200_000, percent: 85 },
    { tokens: 20_000, window: 200_000, percent: 10 },
    { tokens: 164_000, window: 200_000, percent: 82 },
  ])
  await $.session.start(START)
  await $.session.start(START)
  expect(seen.toasts).toEqual(['Context at 81% — consider /compact'])
  await $.session.start(START)
  await $.session.start(START)
  expect(seen.toasts).toEqual([
    'Context at 81% — consider /compact',
    'Context at 82% — consider /compact',
  ])
  expect(await footer($, seen)).toEqual(['focus', '164k / 200k (82%)'])
})
