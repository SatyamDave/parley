// Run a single test file with: node --test test/layout.test.ts
// Run all tests: npm test
// Run with watch mode: npm run test:watch

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rowsFor, grid, paneAt, paneCapacity } from '../src/layout.ts'

test('rowsFor: returns correct row distributions', () => {
  assert.deepEqual(rowsFor(1), [1])
  assert.deepEqual(rowsFor(2), [2])
  assert.deepEqual(rowsFor(3), [2, 1])
  assert.deepEqual(rowsFor(4), [2, 2])
  assert.deepEqual(rowsFor(5), [3, 2])
  assert.deepEqual(rowsFor(6), [3, 3])
})

test('rowsFor(7): three per row with remainder', () => {
  const rows = rowsFor(7)
  assert.deepEqual(rows, [3, 3, 1])
})

test('rowsFor(8): three per row distributes evenly', () => {
  const rows = rowsFor(8)
  assert.deepEqual(rows, [3, 3, 2])
})

test('rowsFor: row counts sum to n for n=1..8', () => {
  for (let n = 1; n <= 8; n++) {
    const rows = rowsFor(n)
    const sum = rows.reduce((a, b) => a + b, 0)
    assert.equal(sum, n, `rowsFor(${n}) should sum to ${n}, got ${sum}`)
  }
})

test('grid: returns exactly count cells', () => {
  for (let count = 1; count <= 8; count++) {
    const { cells } = grid(count, 200, 100)
    assert.equal(cells.length, count, `grid(${count}) should return ${count} cells`)
  }
})

test('grid: empty when count <= 0', () => {
  assert.deepEqual(grid(0, 200, 100), { cells: [], rowHeights: [] })
  assert.deepEqual(grid(-1, 200, 100), { cells: [], rowHeights: [] })
})

test('grid: all cells have index 0..count-1', () => {
  for (let count = 1; count <= 8; count++) {
    const { cells } = grid(count, 200, 100)
    const indices = cells.map((c) => c.index).sort((a, b) => a - b)
    assert.deepEqual(indices, Array.from({ length: count }, (_, i) => i))
  }
})

test('grid: no cell has cols < 20 or rows < 3', () => {
  for (let count = 1; count <= 8; count++) {
    const { cells } = grid(count, 200, 100)
    for (const cell of cells) {
      assert(cell.cols >= 20, `Cell ${cell.index} has cols=${cell.cols} < 20`)
      assert(cell.rows >= 3, `Cell ${cell.index} has rows=${cell.rows} < 3`)
    }
  }
})

test('grid: cells within a row do not overlap horizontally', () => {
  for (let count = 1; count <= 8; count++) {
    const { cells } = grid(count, 200, 100)
    const rows = new Map<number, typeof cells>()
    for (const cell of cells) {
      if (!rows.has(cell.row)) rows.set(cell.row, [])
      rows.get(cell.row)!.push(cell)
    }
    for (const rowCells of rows.values()) {
      for (let i = 0; i < rowCells.length; i++) {
        for (let j = i + 1; j < rowCells.length; j++) {
          const a = rowCells[i]
          const b = rowCells[j]
          const a_end = a.x + a.cols + 2
          const b_end = b.x + b.cols + 2
          assert(a_end <= b.x || b_end <= a.x, `Cells ${a.index} and ${b.index} overlap`)
        }
      }
    }
  }
})

test('grid: x-offsets plus widths tile full width with no gap', () => {
  const width = 200
  for (let count = 1; count <= 8; count++) {
    const { cells, rowHeights } = grid(count, width, 100)
    const rows = new Map<number, typeof cells>()
    for (const cell of cells) {
      if (!rows.has(cell.row)) rows.set(cell.row, [])
      rows.get(cell.row)!.push(cell)
    }
    for (const rowCells of rows.values()) {
      const sorted = rowCells.sort((a, b) => a.x - b.x)
      let expectedX = 0
      for (const cell of sorted) {
        assert.equal(cell.x, expectedX, `Cell ${cell.index} x offset mismatch`)
        expectedX += cell.cols + 2
      }
      assert.equal(expectedX, width, `Row does not fill full width: ${expectedX} !== ${width}`)
    }
  }
})

test('paneAt: round-trip for cells', () => {
  for (let count = 1; count <= 8; count++) {
    const geometry = grid(count, 200, 100)
    for (const cell of geometry.cells) {
      // Click in the interior
      const x = cell.x + (cell.cols + 2) / 2
      const y = cell.y + (cell.rows + 2) / 2
      const result = paneAt(geometry, x, y)
      assert.equal(result, cell.index, `Interior click at (${x},${y}) should map to cell ${cell.index}`)
    }
  }
})

test('paneAt: returns -1 for points above grid', () => {
  const geometry = grid(3, 200, 100)
  assert.equal(paneAt(geometry, 50, -1), -1)
  assert.equal(paneAt(geometry, 100, -10), -1)
})

test('paneAt: returns -1 for points past right edge', () => {
  const geometry = grid(3, 200, 100)
  assert.equal(paneAt(geometry, 200, 50), -1)
  assert.equal(paneAt(geometry, 300, 50), -1)
})

test('paneAt: click on pane border is inside that pane', () => {
  const geometry = grid(3, 200, 100)
  const cell = geometry.cells[0]
  // Click on the outer border (at x coordinate of the pane)
  const result = paneAt(geometry, cell.x, cell.y)
  assert.equal(result, cell.index, `Click on pane border should be inside the pane`)
})

test('paneCapacity: monotonic - growing terminal never decreases capacity', () => {
  for (let w = 50; w <= 300; w += 10) {
    for (let h = 20; h <= 100; h += 5) {
      const cap1 = paneCapacity(w, h)
      const cap2 = paneCapacity(w + 10, h)
      const cap3 = paneCapacity(w, h + 5)
      assert(cap2 >= cap1, `Capacity decreased when width increased: ${w}x${h}=${cap1} > ${w + 10}x${h}=${cap2}`)
      assert(cap3 >= cap1, `Capacity decreased when height increased: ${w}x${h}=${cap1} > ${w}x${h + 5}=${cap3}`)
    }
  }
})

test('paneCapacity: returns at least 1 for small sizes', () => {
  for (let w = 20; w <= 100; w += 10) {
    for (let h = 9; h <= 50; h += 5) {
      const capacity = paneCapacity(w, h)
      assert(capacity >= 1, `paneCapacity(${w}, ${h}) returned ${capacity} < 1`)
    }
  }
})

test('paneCapacity: realistic sizes', () => {
  // 80x24 terminal
  const small = paneCapacity(80, 24)
  assert(small >= 1)

  // 200x50 terminal
  const medium = paneCapacity(200, 50)
  assert(medium >= small, 'Larger terminal should fit at least as many panes')

  // 300x100 terminal
  const large = paneCapacity(300, 100)
  assert(large >= medium, 'Even larger terminal should fit at least as many panes')
})
