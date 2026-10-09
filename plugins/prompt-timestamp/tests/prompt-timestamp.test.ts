import { describe, expect, test } from 'claude-code/testing'

const NOW = Date.UTC(2026, 9, 2, 18, 3, 27)

describe('prompt-timestamp', () => {
  test('prefixes a typed prompt with a timestamp', async ($, on) => {
    let seen = ''
    let origin = ''
    on('clock.now', () => ({ value: NOW }))
    on('prompt.submit', ($, e) => {
      seen = e.text
      origin = e.origin.kind
      return { text: e.text }
    })

    await $.prompt.submit({ text: 'fix the bug', origin: { kind: 'composer' }, wait: false } as any)
    expect(origin).toBe('composer')
    expect(seen).toMatch(/^\[10-02 \d{2}:03 \S+\] fix the bug$/)
  })

  test('leaves non-human prompts alone', async ($, on) => {
    let seen = ''
    let origin = ''
    on('clock.now', () => ({ value: NOW }))
    on('prompt.submit', ($, e) => {
      seen = e.text
      origin = e.origin.kind
      return { text: e.text }
    })

    await $.prompt.submit({ text: 'task done', origin: { kind: 'task-notification' }, wait: false } as any)
    expect(origin).toBe('task-notification')
    expect(seen).toBe('task done')
  })
})
