import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = resolve(import.meta.dirname, 'materialize-desktop-runtime.mjs')

function makeTemp(prefix: string) {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value)}\n`)
}

function isSymlink(path: string) {
  return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false
}

describe('materialize-desktop-runtime.mjs', () => {
  it('dereferences symlinks and verifies the staged CLI', () => {
    const source = makeTemp('dsh-runtime-source')
    const external = makeTemp('dsh-runtime-external')
    const destination = makeTemp('dsh-runtime-dest')

    try {
      // External dependency tree that would break if copied as a symlink.
      writeFileSync(join(external, 'helper.js'), 'module.exports = "ok"\n')
      mkdirSync(join(source, 'lib'), { recursive: true })
      mkdirSync(join(source, 'config'), { recursive: true })
      mkdirSync(join(source, 'node_modules'), { recursive: true })
      writeJson(join(source, 'package.json'), { name: '@deepseek-ai/dsh', version: '9.9.9-test' })
      writeFileSync(
        join(source, 'lib', 'bin.js'),
        'import { readFileSync } from "node:fs"; '
          + 'const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")); '
          + 'console.log(pkg.version);',
      )
      writeFileSync(join(source, 'config', 'default.yml'), 'profile: default\n')
      // Directory junctions do not require elevated privileges on Windows.
      symlinkSync(external, join(source, 'node_modules', 'external-dep'), 'junction')

      const result = spawnSync(
        process.execPath,
        [SCRIPT, '--from', source, '--to', destination],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('staged CLI version: 9.9.9-test')
      expect(result.stdout).toContain('is fully materialized')

      expect(isSymlink(join(destination, 'node_modules', 'external-dep'))).toBe(false)
      expect(lstatSync(join(destination, 'node_modules', 'external-dep', 'helper.js')).isFile()).toBe(true)
      expect(lstatSync(join(destination, 'lib', 'bin.js')).isFile()).toBe(true)
      expect(lstatSync(join(destination, 'package.json')).isFile()).toBe(true)
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(external, { recursive: true, force: true })
      rmSync(destination, { recursive: true, force: true })
    }
  })

  it('copies sibling aliases of one directory without dropping entries', () => {
    const source = makeTemp('dsh-runtime-alias-source')
    const external = makeTemp('dsh-runtime-alias-external')
    const destination = makeTemp('dsh-runtime-alias-dest')

    try {
      mkdirSync(join(source, 'lib'), { recursive: true })
      mkdirSync(join(source, 'config'), { recursive: true })
      mkdirSync(join(source, 'node_modules'), { recursive: true })
      writeJson(join(source, 'package.json'), { name: '@deepseek-ai/dsh', version: '1.0.0-test' })
      writeFileSync(
        join(source, 'lib', 'bin.js'),
        'import { readFileSync } from "node:fs"; '
          + 'const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")); '
          + 'console.log(pkg.version);',
      )
      mkdirSync(join(external, 'nested'), { recursive: true })
      writeFileSync(join(external, 'first.js'), 'export const first = true\n')
      writeFileSync(join(external, 'nested', 'second.js'), 'export const second = true\n')
      symlinkSync(external, join(source, 'node_modules', 'first-alias'), 'junction')
      symlinkSync(external, join(source, 'node_modules', 'second-alias'), 'junction')

      const result = spawnSync(
        process.execPath,
        [SCRIPT, '--from', source, '--to', destination],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )

      expect(result.status).toBe(0)
      for (const alias of ['first-alias', 'second-alias']) {
        expect(lstatSync(join(destination, 'node_modules', alias, 'first.js')).isFile()).toBe(true)
        expect(lstatSync(join(destination, 'node_modules', alias, 'nested', 'second.js')).isFile()).toBe(true)
      }
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(external, { recursive: true, force: true })
      rmSync(destination, { recursive: true, force: true })
    }
  })

  it('fails when the source is missing required entries', () => {
    const source = makeTemp('dsh-runtime-bad-source')
    const destination = makeTemp('dsh-runtime-bad-dest')

    try {
      mkdirSync(join(source, 'lib'), { recursive: true })
      // package.json, config, and node_modules are intentionally absent.
      const result = spawnSync(
        process.execPath,
        [SCRIPT, '--from', source, '--to', destination],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('required entry missing')
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(destination, { recursive: true, force: true })
    }
  })
})
