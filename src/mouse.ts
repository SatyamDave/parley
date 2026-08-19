// Mouse support, so the workspace can be used by pointing at it.
//
// Terminals report mouse activity as escape sequences on the same stdin as
// keystrokes, so this does two jobs: it asks the terminal to start reporting,
// and it pulls those reports back out of the input stream before the remaining
// keystrokes are handed to an agent. Miss the second job and every click
// injects garbage like "[<0;44;12M" into whatever Claude Code is doing.

/**
 * 1000 = report button press and release.
 * 1002 = also report motion while a button is held, which is what makes drag
 *        (press on one pane, release on another) detectable.
 * 1006 = SGR encoding. The original protocol packs coordinates into single
 *        bytes and breaks past column 223; SGR is plain decimal and does not.
 */
const ENABLE = '\x1b[?1000h\x1b[?1002h\x1b[?1006h'
const DISABLE = '\x1b[?1006l\x1b[?1002l\x1b[?1000l'

export type MouseEvent = {
  kind: 'press' | 'drag' | 'release' | 'wheel'
  /** 1-based, as the terminal reports them. */
  col: number
  row: number
  /** Wheel only: -1 up, 1 down. */
  scroll?: number
}

export function enableMouse(out: NodeJS.WriteStream = process.stdout): void {
  out.write(ENABLE)
}

export function disableMouse(out: NodeJS.WriteStream = process.stdout): void {
  out.write(DISABLE)
}

// ESC [ < button ; col ; row (M press/motion | m release), anchored to the
// start of the string being tested.
const SGR = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/

// Matches any prefix of the SGR pattern above, including a bare ESC. Used to
// recognize a report that a chunk boundary cut short, so it can be completed
// once the rest arrives instead of being dropped or leaked as keystrokes.
const SGR_PREFIX = /^\x1b(\[(<(\d*)(;(\d*)(;(\d*)([Mm])?)?)?)?)?$/

/**
 * Create a parser that splits stdin chunks into mouse events and the
 * keystrokes left over. Both are returned because a single read can contain
 * either or both, and dropping the remainder would eat the user's typing.
 *
 * The returned function is stateful: a chunk boundary can land anywhere
 * inside a "\x1b[<...M" report (including right after the lone ESC), so an
 * incomplete fragment is buffered and prefixed onto the next call instead of
 * being lost or falling through to `rest` as garbage. If a buffered fragment
 * turns out not to be heading toward a real report (e.g. it was actually a
 * plain Escape keypress), it is flushed back out as ordinary keystrokes.
 */
export function createMouseParser(): (input: string) => { events: MouseEvent[]; rest: string } {
  let pending = ''

  return function parseMouse(input: string): { events: MouseEvent[]; rest: string } {
    const events: MouseEvent[] = []
    let rest = ''
    let cursor = pending + input
    pending = ''

    while (cursor.length > 0) {
      const at = cursor.indexOf('\x1b')
      if (at < 0) {
        rest += cursor
        break
      }
      rest += cursor.slice(0, at)
      cursor = cursor.slice(at)

      const match = SGR.exec(cursor)
      if (match) {
        const [, rawButton, rawCol, rawRow, terminator] = match
        const button = Number(rawButton)
        const col = Number(rawCol)
        const row = Number(rawRow)

        if (button & 64) {
          events.push({ kind: 'wheel', col, row, scroll: button & 1 ? 1 : -1 })
        } else if (terminator === 'm') {
          events.push({ kind: 'release', col, row })
        } else if (button & 32) {
          events.push({ kind: 'drag', col, row })
        } else {
          events.push({ kind: 'press', col, row })
        }

        cursor = cursor.slice(match[0].length)
        continue
      }

      if (SGR_PREFIX.test(cursor)) {
        // Could still complete once more bytes arrive — hold onto it rather
        // than guessing.
        pending = cursor
        break
      }

      // Starts with ESC but cannot become a mouse report (e.g. an arrow
      // key). Not ours to interpret; pass the byte through as a keystroke
      // and keep scanning the remainder.
      rest += cursor[0]
      cursor = cursor.slice(1)
    }

    return { events, rest }
  }
}

export const parseMouse = createMouseParser()
