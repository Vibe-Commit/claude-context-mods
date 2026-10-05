import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Label } from '../types'

const WARN_AT = 80

const label = atom({ plugin: 'context-meter', key: 'label' } as const, null as Label)

let isWarned = false

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

async function refresh($: EngineInterface): Promise<void> {
  try {
    const { context } = await $.session.usage()

    if (context.tokens === undefined || context.percent === undefined) {
      await update($, label, () => `— / ${fmt(context.window)}`)
      return
    }

    const text = `${fmt(context.tokens)} / ${fmt(context.window)} (${context.percent}%)`
    await update($, label, () => text)

    if (context.percent >= WARN_AT && !isWarned) {
      isWarned = true
      $.ui.toast(`Context at ${context.percent}% — consider /compact`)
    } else if (context.percent < WARN_AT) {
      isWarned = false
    }
  } catch {
    // A failed usage read leaves the last figure up; it never breaks a turn.
  }
}

export const register: Register = on => {
  // The footer's mode labels draw text as given, with no plugin-name prefix.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const text = await read($, label)

    return text === null
      ? next(e)
      : next({ ...e, props: { ...e.props, modes: [...e.props.modes, text] } })
  })

  on('turn.step', async function* ($, e, next) {
    const step = yield* next(e)

    if (e.agentId === undefined) {
      await refresh($)
    }

    return step
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await refresh($)

    return done
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await refresh($)

    return started
  })

  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)

    if (e.agentId === undefined) {
      await refresh($)
    }

    return compacted
  })
}
