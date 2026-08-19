// spawn.ts turns a persona into a launchable `claude` process: the argv,
// the env, and the per-agent settings/MCP config files it writes to disk.
// Nothing here ever spawns a real `claude` process — planAgent only builds
// a plan and writes config files; we just inspect what it built and wrote.
//
// PARLEY_DIR controls where those config files land (via store.ts's
// stateDir()), so each test gets its own temp dir. store.ts also caches its
// DatabaseSync handle at module scope, and spawn.ts pulls in projectRoot /
// stateDir from it, so — same isolation pattern as test/store-graph.test.ts —
// tests that need real separation import a fresh module instance via a
// `?fresh=N` query rather than sharing the process-wide singleton.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Persona } from '../src/personas.ts'
import { PROTOCOL } from '../src/personas.ts'
import { planAgent, type SpawnPlan } from '../src/spawn.ts'
import { projectRoot } from '../src/store.ts'

const persona: Persona = {
  id: 'tester',
  title: 'Tester',
  color: 'white',
  labels: ['test'],
  model: 'sonnet',
  prompt: 'You are the Tester persona. Write tests, nothing else.',
}

function withTempParleyDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'parley-spawn-test-'))
  const prior = process.env.PARLEY_DIR
  process.env.PARLEY_DIR = dir
  try {
    return fn(dir)
  } finally {
    if (prior === undefined) delete process.env.PARLEY_DIR
    else process.env.PARLEY_DIR = prior
    rmSync(dir, { recursive: true, force: true })
  }
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function mcpConfigPath(plan: SpawnPlan): string {
  const idx = plan.args.indexOf('--mcp-config')
  assert.ok(idx >= 0, 'expected --mcp-config in argv')
  return plan.args[idx + 1]
}

function settingsPath(plan: SpawnPlan): string {
  const idx = plan.args.indexOf('--settings')
  assert.ok(idx >= 0, 'expected --settings in argv')
  return plan.args[idx + 1]
}

// --- per-agent settings file: gotcha #1 ------------------------------------

test('planAgent: settings file allows mcp__parley and wires all four hooks (gotcha #1)', () => {
  withTempParleyDir(() => {
    const plan = planAgent('builder', persona)
    const settings = readJson(settingsPath(plan))

    // The exact regression this pins: without this allowance, every dispatched
    // task stalls invisibly at its first parley_claim under a permission
    // prompt, even with --permission-mode acceptEdits.
    assert.ok(
      Array.isArray(settings.permissions?.allow) && settings.permissions.allow.includes('mcp__parley'),
      'settings.permissions.allow must include mcp__parley',
    )

    for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']) {
      assert.ok(settings.hooks?.[event], `expected a ${event} hook to be configured`)
    }
  })
})

test('planAgent: PostToolUse hook is scoped to edit-shaped tools', () => {
  withTempParleyDir(() => {
    const plan = planAgent('builder', persona)
    const settings = readJson(settingsPath(plan))
    assert.equal(settings.hooks.PostToolUse[0].matcher, 'Edit|Write|NotebookEdit')
  })
})

// --- per-agent MCP config ---------------------------------------------------

test('planAgent: mcp config points at the parley MCP server with this agent identity in env', () => {
  withTempParleyDir((dir) => {
    const plan = planAgent('builder-2', persona)
    const mcp = readJson(mcpConfigPath(plan))

    const server = mcp.mcpServers?.parley
    assert.ok(server, 'expected an mcpServers.parley entry')
    assert.equal(server.command, 'node')
    assert.ok(server.args[0].endsWith('mcp.ts'), 'expected the args to point at src/mcp.ts')
    assert.equal(server.env.PARLEY_AGENT, 'builder-2')
    assert.equal(server.env.PARLEY_DIR, dir)
    assert.equal(server.env.PARLEY_PROJECT, projectRoot())
  })
})

// --- argv -------------------------------------------------------------------

test('planAgent: --append-system-prompt carries the persona prompt and the shared protocol', () => {
  withTempParleyDir(() => {
    const plan = planAgent('builder', persona)
    const idx = plan.args.indexOf('--append-system-prompt')
    assert.ok(idx >= 0)
    const prompt = plan.args[idx + 1]
    assert.match(prompt, /Tester/)
    assert.match(prompt, /agent id: builder/)
    assert.match(prompt, /Write tests, nothing else\./)
    assert.match(prompt, /--- parley protocol ---/)
    assert.ok(prompt.includes(PROTOCOL), 'the full shared protocol text must be appended verbatim')
  })
})

test('planAgent: --permission-mode defaults to acceptEdits and can be overridden', () => {
  withTempParleyDir(() => {
    const defaultPlan = planAgent('builder', persona)
    const i1 = defaultPlan.args.indexOf('--permission-mode')
    assert.equal(defaultPlan.args[i1 + 1], 'acceptEdits')

    const overridden = planAgent('builder', persona, { permissionMode: 'plan' })
    const i2 = overridden.args.indexOf('--permission-mode')
    assert.equal(overridden.args[i2 + 1], 'plan')
  })
})

test('planAgent: --model is appended only when a model actually resolves', () => {
  withTempParleyDir(() => {
    const withModel = planAgent('builder', persona)
    assert.ok(withModel.args.includes('--model'))
    assert.equal(withModel.args[withModel.args.indexOf('--model') + 1], 'sonnet')

    const untieredPersona: Persona = { ...persona, model: undefined }
    const withoutModel = planAgent('builder', untieredPersona)
    assert.equal(
      withoutModel.args.includes('--model'),
      false,
      'an empty tier must not append a bare --model with no value',
    )
    assert.equal(withoutModel.model, '')
  })
})

test('planAgent: model precedence — explicit override beats persona default', () => {
  withTempParleyDir(() => {
    const plan = planAgent('builder', persona, { model: 'opus' })
    assert.equal(plan.model, 'opus')
    assert.equal(plan.args[plan.args.indexOf('--model') + 1], 'opus')
  })
})

test('planAgent: with no override and no persona default, model resolves to empty', () => {
  withTempParleyDir(() => {
    const untieredPersona: Persona = { ...persona, model: undefined }
    const plan = planAgent('builder', untieredPersona)
    assert.equal(plan.model, '')
  })
})

// --- env ---------------------------------------------------------------

test('planAgent: env carries the agent identity, persona, board dir, and project root', () => {
  withTempParleyDir((dir) => {
    const plan = planAgent('builder-3', persona)
    assert.equal(plan.env.PARLEY_AGENT, 'builder-3')
    assert.equal(plan.env.PARLEY_PERSONA, 'tester')
    assert.equal(plan.env.PARLEY_DIR, dir)
    assert.equal(plan.env.PARLEY_PROJECT, projectRoot())
  })
})

// --- isProjectTrusted / trustProject, against a fake HOME ------------------
//
// CLAUDE_CONFIG in spawn.ts is `join(homedir(), '.claude.json')`, computed
// once at module load time. To exercise it without ever touching the real
// developer's ~/.claude.json, we point HOME at a fresh temp dir *before*
// importing a fresh instance of spawn.ts (via `?fresh=N`, same trick as
// everywhere else in this suite), so that fresh instance's CLAUDE_CONFIG
// resolves under the fake HOME instead.

let freshSpawnCounter = 0

async function withFakeHomeSpawn<T>(fn: (spawn: typeof import('../src/spawn.ts'), fakeHome: string) => Promise<T> | T): Promise<T> {
  const fakeHome = mkdtempSync(join(tmpdir(), 'parley-fake-home-'))
  const priorHome = process.env.HOME
  process.env.HOME = fakeHome
  try {
    const spawnModule = await import(`../src/spawn.ts?fresh=${freshSpawnCounter++}`)
    return await fn(spawnModule, fakeHome)
  } finally {
    if (priorHome === undefined) delete process.env.HOME
    else process.env.HOME = priorHome
    rmSync(fakeHome, { recursive: true, force: true })
  }
}

test('isProjectTrusted: false when there is no ~/.claude.json at all', async () => {
  await withFakeHomeSpawn((spawn, fakeHome) => {
    assert.equal(spawn.isProjectTrusted('/some/project'), false)
  })
})

test('isProjectTrusted: false for a project not present in an existing config', async () => {
  await withFakeHomeSpawn((spawn, fakeHome) => {
    writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify({ projects: {} }))
    assert.equal(spawn.isProjectTrusted('/some/project'), false)
  })
})

test('isProjectTrusted: true once trustProject has marked the project, in the fake config only', async () => {
  await withFakeHomeSpawn((spawn, fakeHome) => {
    const configPath = join(fakeHome, '.claude.json')
    writeFileSync(configPath, JSON.stringify({ projects: {} }))

    const project = '/some/project'
    assert.equal(spawn.isProjectTrusted(project), false)

    const ok = spawn.trustProject(project)
    assert.equal(ok, true)
    assert.equal(spawn.isProjectTrusted(project), true)

    // it really did write to the fake config, not somewhere else
    const written = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(written.projects[project].hasTrustDialogAccepted, true)
  })
})

test('trustProject: false when there is no config file to answer the prompt in', async () => {
  await withFakeHomeSpawn((spawn) => {
    assert.equal(spawn.trustProject('/some/project'), false)
  })
})

// --- store.joinAgent null-pid COALESCE guard (gotcha #3) -------------------
//
// The TUI records the real pty pid at spawn time; the SessionStart hook
// calls joinAgent again with pid=null because a hook subprocess has no way
// to know the pty's pid. A plain assignment would null the pid out, and
// liveness detection (process.kill(pid, 0)) would then reap a healthy agent
// moments later. store.ts guards this with COALESCE(excluded.pid, agents.pid).
let freshStoreCounter = 0
async function freshStore() {
  process.env.PARLEY_DIR = mkdtempSync(join(tmpdir(), 'parley-spawn-store-test-'))
  return await import(`../src/store.ts?fresh=spawn-${freshStoreCounter++}`)
}

test('joinAgent: rejoining with a null pid (the SessionStart hook) does not wipe the recorded pid', async () => {
  const store = await freshStore()

  store.joinAgent('builder', 'builder', 4242, 'starting') // the spawner recording the real pty pid
  store.joinAgent('builder', 'builder', null, 'idle') // the SessionStart hook, which cannot know it

  const agent = store.agents().find((a: { id: string }) => a.id === 'builder')!
  assert.equal(agent.pid, 4242, 'the real pid must survive the null-pid rejoin')
  assert.equal(agent.status, 'idle', 'the status the hook set still applies')
})
