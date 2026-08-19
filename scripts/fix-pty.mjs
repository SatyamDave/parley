#!/usr/bin/env node
// node-pty ships prebuilds without the exec bit on spawn-helper, which makes
// every pty.spawn() fail with a bare "posix_spawnp failed." Restore it.
import { chmodSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const platform = `${process.platform}-${process.arch}`
const helper = join(root, 'node_modules/node-pty/prebuilds', platform, 'spawn-helper')

if (existsSync(helper)) {
  chmodSync(helper, 0o755)
  console.log(`[parley] chmod +x ${platform}/spawn-helper`)
}
