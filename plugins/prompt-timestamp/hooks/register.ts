import type { Register } from 'claude-code'

// Only stamp prompts a person typed: the terminal, or Remote Control.
const HUMAN_ORIGINS = new Set(['composer', 'bridge'])

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    if (!HUMAN_ORIGINS.has(e.origin.kind) || e.text.trim() === '') {
      return next(e)
    }

    const stamp = formatStamp(await $.clock.now())

    return next({ ...e, text: `[${stamp}] ${e.text}` })
  })
}

// "10-02 14:03 EDT" in the machine's local time zone.
export function formatStamp(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).formatToParts(new Date(ms))
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(p => p.type === type)?.value ?? ''

  return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')} ${get('timeZoneName')}`
}
