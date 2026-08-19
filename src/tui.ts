// The workspace.
//
// There are no modes. Whatever you clicked last has focus, and everything you
// type goes there — into an agent's terminal, or into the goal bar. Dragging
// from one pane to another links them. That is the whole interface; the earlier
// version had four modes and ten shortcuts and was worse for it.
//
// No JSX anywhere — Node strips types natively but does not transform JSX, and
// h() keeps this a zero-build-step program.
import React from 'react'
import { Box, Text, render, useApp, useStdin } from 'ink'
import xterm from '@xterm/headless'
import type { IBufferCell } from '@xterm/headless'
import pty from 'node-pty'
import type { IPty } from 'node-pty'
import { spawn as spawnProcess } from 'node:child_process'
import { join } from 'node:path'
import { PERSONAS, allPersonas, persona } from './personas.ts'
import type { Persona } from './personas.ts'
import { SRC, isProjectTrusted, planAgent } from './spawn.ts'
import { dispatchTick } from './dispatch.ts'
import type { Fleet, Runner } from './dispatch.ts'
import type { ProposedAgent } from './planner.ts'
import { grid, paneAt, paneCapacity } from './layout.ts'
import { disableMouse, enableMouse, parseMouse } from './mouse.ts'
import {
  addCustomPersona,
  agents,
  decisions,
  depsOf,
  drainIntents,
  dropAgent,
  getProposal,
  joinAgent,
  latestPendingProposal,
  link,
  links,
  nextInstanceId,
  post,
  projectRoot,
  pruneLinks,
  reapDeadAgents,
  tasks,
  unlink,
  updateProposal,
  waiting,
  wip,
} from './store.ts'
import { ago, renderGraph } from './render.ts'
import { scanWip } from './watch.ts'

const h = React.createElement
const { useEffect, useRef, useState } = React

// @xterm/headless is CommonJS — a named import throws under Node's ESM loader.
const { Terminal } = xterm
type XTerm = InstanceType<typeof Terminal>

type Pane = {
  id: string
  p: Persona
  model: string
  pty: IPty
  term: XTerm
  alive: boolean
  /** Rows scrolled back from the live tail. 0 means following new output. */
  scroll: number
}

export type TuiOptions = { permissionMode?: string; model?: string; auto?: boolean }

type View = 'board' | 'graph' | 'links' | 'propose' | 'picker'
/** Cycled with ctrl-v. `propose` and `picker` are entered/left by their own
 *  triggers (submitting a goal, ctrl-a, approving) rather than by cycling. */
const CYCLE_VIEWS: View[] = ['board', 'graph', 'links']

type CustomFormState = { stage: 'title' | 'oneliner' | 'prompt'; title: string; oneliner: string }
type PickerRow = { id: string; title: string; desc: string }

/** Plain-language yes: an empty reply or a short affirmative approves a
 *  proposal as-is. Anything else is treated as a refinement to send back. */
const AFFIRM = new Set(['', 'y', 'yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'approve', 'go', 'do it', 'lgtm', 'looks good'])

/** Rows of chrome above the agent grid, so a click can be mapped to a pane. */
const HEADER_ROWS = 1

/**
 * The character cells actually painted inside a pane's border, which is what
 * the pty and the xterm buffer must be sized to. A cell from `grid()` describes
 * the box interior — the box spends one of those rows on its own title bar, and
 * nothing else (no padding) eats into the width. Everything that resizes a pty
 * or renders a pane goes through here, so the two cannot drift apart.
 */
function interior(cell: { cols: number; rows: number }): { cols: number; rows: number } {
  return { cols: cell.cols, rows: Math.max(1, cell.rows - 1) }
}

/**
 * The SGR sequence that reproduces one xterm cell's colors and attributes.
 * Claude Code's whole interface is color, so rendering the buffer with
 * `translateToString` (which throws the attributes away) is not "a slightly
 * plainer pane", it is a different program.
 */
function sgrOf(cell: IBufferCell): string {
  const codes: number[] = []
  if (cell.isBold()) codes.push(1)
  if (cell.isDim()) codes.push(2)
  if (cell.isItalic()) codes.push(3)
  if (cell.isUnderline()) codes.push(4)
  if (cell.isInverse()) codes.push(7)
  if (cell.isStrikethrough()) codes.push(9)
  if (cell.isFgRGB()) {
    const c = cell.getFgColor()
    codes.push(38, 2, (c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff)
  } else if (cell.isFgPalette()) {
    codes.push(38, 5, cell.getFgColor())
  }
  if (cell.isBgRGB()) {
    const c = cell.getBgColor()
    codes.push(48, 2, (c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff)
  } else if (cell.isBgPalette()) {
    codes.push(48, 5, cell.getBgColor())
  }
  return codes.length ? `\x1b[${codes.join(';')}m` : ''
}

/**
 * `rows` lines of the pane's screen, each carrying its own colors, ending
 * `scroll` rows above the live tail. Ink passes a string child through
 * untouched and measures it with ANSI-aware width, so embedded SGR survives.
 */
function paneLines(term: XTerm, rows: number, cols: number, scroll = 0): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  const tail = Math.max(0, buf.baseY + buf.cursorY - rows + 1)
  const start = Math.max(0, tail - Math.max(0, scroll))
  const probe = buf.getNullCell()
  for (let i = start; i < start + rows; i++) {
    const line = buf.getLine(i)
    if (!line) {
      out.push('')
      continue
    }
    let text = ''
    let style = ''
    let width = 0
    for (let x = 0; x < line.length && width < cols; x++) {
      const cell = line.getCell(x, probe)
      if (!cell) break
      const w = cell.getWidth()
      if (w === 0) continue // trailing half of a wide character
      if (width + w > cols) break
      const next = sgrOf(cell)
      if (next !== style) {
        // Reset first: dropping an attribute has no code of its own.
        text += next ? `\x1b[0m${next}` : '\x1b[0m'
        style = next
      }
      text += cell.getChars() || ' '
      width += w
    }
    out.push(style ? `${text}\x1b[0m` : text.trimEnd())
  }
  return out
}

/** How far back this pane's buffer can be scrolled, given its visible height. */
function maxScroll(term: XTerm, rows: number): number {
  const buf = term.buffer.active
  return Math.max(0, buf.baseY + buf.cursorY - rows + 1)
}

/**
 * A pty with no window size set reports 0, not undefined — `?? 100` sails right
 * past that and every pane collapses to a two-character sliver.
 */
function termSize(): { cols: number; rows: number } {
  return {
    cols: Math.max(60, process.stdout.columns || 100),
    rows: Math.max(18, process.stdout.rows || 30),
  }
}

function statusColor(status: string): string {
  if (status === 'working') return 'green'
  if (status === 'blocked') return 'red'
  if (status === 'starting') return 'yellow'
  return 'gray'
}

function App({ roster, permissionMode, model, auto = false }: { roster: string[] } & TuiOptions) {
  const { exit } = useApp()
  const { stdin, setRawMode } = useStdin()
  const panes = useRef<Pane[]>([])
  const [, setTick] = useState(0)
  /** -1 means the goal bar has focus; otherwise the index of a pane. */
  const [focus, setFocus] = useState(-1)
  const [goalText, setGoalText] = useState('')
  const [dragFrom, setDragFrom] = useState(-1)
  const [flash, setFlash] = useState('')
  const [view, setView] = useState<View>('board')
  const [size, setSize] = useState(termSize())
  /** The proposal currently shown in the `propose` view, and the goal it's
   *  for — null/empty once approved or cancelled. */
  const [proposalId, setProposalId] = useState<number | null>(null)
  const [pendingGoal, setPendingGoal] = useState('')
  const [pickerIndex, setPickerIndex] = useState(0)
  const [customForm, setCustomForm] = useState<CustomFormState | null>(null)

  const TOP = Math.max(6, Math.min(10, Math.floor(size.rows * 0.24)))
  const topRows = TOP + 2
  const gridTop = HEADER_ROWS + topRows
  const gridHeight = Math.max(6, size.rows - gridTop - 2)
  const gridWidth = size.cols
  const capacity = paneCapacity(gridWidth, gridHeight)

  const say = (msg: string) => setFlash(msg)

  // Reassigned every render so long-lived callers (the dispatcher's Fleet, the
  // input handler) never hold a stale closure over terminal geometry.
  const geo = useRef({ width: gridWidth, height: gridHeight, top: gridTop, capacity })
  geo.current = { width: gridWidth, height: gridHeight, top: gridTop, capacity }

  // Same reason: the slow tick below is set up once ([] deps) and needs to
  // see whichever goal is currently awaiting its proposal, not the value at
  // the moment the interval was created.
  const proposeRef = useRef({ proposalId, pendingGoal })
  proposeRef.current = { proposalId, pendingGoal }

  const relayout = useRef<() => void>(() => {})
  relayout.current = () => {
    const { cells } = grid(panes.current.length, geo.current.width, geo.current.height)
    cells.forEach((cell) => {
      const pane = panes.current[cell.index]
      if (!pane) return
      const iv = interior(cell)
      try {
        pane.pty.resize(iv.cols, iv.rows)
        pane.term.resize(iv.cols, iv.rows)
      } catch {
        /* pane died mid-resize */
      }
    })
  }

  const startAgent = useRef<(personaId: string, modelOverride?: string) => Pane | null>(() => null)
  startAgent.current = (personaId, modelOverride) => {
    if (panes.current.length >= geo.current.capacity) {
      say(`no room — this terminal fits ${geo.current.capacity}. Make the window bigger, or close one.`)
      return null
    }
    let p: Persona
    try {
      p = persona(personaId)
    } catch {
      say(`no such role: ${personaId}`)
      return null
    }
    const id = nextInstanceId(p.id)
    const plan = planAgent(id, p, { permissionMode, model: modelOverride || model })
    const { cells } = grid(panes.current.length + 1, geo.current.width, geo.current.height)
    const iv = interior(cells[cells.length - 1])
    let child: IPty
    try {
      child = pty.spawn(plan.file, plan.args, {
        name: 'xterm-256color',
        cols: iv.cols,
        rows: iv.rows,
        cwd: plan.cwd,
        env: plan.env,
      })
    } catch (err) {
      say(`could not start ${id}: ${err instanceof Error ? err.message : err}`)
      return null
    }
    const term = new Terminal({ cols: iv.cols, rows: iv.rows, allowProposedApi: true, scrollback: 2000 })
    const pane: Pane = { id, p, model: plan.model, pty: child, term, alive: true, scroll: 0 }
    child.onData((d) => {
      term.write(d)
      // New output snaps the pane back to the live tail — otherwise a pane you
      // scrolled once would sit frozen while its agent kept working.
      pane.scroll = 0
    })
    child.onExit(() => {
      pane.alive = false
      dropAgent(id)
      panes.current = panes.current.filter((x) => x.id !== id)
      pruneLinks()
      relayout.current()
    })
    // 'starting', not 'idle': the dispatcher must not type into this terminal
    // until Claude Code's SessionStart hook says it is actually listening.
    joinAgent(id, p.id, child.pid, 'starting')
    panes.current.push(pane)
    relayout.current()
    return pane
  }

  const stopAgent = useRef<(id: string) => void>(() => {})
  stopAgent.current = (id) => {
    const pane = panes.current.find((x) => x.id === id)
    if (!pane) return
    try {
      pane.pty.kill()
    } catch {
      /* already gone */
    }
    pane.alive = false
    dropAgent(id)
    unlink(id)
    panes.current = panes.current.filter((x) => x.id !== id)
    setFocus((f) => (f >= panes.current.length ? panes.current.length - 1 : f))
    relayout.current()
    say(`closed ${id}`)
  }

  /** Same one-line filter list the picker renders and the picker's own Enter
   *  handler resolves against, so what you see is always what you get. */
  const pickerList = (query: string): PickerRow[] => {
    const q = query.trim().toLowerCase()
    const rows: PickerRow[] = allPersonas()
      .filter((p) => !q || p.id.includes(q) || p.title.toLowerCase().includes(q) || p.labels.some((l) => l.includes(q)))
      .map((p) => ({ id: p.id, title: p.title, desc: p.labels.join(', ') }))
    rows.push({ id: '__custom__', title: '+ custom...', desc: 'define a new one-off agent' })
    return rows
  }

  const slugify = (title: string): string => {
    const base = title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'
    const taken = new Set(allPersonas().map((p) => p.id))
    if (!taken.has(base)) return base
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  }

  const CUSTOM_COLORS = ['blue', 'yellow', 'red', 'green', 'magenta', 'cyan']

  const startPropose = useRef<(text: string) => void>(() => {})
  startPropose.current = (text) => {
    if (!text.trim()) return
    // Deciding a team is a real model call and can take a few seconds;
    // blocking the render loop would freeze every pane. Same detached
    // pattern as the actual decomposition below — the slow tick polls the
    // board for the result once it lands.
    spawnProcess('node', [join(SRC, 'cli.ts'), 'propose', text], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    }).unref()
    setPendingGoal(text)
    setProposalId(null)
    setGoalText('')
    setView('propose')
    say('thinking about who should work on this...')
  }

  const decideProposal = useRef<(reply: string) => void>(() => {})
  decideProposal.current = (reply) => {
    if (proposalId === null) return
    if (AFFIRM.has(reply.trim().toLowerCase())) {
      const row = getProposal(proposalId)
      if (!row) return
      const proposed = JSON.parse(row.agents_json) as ProposedAgent[]
      const ids = proposed.map((a) => (a.kind === 'existing' ? a.personaId : a.customId)).filter(Boolean)
      updateProposal(proposalId, { status: 'approved' })
      // The real decomposition, scoped to just the approved roster. Same
      // detached pattern as propose above.
      spawnProcess('node', [join(SRC, 'cli.ts'), 'goal', pendingGoal, '--roster', ids.join(',')], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      }).unref()
      setProposalId(null)
      setPendingGoal('')
      setGoalText('')
      setView('board')
      say(
        auto
          ? 'approved — spinning up the team and getting started'
          : 'approved — tasks will appear on the board once planning finishes. Auto-dispatch is off; restart with --auto to have them start themselves',
      )
      return
    }
    // Anything else is the human redirecting the proposal in their own
    // words — re-propose with their reply as context, replacing the same row.
    spawnProcess('node', [join(SRC, 'cli.ts'), 'propose', pendingGoal, '--refine', String(proposalId), '--reply', reply], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    }).unref()
    setGoalText('')
    say('revising the plan...')
  }

  const finishCustomForm = useRef<(promptText: string) => void>(() => {})
  finishCustomForm.current = (promptText) => {
    if (!customForm) return
    const id = slugify(customForm.title)
    const words = `${customForm.title} ${customForm.oneliner}`.toLowerCase().split(/\W+/).filter((w) => w.length > 3)
    addCustomPersona({
      id,
      title: customForm.title || id,
      color: CUSTOM_COLORS[(allPersonas().length - PERSONAS.length) % CUSTOM_COLORS.length],
      labels: Array.from(new Set(words)).slice(0, 6).join(','),
      model: '',
      prompt: `You are ${customForm.title || id}. ${customForm.oneliner}\n\n${promptText}`,
    })
    setCustomForm(null)
    setGoalText('')
    setPickerIndex(0)
    startAgent.current(id)
    setView('board')
    say(`${id} added to the library and spun up`)
  }

  // --- lifecycle -----------------------------------------------------------

  useEffect(() => {
    for (const id of roster) startAgent.current(id)
    post('parley', 'note', `session up: ${panes.current.map((x) => x.id).join(', ')}`)
    enableMouse()
    const off = () => disableMouse()
    process.on('exit', off)
    return () => {
      disableMouse()
      process.off('exit', off)
      for (const pane of panes.current) {
        try {
          pane.pty.kill()
        } catch {
          /* already gone */
        }
        dropAgent(pane.id)
      }
    }
  }, [])

  useEffect(() => {
    const fleet: Fleet = {
      runners: () =>
        panes.current.map(
          (x): Runner => ({
            id: x.id,
            persona: x.p,
            model: x.model,
            alive: x.alive,
            write: (input) => x.pty.write(input),
          }),
        ),
      spawn: (p, tier) => {
        const pane = startAgent.current(p.id, tier)
        if (!pane) return null
        return {
          id: pane.id,
          persona: pane.p,
          model: pane.model,
          alive: pane.alive,
          write: (input) => pane.pty.write(input),
        }
      },
    }

    const paint = setInterval(() => setTick((t) => t + 1), 90)
    const slow = setInterval(() => {
      try {
        scanWip()
      } catch {
        /* not a git repo, or git is busy — try again next tick */
      }
      for (const intent of drainIntents()) {
        if (intent.kind === 'add') startAgent.current(intent.arg, intent.extra)
        else if (intent.kind === 'kill') stopAgent.current(intent.arg)
      }
      // Once the detached `propose` call lands its row, latch its id — the
      // paint tick's own render reads that row live from here on (including
      // through refinements, which update the same row), so no further
      // polling is needed for it.
      if (proposeRef.current.pendingGoal && proposeRef.current.proposalId === null) {
        const row = latestPendingProposal()
        if (row && row.goal === proposeRef.current.pendingGoal) setProposalId(row.id)
      }
      if (auto) {
        try {
          dispatchTick(fleet)
        } catch {
          /* a bad tick must never take the whole session down */
        }
      }
    }, 3000)

    const onResize = () => setSize(termSize())
    process.stdout.on('resize', onResize)
    return () => {
      clearInterval(paint)
      clearInterval(slow)
      process.stdout.off('resize', onResize)
    }
  }, [])

  useEffect(() => {
    relayout.current()
  }, [gridWidth, gridHeight])

  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(''), 5000)
    return () => clearTimeout(t)
  }, [flash])

  // --- input ---------------------------------------------------------------

  useEffect(() => {
    setRawMode?.(true)

    const clickable = () => {
      // Where the "+ role" buttons sit on the header line, recomputed the same
      // way the header renders them so hit boxes cannot drift from the labels.
      const spots: { from: number; to: number; id: string }[] = []
      let x = ADD_LABEL.length
      for (const p of PERSONAS) {
        const label = ` +${p.id} `
        spots.push({ from: x, to: x + label.length, id: p.id })
        x += label.length
      }
      spots.push({ from: x, to: x + PICKER_LABEL.length, id: '__picker__' })
      return spots
    }

    const onData = (data: Buffer) => {
      const { events, rest } = parseMouse(data.toString('utf8'))

      for (const ev of events) {
        const gy = ev.row - 1 - geo.current.top
        const gx = ev.col - 1
        const geometry = grid(panes.current.length, geo.current.width, geo.current.height)
        const hit = gy >= 0 ? paneAt(geometry, gx, gy) : -1

        if (ev.kind === 'wheel') {
          // Scrollback is the only way to read what an agent said thirty lines
          // ago, so the wheel walks the pane's own buffer rather than doing
          // nothing. Three lines a notch, the usual terminal step.
          if (hit < 0) continue
          const pane = panes.current[hit]
          const cell = geometry.cells.find((c) => c.index === hit)
          if (!pane || !cell) continue
          const rows = interior(cell).rows
          pane.scroll = Math.max(0, Math.min(maxScroll(pane.term, rows), pane.scroll - (ev.scroll ?? 0) * 3))
          continue
        }

        if (ev.kind === 'press') {
          if (ev.row === 1) {
            // Header: the + buttons, then the goal bar is everything else.
            const spot = clickable().find((s) => gx >= s.from && gx < s.to)
            if (spot) {
              if (spot.id === '__picker__') {
                setView('picker')
                setGoalText('')
                setPickerIndex(0)
                setCustomForm(null)
              } else {
                startAgent.current(spot.id)
              }
              continue
            }
          }
          if (gy >= 0 && hit >= 0) {
            // Clicking the x in a pane's title bar closes it.
            const cell = geometry.cells.find((c) => c.index === hit)!
            const closeCol = cell.x + cell.cols
            if (gy === cell.y + 1 && gx >= closeCol - 1 && gx <= closeCol + 1) {
              stopAgent.current(panes.current[hit].id)
              continue
            }
            panes.current[hit].scroll = 0 // clicking into a pane returns it to live
            setFocus(hit)
            setDragFrom(hit)
            continue
          }
          // Anywhere in the chrome that is not a button: type a goal.
          setFocus(-1)
          setDragFrom(-1)
          continue
        }

        if (ev.kind === 'release') {
          if (dragFrom >= 0 && hit >= 0 && hit !== dragFrom) {
            const from = panes.current[dragFrom]
            const to = panes.current[hit]
            if (from && to) {
              link(from.id, to.id)
              say(`${from.id} feeds ${to.id} — work flows that way, messages both ways`)
            }
          }
          setDragFrom(-1)
          continue
        }
      }

      if (!rest) return

      // ctrl-q always quits, from anywhere. It is the one global key, chosen
      // because Claude Code does not use it and ctrl-c belongs to the agent.
      if (rest.includes('\x11')) return exit()

      if (focus === -1) {
        if (view === 'propose') {
          if (rest === '\r' || rest === '\n') {
            if (proposalId !== null) decideProposal.current(goalText)
            return
          }
          if (rest === '\x7f' || rest === '\b') return setGoalText((g) => g.slice(0, -1))
          if (rest === '\x1b') {
            if (proposalId !== null) updateProposal(proposalId, { status: 'cancelled' })
            setProposalId(null)
            setPendingGoal('')
            setGoalText('')
            setView('board')
            say('cancelled')
            return
          }
          if (rest >= ' ' && !rest.startsWith('\x1b')) return setGoalText((g) => g + rest)
          return
        }

        if (view === 'picker') {
          if (customForm) {
            // A 3-stage inline form: title, one-line description, system
            // prompt — Enter advances a stage; Escape backs out to the list
            // (not all the way out of the picker).
            if (rest === '\r' || rest === '\n') {
              if (customForm.stage === 'title') {
                if (!goalText.trim()) return
                setCustomForm({ ...customForm, stage: 'oneliner', title: goalText.trim() })
                setGoalText('')
                return
              }
              if (customForm.stage === 'oneliner') {
                setCustomForm({ ...customForm, stage: 'prompt', oneliner: goalText.trim() })
                setGoalText('')
                return
              }
              finishCustomForm.current(goalText.trim())
              return
            }
            if (rest === '\x7f' || rest === '\b') return setGoalText((g) => g.slice(0, -1))
            if (rest === '\x1b') {
              setCustomForm(null)
              setGoalText('')
              return
            }
            if (rest >= ' ' && !rest.startsWith('\x1b')) return setGoalText((g) => g + rest)
            return
          }

          if (rest === '\x1b[A') return setPickerIndex((i) => Math.max(0, i - 1))
          if (rest === '\x1b[B') return setPickerIndex((i) => Math.min(pickerList(goalText).length - 1, i + 1))
          if (rest === '\r' || rest === '\n') {
            const rows = pickerList(goalText)
            const chosen = rows[Math.min(pickerIndex, rows.length - 1)]
            if (!chosen) return
            if (chosen.id === '__custom__') {
              setCustomForm({ stage: 'title', title: '', oneliner: '' })
              setGoalText('')
              return
            }
            startAgent.current(chosen.id)
            setView('board')
            setGoalText('')
            setPickerIndex(0)
            return
          }
          if (rest === '\x7f' || rest === '\b') return setGoalText((g) => g.slice(0, -1))
          if (rest === '\x1b') {
            setView('board')
            setGoalText('')
            setPickerIndex(0)
            return
          }
          if (rest >= ' ' && !rest.startsWith('\x1b')) {
            setGoalText((g) => g + rest)
            setPickerIndex(0)
            return
          }
          return
        }

        // board / graph / links
        if (rest === '\x16') {
          // ctrl-v: cycle the read-only views.
          const i = CYCLE_VIEWS.indexOf(view)
          setView(CYCLE_VIEWS[(i + 1) % CYCLE_VIEWS.length])
          return
        }
        if (rest === '\x01') {
          // ctrl-a: open the add-agent picker (mirrors clicking "agents…").
          setView('picker')
          setGoalText('')
          setPickerIndex(0)
          setCustomForm(null)
          return
        }
        if (rest === '\r' || rest === '\n') return startPropose.current(goalText)
        if (rest === '\x7f' || rest === '\b') return setGoalText((g) => g.slice(0, -1))
        if (rest === '\t') return setFocus(panes.current.length ? 0 : -1)
        if (rest === '\x1b') return setGoalText('')
        if (rest >= ' ' && !rest.startsWith('\x1b')) return setGoalText((g) => g + rest)
        return
      }

      // Everything else goes straight to the focused agent, untouched. Tab is
      // the exception: it moves between panes rather than into Claude Code,
      // which is the only key this layer steals.
      if (rest === '\t') {
        const next = focus + 1
        return setFocus(next >= panes.current.length ? -1 : next)
      }
      panes.current[focus]?.pty.write(rest)
    }

    stdin?.on('data', onData)
    return () => {
      stdin?.off('data', onData)
    }
  }, [focus, goalText, dragFrom, stdin, setRawMode, exit, view, proposalId, pendingGoal, pickerIndex, customForm])

  // --- render --------------------------------------------------------------

  const roles = agents()
  const wires = links()
  // Decisions/findings/blocked-reasons only — the curated, plain-language
  // subset of the feed, not the raw dispatch/status-change log. This panel
  // used to show the raw feed as a separate "ACTIVITY" list alongside an
  // "explain" view that showed this same data; now there's just one of them.
  const happenings = decisions(TOP).slice(0, Math.max(3, TOP - 1))
  const dirty = wip().filter((w) => w.files.trim())
  const live = panes.current
  const geometry = grid(live.length, gridWidth, gridHeight)
  const { cells, rowHeights } = geometry
  const stalled = roles.filter((a) => a.status === 'starting' && Date.now() - a.started_at > 20_000)

  const byRow: number[][] = []
  for (const cell of cells) (byRow[cell.row] ??= []).push(cell.index)

  const viewBody = (): React.ReactNode => {
    if (view === 'propose') {
      if (proposalId === null) return h(Text, { dimColor: true }, 'thinking about who should work on this...')
      const row = getProposal(proposalId)
      if (!row) return h(Text, { dimColor: true }, 'thinking about who should work on this...')
      const proposed = JSON.parse(row.agents_json) as ProposedAgent[]
      const lines: React.ReactNode[] = []
      // A one-line answer to a question you asked instead of a revision —
      // shown ahead of the plan so it reads as a reply, not buried in it.
      if (row.answer) {
        lines.push(h(Text, { key: 'answer', wrap: 'truncate' }, h(Text, { color: 'yellow', bold: true }, 'A: '), row.answer))
      }
      lines.push(h(Text, { key: 'note', wrap: 'truncate' }, row.note))
      // One line per agent, same rule as every other view in this app — a
      // box has a fixed height, and wrapping without a cap is how the plan
      // used to overflow the box and run into whatever sits below it.
      proposed.slice(0, Math.max(1, TOP - 2 - lines.length)).forEach((a, i) => {
        const title =
          a.kind === 'existing' ? allPersonas().find((p) => p.id === a.personaId)?.title ?? a.personaId : a.customTitle || a.customId
        lines.push(
          h(
            Text,
            { key: i, wrap: 'truncate' },
            h(Text, { bold: true }, `${title}${a.count > 1 ? ` ×${a.count}` : ''}`),
            h(Text, { dimColor: true }, ` — ${a.why}`),
          ),
        )
      })
      return lines
    }
    if (view === 'picker') {
      if (customForm) {
        return h(
          Text,
          { dimColor: true },
          `defining: ${customForm.title || '(untitled)'}${customForm.oneliner ? ` — ${customForm.oneliner}` : ''}`,
        )
      }
      const rows = pickerList(goalText)
      const activeIndex = Math.min(pickerIndex, rows.length - 1)
      return rows.slice(0, Math.max(1, TOP - 1)).map((r, i) =>
        h(
          Text,
          { key: r.id, wrap: 'truncate', color: i === activeIndex ? 'cyan' : undefined },
          h(Text, { bold: i === activeIndex }, r.title),
          r.desc ? h(Text, { dimColor: true }, `  ${r.desc}`) : null,
        ),
      )
    }
    if (view === 'graph') {
      return renderGraph()
        .split('\n')
        .slice(0, Math.max(1, TOP - 1))
        .map((line, i) => h(Text, { key: i, wrap: 'truncate' }, line))
    }
    if (view === 'links') {
      if (!wires.length) return h(Text, { dimColor: true }, 'none — drag from one pane onto another to link them')
      return wires
        .slice(0, Math.max(1, TOP - 1))
        .map((w, i) =>
          h(
            Text,
            { key: i, wrap: 'truncate' },
            h(Text, { color: 'cyan' }, w.src),
            h(Text, { color: 'magenta' }, ' feeds '),
            h(Text, { color: 'cyan' }, w.dst),
          ),
        )
    }
    const board = tasks().filter((t) => t.status !== 'done')
    const held = new Set(waiting().map((t) => t.id))
    if (!board.length) return h(Text, { dimColor: true }, 'nothing yet — type what you want up top and press enter')
    return board.slice(0, Math.max(1, TOP - 1)).map((t) => {
      const blocked = held.has(t.id)
      const mark = t.status === 'claimed' ? '▶ ' : blocked ? '· ' : t.status === 'blocked' ? '▲ ' : '○ '
      const color = t.status === 'claimed' ? 'green' : t.status === 'blocked' ? 'red' : blocked ? 'gray' : 'white'
      return h(
        Text,
        { key: t.id, wrap: 'truncate' },
        h(Text, { color }, mark),
        h(Text, { dimColor: blocked }, `#${t.id} ${t.title}`),
        t.owner ? h(Text, { dimColor: true }, ` ${t.owner}`) : null,
        t.route_to && !t.owner ? h(Text, { color: 'magenta' }, ` →${t.route_to}`) : null,
        blocked ? h(Text, { dimColor: true }, ` after ${depsOf(t).map((d) => `#${d}`).join(' ')}`) : null,
      )
    })
  }

  const topLabel =
    view === 'propose'
      ? proposalId === null
        ? 'THINKING...'
        : 'APPROVE? (enter=yes, or ask a question / say what to change)'
      : view === 'picker'
        ? customForm
          ? customForm.stage === 'title'
            ? 'CUSTOM AGENT — title'
            : customForm.stage === 'oneliner'
              ? 'one-line description'
              : 'system prompt (what it does, and does NOT do)'
          : 'ADD AGENT (type to filter, ↑↓ enter, esc to close)'
        : 'WHAT DO YOU WANT?'

  return h(
    Box,
    { flexDirection: 'column', width: size.cols },

    // Header: the goal bar, and a + button per role.
    h(
      Box,
      { key: 'head' },
      h(
        Text,
        { color: focus === -1 ? 'cyan' : undefined, dimColor: focus !== -1 },
        ADD_LABEL,
      ),
      ...PERSONAS.map((p) => h(Text, { key: p.id, color: p.color }, ` +${p.id} `)),
      h(Text, { key: 'picker-btn', color: view === 'picker' ? 'cyan' : 'blue' }, PICKER_LABEL),
      h(Text, { dimColor: true }, `  ${live.length}/${capacity}`),
      wires.length ? h(Text, { color: 'magenta' }, `  ${wires.length} link`) : null,
      dirty.length ? h(Text, { dimColor: true }, `  ${dirty.length} dirty` ) : null,
    ),

    h(
      Box,
      { key: 'top', height: topRows },
      h(
        Box,
        {
          flexDirection: 'column',
          width: Math.floor(size.cols * 0.5),
          borderStyle: 'round',
          borderColor: focus === -1 ? 'cyan' : 'gray',
          paddingX: 1,
        },
        h(
          Text,
          null,
          h(Text, { bold: true, color: focus === -1 ? 'cyan' : undefined }, `${topLabel} `),
          h(Text, null, goalText),
          focus === -1 ? h(Text, { inverse: true }, ' ') : null,
        ),
        viewBody(),
      ),
      h(
        Box,
        { flexDirection: 'column', flexGrow: 1, borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
        h(Text, { bold: true }, "WHAT'S HAPPENING"),
        happenings.length === 0
          ? h(Text, { dimColor: true }, 'quiet — decisions and findings agents post will show up here')
          : happenings.map((e) =>
              h(
                Text,
                { key: e.id, wrap: 'truncate' },
                h(Text, { dimColor: true }, `${ago(e.created_at).padStart(6)} `),
                h(Text, { color: 'cyan' }, e.agent),
                h(Text, { dimColor: true }, ` ${e.kind}: `),
                h(Text, null, e.body),
              ),
            ),
      ),
    ),

    ...byRow.map((indices, row) =>
      h(
        Box,
        { key: `row${row}`, height: rowHeights[row] },
        ...indices.map((idx) => {
          const pane = live[idx]
          const cell = cells.find((c) => c.index === idx)!
          const focused = idx === focus
          const role = roles.find((r) => r.id === pane.id)
          const out = wires.filter((w) => w.src === pane.id).map((w) => w.dst)
          const inb = wires.filter((w) => w.dst === pane.id).map((w) => w.src)
          const iv = interior(cell)
          return h(
            Box,
            {
              key: pane.id,
              flexDirection: 'column',
              // No paddingX: the border already separates panes, and every
              // column it would eat is a column of Claude Code's own frame
              // that the pty thinks it has and the screen does not show.
              width: iv.cols + 2,
              borderStyle: 'round',
              borderColor: focused ? pane.p.color : dragFrom === idx ? 'magenta' : 'gray',
            },
            h(
              Box,
              { key: 'title' },
              h(
                Text,
                { color: focused ? pane.p.color : undefined, bold: focused, dimColor: !focused, wrap: 'truncate' },
                `${pane.id}${pane.model ? ` ${pane.model}` : ''}`,
              ),
              h(Text, { color: statusColor(role?.status ?? 'idle') }, ` ${role?.status ?? 'idle'}`),
              inb.length ? h(Text, { color: 'magenta' }, ` ←${inb.join(',')}`) : null,
              out.length ? h(Text, { color: 'magenta' }, ` →${out.join(',')}`) : null,
              h(Box, { flexGrow: 1 }),
              pane.scroll > 0 ? h(Text, { color: 'yellow' }, `↑${pane.scroll} `) : null,
              h(Text, { dimColor: true }, '×'),
            ),
            ...paneLines(pane.term, iv.rows, iv.cols, pane.scroll).map((line, i) =>
              h(Text, { key: i, wrap: 'truncate' }, line || ' '),
            ),
          )
        }),
      ),
    ),

    live.length === 0
      ? h(Text, { key: 'empty', dimColor: true }, ' no agents — click a +role above to start one')
      : null,

    stalled.length
      ? h(
          Text,
          { key: 'stall', color: 'yellow' },
          ` ${stalled.map((a) => a.id).join(', ')} is asking you something` +
            (isProjectTrusted() ? ' — click its pane and answer.' : ' — click its pane: it wants to know if you trust this folder.'),
        )
      : h(
          Text,
          { key: 'foot', dimColor: true },
          flash
            ? ` ${flash}`
            : ' click a pane to type in it · drag to link · click × to close · ctrl-a add agent · ctrl-v views · ctrl-q quit',
        ),
  )
}

const ADD_LABEL = ' parley '
const PICKER_LABEL = ' agents… '

export function startTui(ids: string[], opts: TuiOptions): void {
  const roster = ids.length ? ids : PERSONAS.slice(0, 2).map((p) => p.id)
  for (const id of roster) persona(id) // fail loudly now, not silently at spawn
  reapDeadAgents() // clear ghosts from a session that was killed rather than quit
  const app = render(h(App, { roster, ...opts }), { exitOnCtrlC: false })
  app.waitUntilExit().then(() => {
    disableMouse()
    process.exit(0)
  })
}
