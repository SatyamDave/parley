// Uncommitted work is invisible to every git-based check a peer might run:
// origin/main, remote branch lists, ls-tree, even `git worktree list` shows the
// checkout without revealing it is dirty. So we look directly, and attribute
// what we find to whichever agent actually edited the file.
//
// This needs zero cooperation from the terminal that is heads-down, which is
// exactly why it beats asking everyone to keep a status file honest.
import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import { agents, db, projectRoot, setWip } from './store.ts'

/**
 * Check if a touched path matches a dirty path. Both can be absolute or
 * repo-relative. Matches on exact equality or true path-suffix where the
 * boundary falls on '/'.
 */
export function attributes(touchPath: string, dirtyPath: string): boolean {
  const normTouch = touchPath.split(/[/\\]/).filter(Boolean)
  const normDirty = dirtyPath.split(/[/\\]/).filter(Boolean)

  // Exact match
  if (normTouch.join('/') === normDirty.join('/')) return true

  // Check if one is a suffix of the other (boundary on '/')
  if (normTouch.length < normDirty.length) {
    return normDirty.slice(-normTouch.length).every((seg, i) => seg === normTouch[i])
  } else {
    return normTouch.slice(-normDirty.length).every((seg, i) => seg === normDirty[i])
  }
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

/** Paths with uncommitted changes, staged or not, plus untracked files. */
export function dirtyFiles(cwd: string): string[] {
  return git(cwd, ['status', '--porcelain=v1', '--untracked-files=normal'])
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((p) => (p.includes(' -> ') ? p.split(' -> ')[1] : p)) // renames
    .filter(Boolean)
}

/** Other worktrees of the same repo — peers working outside parley entirely. */
function otherWorktrees(root: string): string[] {
  return git(root, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length))
    .filter((p) => p && p !== root)
}

function touchedBy(agent: string): Set<string> {
  const rows = db()
    .prepare('SELECT DISTINCT path FROM touches WHERE agent = ?')
    .all(agent) as unknown as { path: string }[]
  return new Set(rows.map((r) => r.path))
}

/**
 * Attribute dirty files to agents by what each one edited, and report the
 * remainder as unattributed — that leftover is the interesting part. It is
 * work happening in this repo that parley did not do, which is precisely the
 * state that made three terminals confidently wrong about the same task.
 */
export function scanWip(): void {
  const root = projectRoot()
  const dirty = dirtyFiles(root)
  const claimedByAgents = new Set<string>()

  for (const agent of agents()) {
    const touched = touchedBy(agent.id)
    const mine = dirty.filter((f) => [...touched].some((t) => attributes(t, f)))
    for (const f of mine) claimedByAgents.add(f)
    setWip(agent.id, mine)
  }

  const orphans = dirty.filter((f) => !claimedByAgents.has(f))
  if (orphans.length) setWip('(not parley)', orphans)
  else setWip('(not parley)', [])

  for (const wt of otherWorktrees(root)) {
    const files = dirtyFiles(wt)
    setWip(`worktree:${basename(wt)}`, files)
  }
}
