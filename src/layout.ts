// Where each agent pane goes on screen.
//
// Kept apart from the TUI and free of Ink, ptys, and React so the geometry can
// be checked directly — a layout bug shows up as a pty sized wrong, which looks
// like Claude Code rendering badly and sends you hunting in the wrong file.

export type Cell = {
  index: number
  /** Interior size, in character cells: what the pty and xterm are sized to. */
  cols: number
  rows: number
  /** Top-left of the pane's outer box, relative to the grid's own origin.
   *  Carried so a mouse click can be turned back into "which pane is that". */
  x: number
  y: number
  /** Row of the grid this pane sits in, and whether it ends that row. */
  row: number
  lastInRow: boolean
}

/**
 * Rows of panes, widest-first, so three agents read as two-over-one rather than
 * a 2x2 with a hole in it. Beyond six the grid stops growing and panes get
 * shorter instead — past that the useful move is another workspace, not another
 * row of terminals too small to read.
 */
export function rowsFor(count: number): number[] {
  if (count <= 1) return [1]
  if (count === 2) return [2]
  if (count === 3) return [2, 1]
  if (count === 4) return [2, 2]
  if (count === 5) return [3, 2]
  if (count === 6) return [3, 3]
  const perRow = Math.ceil(count / 3)
  return [perRow, perRow, count - 2 * perRow].filter((n) => n > 0)
}

/**
 * Split `width` into `n` whole columns, giving the remainder to the leftmost
 * panes. Rounding down uniformly would leave a ragged gap on the right edge.
 */
function share(total: number, n: number): number[] {
  const base = Math.floor(total / n)
  const extra = total - base * n
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0))
}

export type Geometry = { cells: Cell[]; rowHeights: number[] }

/**
 * `width`/`height` are the space available to the agent grid as a whole. Each
 * pane spends 2 columns and 2 rows of that on its own border, so the interior
 * numbers returned here are what the pty should actually be told.
 */
export function grid(count: number, width: number, height: number): Geometry {
  if (count <= 0) return { cells: [], rowHeights: [] }

  const rows = rowsFor(count)
  const rowHeights = share(height, rows.length)
  const cells: Cell[] = []

  let index = 0
  let y = 0
  rows.forEach((perRow, row) => {
    const widths = share(width, perRow)
    let x = 0
    for (let i = 0; i < perRow && index < count; i++) {
      cells.push({
        index,
        // Never hand a pty a non-positive size — some terminals abort on it.
        cols: Math.max(20, widths[i] - 2),
        rows: Math.max(3, rowHeights[row] - 2),
        x,
        y,
        row,
        lastInRow: i === perRow - 1 || index === count - 1,
      })
      x += widths[i]
      index++
    }
    y += rowHeights[row]
  })

  return { cells, rowHeights }
}

/**
 * Which pane covers this point, or -1. Coordinates are relative to the grid's
 * own origin, so the caller subtracts whatever chrome sits above it first.
 */
export function paneAt(geometry: Geometry, x: number, y: number): number {
  for (const cell of geometry.cells) {
    const w = cell.cols + 2
    const hgt = cell.rows + 2
    if (x >= cell.x && x < cell.x + w && y >= cell.y && y < cell.y + hgt) return cell.index
  }
  return -1
}

/**
 * How many panes this terminal can show and still have each one readable. This
 * replaces an arbitrary agent cap: the real constraint was always the screen,
 * and a limit you can see the reason for needs no explaining.
 */
export function paneCapacity(width: number, height: number): number {
  const MIN_COLS = 46
  const MIN_ROWS = 9
  for (let n = 8; n >= 1; n--) {
    const { cells } = grid(n, width, height)
    if (cells.every((c) => c.cols >= MIN_COLS && c.rows >= MIN_ROWS)) return n
  }
  return 1
}
