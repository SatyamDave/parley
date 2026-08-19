import { test } from 'node:test'
import assert from 'node:assert'
import { attributes } from '../src/watch.ts'

test('attributes: exact match', () => {
  assert.strictEqual(attributes('src/watch.ts', 'src/watch.ts'), true)
})

test('attributes: no match on partial component', () => {
  assert.strictEqual(attributes('parts.ts', 's.ts'), false)
  assert.strictEqual(attributes('s.ts', 'parts.ts'), false)
})

test('attributes: true directory-suffix match', () => {
  assert.strictEqual(attributes('src/watch.ts', 'watch.ts'), true)
  assert.strictEqual(attributes('src/app/config.ts', 'config.ts'), true)
})

test('attributes: false positive on basename', () => {
  // Different directories, same basename — should NOT match without explicit fallback
  assert.strictEqual(attributes('src/app/config.ts', 'other/config.ts'), false)
  assert.strictEqual(attributes('other/config.ts', 'src/app/config.ts'), false)
})

test('attributes: absolute vs repo-relative paths', () => {
  // Normalize absolute to repo-relative before comparing
  // This simulates: recordedPath=/home/user/parley/src/watch.ts (absolute)
  // and dirtyPath=src/watch.ts (repo-relative)
  assert.strictEqual(attributes('/home/user/parley/src/watch.ts', 'src/watch.ts'), true)
})

test('attributes: directory suffix with slashes', () => {
  // src/app/watch.ts should match if touched path ends with app/watch.ts
  assert.strictEqual(attributes('deep/src/app/watch.ts', 'src/app/watch.ts'), true)
  assert.strictEqual(attributes('src/app/watch.ts', 'app/watch.ts'), true)
})

test('attributes: does not match on partial path component', () => {
  // app/config.ts should NOT match if touched path is myapp/config.ts
  assert.strictEqual(attributes('myapp/config.ts', 'app/config.ts'), false)
  assert.strictEqual(attributes('app/config.ts', 'myapp/config.ts'), false)
})

test('attributes: both absolute paths', () => {
  assert.strictEqual(attributes('/home/user/parley/src/watch.ts', '/home/user/parley/src/watch.ts'), true)
})

test('attributes: suffix match with multiple path levels', () => {
  assert.strictEqual(attributes('src/components/ui/Button.tsx', 'components/ui/Button.tsx'), true)
  assert.strictEqual(attributes('src/components/ui/Button.tsx', 'ui/Button.tsx'), true)
  assert.strictEqual(attributes('src/components/ui/Button.tsx', 'Button.tsx'), true)
})

test('attributes: does not match cross-component paths', () => {
  // components/Button.tsx should not match components/ui/Button.tsx
  assert.strictEqual(attributes('src/components/Button.tsx', 'components/ui/Button.tsx'), false)
  assert.strictEqual(attributes('src/components/ui/Button.tsx', 'components/Button.tsx'), false)
})
