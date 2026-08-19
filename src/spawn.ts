// Turning a persona into a live `claude` process: its own MCP server, its own
// hooks, its own identity in the environment so every downstream process
// (MCP, hooks, tutor) knows which agent it belongs to.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Persona } from './personas.ts'
import { PROTOCOL } from './personas.ts'
import { projectRoot, stateDir } from './store.ts'

export const SRC = dirname(fileURLToPath(import.meta.url))
const CLI = join(SRC, 'cli.ts')

// Claude Code asks "do you trust this folder?" the first time it opens a
// project interactively, and will not start until someone answers. That is a
// deliberate safety check, so parley reads it but never flips it on its own —
// it detects the stall, explains it, and leaves `parley trust` to the human.
const CLAUDE_CONFIG = join(homedir(), '.claude.json')

export function isProjectTrusted(root: string = projectRoot()): boolean {
  try {
    const config = JSON.parse(readFileSync(CLAUDE_CONFIG, 'utf8')) as {
      projects?: Record<string, { hasTrustDialogAccepted?: boolean }>
    }
    return config.projects?.[root]?.hasTrustDialogAccepted === true
  } catch {
    return false // no config yet, or unreadable — assume the prompt will appear
  }
}

/** Answer Claude Code's trust prompt for this project, once, on purpose. */
export function trustProject(root: string = projectRoot()): boolean {
  if (!existsSync(CLAUDE_CONFIG)) return false
  try {
    const raw = readFileSync(CLAUDE_CONFIG, 'utf8')
    const config = JSON.parse(raw) as { projects?: Record<string, Record<string, unknown>> }
    config.projects ??= {}
    config.projects[root] = { ...(config.projects[root] ?? {}), hasTrustDialogAccepted: true }
    writeFileSync(`${CLAUDE_CONFIG}.parley-bak`, raw)
    writeFileSync(CLAUDE_CONFIG, JSON.stringify(config, null, 2))
    return true
  } catch {
    return false
  }
}

export type SpawnPlan = {
  file: string
  args: string[]
  env: Record<string, string>
  cwd: string
  model: string
}

function hook(event: string) {
  return { hooks: [{ type: 'command', command: `node ${CLI} hook ${event}` }] }
}

/**
 * Per-agent settings: the reflexes. SessionStart hands the agent the board,
 * UserPromptSubmit slips in anything peers said since its last turn, PostToolUse
 * records what it touched, Stop reports in and fires the tutor.
 */
function writeConfigs(id: string, root: string, dir: string): { settings: string; mcp: string } {
  const agentDir = join(dir, 'agents', id)
  mkdirSync(agentDir, { recursive: true })

  const settings = join(agentDir, 'settings.json')
  writeFileSync(
    settings,
    JSON.stringify(
      {
        // parley's own tools only ever read and write parley's board — they
        // cannot touch the repository. Prompting for them would stall every
        // dispatched task at its first claim, and the agent already has edit
        // permission on the actual code, so this concedes nothing.
        permissions: { allow: ['mcp__parley'] },
        hooks: {
          SessionStart: [hook('session-start')],
          UserPromptSubmit: [hook('inbox')],
          PostToolUse: [{ matcher: 'Edit|Write|NotebookEdit', ...hook('touch') }],
          Stop: [hook('stop')],
        },
      },
      null,
      2,
    ),
  )

  const mcp = join(agentDir, 'mcp.json')
  writeFileSync(
    mcp,
    JSON.stringify(
      {
        mcpServers: {
          parley: {
            command: 'node',
            args: [join(SRC, 'mcp.ts')],
            env: { PARLEY_AGENT: id, PARLEY_DIR: dir, PARLEY_PROJECT: root },
          },
        },
      },
      null,
      2,
    ),
  )

  return { settings, mcp }
}

/**
 * `id` is the agent instance (builder, builder-2); `p` is the persona it plays.
 * Keeping those separate is what lets three Builders run at once — each gets its
 * own settings directory, its own MCP server identity, and its own row on the
 * board, while sharing one persona's prompt and lane.
 *
 * Model precedence: explicit override > per-task tier > persona default.
 */
export function planAgent(
  id: string,
  p: Persona,
  opts: { permissionMode?: string; model?: string } = {},
): SpawnPlan {
  const root = projectRoot()
  const dir = stateDir(root)
  const { settings, mcp } = writeConfigs(id, root, dir)

  const args = [
    '--name',
    `parley:${id}`,
    '--append-system-prompt',
    `You are "${p.title}" (agent id: ${id}).\n\n${p.prompt}\n\n${PROTOCOL}`,
    '--mcp-config',
    mcp,
    '--settings',
    settings,
    '--permission-mode',
    opts.permissionMode ?? 'acceptEdits',
  ]
  const model = opts.model || p.model || ''
  if (model) args.push('--model', model)

  return {
    file: process.env.PARLEY_CLAUDE ?? 'claude',
    args,
    cwd: root,
    model,
    env: {
      ...(process.env as Record<string, string>),
      PARLEY_AGENT: id,
      PARLEY_PERSONA: p.id,
      PARLEY_DIR: dir,
      PARLEY_PROJECT: root,
      // Claude Code renders its own frame; give it a real terminal to draw in.
      TERM: 'xterm-256color',
      FORCE_COLOR: '3',
    },
  }
}
