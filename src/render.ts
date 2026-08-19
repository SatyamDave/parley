// Text renderings of board state, shared by the MCP tools (read by agents) and
// the hooks (injected into agent context). One place so agents and humans are
// looking at the same thing.
import { agents, claims, depsOf, feed, getTask, links, ready, tasks, wip } from './store.ts'
import type { FeedItem, Task } from './store.ts'

export function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export function renderWho(): string {
  const lines: string[] = ['ONLINE']
  const roster = agents()
  if (!roster.length) lines.push('  (nobody — you are the only terminal)')
  for (const a of roster) {
    const held = a.task_id ? getTask(a.task_id) : undefined
    const on = held ? `#${held.id} ${held.title}` : a.status
    lines.push(`  ${a.id.padEnd(14)} ${on}   (seen ${ago(a.last_seen)})`)
  }

  const wires = links()
  if (wires.length) {
    lines.push('', 'LINKS (work flows along the arrow; posts flow both ways)')
    for (const w of wires) lines.push(`  ${w.src} --> ${w.dst}`)
    lines.push(
      '  Work you add is reserved for the agent you point at, and their messages are addressed to you.',
    )
  }

  const held = claims('claim')
  if (held.length) {
    lines.push('', 'CLAIMED PATHS')
    for (const c of held) lines.push(`  ${c.path}  — ${c.agent}${c.note ? ` (${c.note})` : ''}`)
  }

  const free = claims('avoid')
  if (free.length) {
    lines.push('', 'EXPLICITLY NOT BEING TOUCHED (free unless someone claims them)')
    for (const c of free) lines.push(`  ${c.path}  — ${c.agent} is not touching this${c.note ? `: ${c.note}` : ''}`)
  }

  const dirty = wip().filter((w) => w.files.trim())
  if (dirty.length) {
    lines.push('', 'UNCOMMITTED WORK IN PROGRESS (git will not show you this)')
    for (const w of dirty) {
      const files = w.files.split('\n').filter(Boolean)
      lines.push(`  ${w.agent}: ${files.slice(0, 8).join(', ')}${files.length > 8 ? ` +${files.length - 8} more` : ''}`)
    }
  }
  return lines.join('\n')
}

export function renderBoard(): string {
  const all = tasks()
  if (!all.length) return 'BOARD is empty. Add work with parley_task_add.'
  const readyIds = new Set(ready().map((t) => t.id))
  const groups: [string, string][] = [
    ['open', 'OPEN'],
    ['claimed', 'IN PROGRESS'],
    ['review', 'IN REVIEW'],
    ['blocked', 'BLOCKED'],
    ['done', 'DONE'],
  ]
  const lines: string[] = []
  for (const [status, label] of groups) {
    const rows = all.filter((t) => t.status === status)
    if (!rows.length) continue
    lines.push(label)
    for (const t of rows) {
      const owner = t.owner ? ` [${t.owner}]` : t.lane ? ` [lane: ${t.lane}]` : ''
      const labels = t.labels ? ` (${t.labels})` : ''
      const tier = t.model ? ` ${t.model}` : ''
      lines.push(`  #${t.id} ${t.title}${owner}${labels}${tier}`)
      const deps = depsOf(t)
      if (deps.length && status === 'open') {
        const pending = deps.filter((d) => getTask(d)?.status !== 'done')
        lines.push(
          pending.length
            ? `      waiting on ${pending.map((d) => `#${d}`).join(', ')}`
            : '      dependencies met — ready',
        )
      } else if (status === 'open' && readyIds.has(t.id)) {
        lines.push('      ready')
      }
      if (t.attempts) lines.push(`      attempt ${t.attempts + 1} (escalated after being blocked)`)
      if (t.verified_by) lines.push(`      verified by ${t.verified_by}: ${t.verified_how ?? ''}`)
    }
    lines.push('')
  }
  return lines.join('\n').trim()
}

/**
 * The dependency graph as an indented tree — the same information a node canvas
 * would draw, in a form you can read over ssh and paste into a message. Roots
 * are tasks nothing gates; children are the tasks each one unblocks.
 */
export function renderGraph(): string {
  const all = tasks()
  if (!all.length) return 'No tasks yet. Try: parley goal "what you want"'

  const byId = new Map(all.map((t) => [t.id, t]))
  const children = new Map<number, number[]>()
  const hasParent = new Set<number>()
  for (const t of all) {
    for (const d of depsOf(t)) {
      if (!byId.has(d)) continue
      children.set(d, [...(children.get(d) ?? []), t.id])
      hasParent.add(t.id)
    }
  }

  const mark = (t: Task): string => {
    if (t.status === 'done') return '✔'
    if (t.status === 'claimed') return '▶'
    if (t.status === 'blocked') return '▲'
    if (t.status === 'review') return '?'
    return depsOf(t).every((d) => byId.get(d)?.status === 'done') ? '○' : '·'
  }

  const label = (t: Task): string => {
    const who = t.owner ?? (t.lane ? `${t.lane} lane` : 'unassigned')
    const tier = t.model ? `, ${t.model}` : ''
    return `${mark(t)} #${t.id} ${t.title}  (${who}${tier})`
  }

  const lines: string[] = []
  const drawn = new Set<number>()

  const walk = (id: number, prefix: string, last: boolean, depth: number): void => {
    const t = byId.get(id)
    if (!t) return
    const connector = depth === 0 ? '' : last ? '└─ ' : '├─ '
    // A task with two dependencies appears under both; show it once in full and
    // point at the first occurrence afterwards rather than duplicating a subtree.
    if (drawn.has(id)) {
      lines.push(`${prefix}${connector}↑ #${id} (shown above)`)
      return
    }
    drawn.add(id)
    lines.push(`${prefix}${connector}${label(t)}`)
    const kids = children.get(id) ?? []
    const nextPrefix = depth === 0 ? '' : prefix + (last ? '   ' : '│  ')
    kids.forEach((kid, i) => walk(kid, nextPrefix, i === kids.length - 1, depth + 1))
  }

  const roots = all.filter((t) => !hasParent.has(t.id))
  for (const root of roots) {
    walk(root.id, '', true, 0)
    lines.push('')
  }
  // Cycles, or tasks depending on ids that were deleted, would otherwise vanish.
  const orphans = all.filter((t) => !drawn.has(t.id))
  if (orphans.length) {
    lines.push('UNREACHABLE (circular or dangling dependency)')
    for (const t of orphans) lines.push(`  ${label(t)} ⟵ ${depsOf(t).map((d) => `#${d}`).join(' ')}`)
    lines.push('')
  }

  const readyNow = ready()
  lines.push(
    readyNow.length
      ? `${readyNow.length} ready to start now: ${readyNow.map((t) => `#${t.id}`).join(', ')}`
      : 'Nothing ready to start.',
  )
  lines.push('✔ done   ▶ running   ○ ready   · waiting   ▲ blocked   ? in review')
  return lines.join('\n')
}

/** The link topology: who feeds whom, and which open/in-flight tasks are
 *  currently routed to the destination end of each wire. */
export function renderWiring(): string {
  const wires = links()
  if (!wires.length) return 'No wires yet. Drag a pane onto another to link them.'

  const routed = tasks().filter((t) => t.route_to && t.status !== 'done')
  const lines: string[] = ['WIRES (work flows along the arrow; posts flow both ways)']
  for (const w of wires) {
    lines.push(`  ${w.src} --> ${w.dst}`)
    for (const t of routed.filter((t) => t.route_to === w.dst)) {
      lines.push(`      #${t.id} ${t.title} [${t.status}]`)
    }
  }
  return lines.join('\n')
}

export function renderInbox(items: FeedItem[]): string {
  if (!items.length) return ''
  const lines = ['Messages from your peers since your last turn:']
  for (const item of items) {
    lines.push(`  [${item.agent} · ${item.kind} · ${ago(item.created_at)}] ${item.body}`)
  }
  return lines.join('\n')
}

export function renderFeed(limit = 20): string {
  const items = feed(limit).reverse()
  if (!items.length) return '(no activity yet)'
  return items.map((i) => `[${ago(i.created_at)}] ${i.agent} ${i.kind}: ${i.body}`).join('\n')
}
