import assert from 'node:assert'
import { test } from 'node:test'
import { createMouseParser } from '../src/mouse.ts'

const PRESS = '\x1b[<0;44;12M'
const RELEASE = '\x1b[<0;44;12m'
const WHEEL_UP = '\x1b[<64;10;5M'
const WHEEL_DOWN = '\x1b[<65;10;5M'

test('a whole press sequence in one chunk', () => {
  const parseMouse = createMouseParser()
  const { events, rest } = parseMouse(PRESS)
  assert.deepStrictEqual(events, [{ kind: 'press', col: 44, row: 12 }])
  assert.strictEqual(rest, '')
})

test('a release sequence (m terminator)', () => {
  const parseMouse = createMouseParser()
  const { events, rest } = parseMouse(RELEASE)
  assert.deepStrictEqual(events, [{ kind: 'release', col: 44, row: 12 }])
  assert.strictEqual(rest, '')
})

test('a wheel event with the 64 bit set (up)', () => {
  const parseMouse = createMouseParser()
  const { events, rest } = parseMouse(WHEEL_UP)
  assert.deepStrictEqual(events, [{ kind: 'wheel', col: 10, row: 5, scroll: -1 }])
  assert.strictEqual(rest, '')
})

test('a wheel event with the 64 bit set (down)', () => {
  const parseMouse = createMouseParser()
  const { events, rest } = parseMouse(WHEEL_DOWN)
  assert.deepStrictEqual(events, [{ kind: 'wheel', col: 10, row: 5, scroll: 1 }])
  assert.strictEqual(rest, '')
})

test('plain keystrokes with no mouse bytes pass through untouched', () => {
  const parseMouse = createMouseParser()
  const { events, rest } = parseMouse('hello\r\n')
  assert.deepStrictEqual(events, [])
  assert.strictEqual(rest, 'hello\r\n')
})

test('mouse bytes followed by real typing in the same chunk', () => {
  const parseMouse = createMouseParser()
  const { events, rest } = parseMouse(PRESS + 'hello')
  assert.deepStrictEqual(events, [{ kind: 'press', col: 44, row: 12 }])
  assert.strictEqual(rest, 'hello')
})

test('split after the lone ESC byte', () => {
  const parseMouse = createMouseParser()
  const first = parseMouse('\x1b')
  assert.deepStrictEqual(first.events, [])
  assert.strictEqual(first.rest, '')

  const second = parseMouse('[<0;44;12M')
  assert.deepStrictEqual(second.events, [{ kind: 'press', col: 44, row: 12 }])
  assert.strictEqual(second.rest, '')
})

test('split after the "\\x1b[<" prefix', () => {
  const parseMouse = createMouseParser()
  const first = parseMouse('\x1b[<')
  assert.deepStrictEqual(first.events, [])
  assert.strictEqual(first.rest, '')

  const second = parseMouse('0;44;12M')
  assert.deepStrictEqual(second.events, [{ kind: 'press', col: 44, row: 12 }])
  assert.strictEqual(second.rest, '')
})

test('split mid-digits', () => {
  const parseMouse = createMouseParser()
  const first = parseMouse('\x1b[<0;44;1')
  assert.deepStrictEqual(first.events, [])
  assert.strictEqual(first.rest, '')

  const second = parseMouse('2M')
  assert.deepStrictEqual(second.events, [{ kind: 'press', col: 44, row: 12 }])
  assert.strictEqual(second.rest, '')
})

test('split right before the final terminator byte', () => {
  const parseMouse = createMouseParser()
  const first = parseMouse('\x1b[<0;44;12')
  assert.deepStrictEqual(first.events, [])
  assert.strictEqual(first.rest, '')

  const second = parseMouse('M')
  assert.deepStrictEqual(second.events, [{ kind: 'press', col: 44, row: 12 }])
  assert.strictEqual(second.rest, '')
})

test('a split report does not eat real keystrokes queued after it', () => {
  const parseMouse = createMouseParser()
  const first = parseMouse('\x1b[<0;44;1')
  assert.deepStrictEqual(first.events, [])
  assert.strictEqual(first.rest, '')

  const second = parseMouse('2Mhello')
  assert.deepStrictEqual(second.events, [{ kind: 'press', col: 44, row: 12 }])
  assert.strictEqual(second.rest, 'hello')
})

test('a buffered fragment that turns out not to be a mouse report is flushed as keystrokes', () => {
  const parseMouse = createMouseParser()
  // A lone Escape keypress, not actually the start of a mouse report.
  const first = parseMouse('\x1b')
  assert.deepStrictEqual(first.events, [])
  assert.strictEqual(first.rest, '')

  const second = parseMouse('hello')
  assert.deepStrictEqual(second.events, [])
  assert.strictEqual(second.rest, '\x1bhello')
})

test('an unrelated escape sequence (arrow key) passes through untouched', () => {
  const parseMouse = createMouseParser()
  const { events, rest } = parseMouse('\x1b[Ahello' + PRESS)
  assert.deepStrictEqual(events, [{ kind: 'press', col: 44, row: 12 }])
  assert.strictEqual(rest, '\x1b[Ahello')
})

test('two independent parsers do not share buffered state', () => {
  const a = createMouseParser()
  const b = createMouseParser()
  const first = a('\x1b[<0;44;1')
  assert.deepStrictEqual(first.events, [])
  assert.strictEqual(first.rest, '')

  // b has no pending fragment, so this plain text must pass straight through.
  const { events, rest } = b('typed')
  assert.deepStrictEqual(events, [])
  assert.strictEqual(rest, 'typed')
})
