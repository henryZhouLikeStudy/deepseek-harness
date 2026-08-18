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

function buildBaseArgs(source: string, destination: string, sourceNodeModules: string, fallbackNodeModules?: string) {
  const args = [SCRIPT, '--from', source, '--to', destination, '--source-node-modules', sourceNodeModules]
  if (fallbackNodeModules !== undefined) {
    args.push('--fallback-node-modules', fallbackNodeModules)
  }
  return args
}

function runMaskedPnpmAliasFixture(
  configurePayload?: (fixture: {
    workspaceRoot: string
    stagingPackage: string
    pnpmPackage: string
  }) => void,
) {
  const workspaceRoot = makeTemp('dsh-runtime-pnpm-fallback-workspace-root')
  const source = join(workspaceRoot, 'staging')
  const sourceNodeModules = join(workspaceRoot, 'source-node-modules')
  const fallbackNodeModules = join(workspaceRoot, 'node_modules')
  const destination = makeTemp('dsh-runtime-pnpm-fallback-dest')

  try {
    mkdirSync(sourceNodeModules, { recursive: true })
    mkdirSync(fallbackNodeModules, { recursive: true })
    mkdirSync(join(source, 'lib'), { recursive: true })
    mkdirSync(join(source, 'config'), { recursive: true })
    mkdirSync(join(source, 'node_modules'), { recursive: true })
    writeJson(join(source, 'package.json'), {
      name: '@deepseek-ai/dsh',
      version: '9.5.0-test',
      dependencies: { 'parent-pkg': '^1.0.0', 'js-yaml': '^4.2.0' },
    })

    const pnpmStore = join(fallbackNodeModules, '.pnpm')
    const pnpmPackage = join(pnpmStore, 'js-yaml@4.2.0', 'node_modules', 'js-yaml')
    mkdirSync(pnpmPackage, { recursive: true })
    writeJson(join(pnpmPackage, 'package.json'), {
      name: 'js-yaml',
      version: '4.2.0',
      type: 'module',
      exports: { '.': './index.mjs' },
    })
    writeFileSync(join(pnpmPackage, 'index.mjs'), 'export const value = "yaml-ok";\n')
    symlinkSync(pnpmPackage, join(fallbackNodeModules, 'js-yaml'), 'junction')

    // Model apps/cli/node_modules: a separate real copy with the same payload
    // masks the fallback pnpm identity during source-context discovery.
    mkdirSync(join(sourceNodeModules, 'js-yaml'), { recursive: true })
    writeJson(join(sourceNodeModules, 'js-yaml', 'package.json'), {
      name: 'js-yaml',
      version: '4.2.0',
      type: 'module',
      exports: { '.': './index.mjs' },
    })
    writeFileSync(join(sourceNodeModules, 'js-yaml', 'index.mjs'), 'export const value = "yaml-ok";\n')

    const parentPkgStore = join(pnpmStore, 'parent-pkg@1.0.0', 'node_modules', 'parent-pkg')
    mkdirSync(parentPkgStore, { recursive: true })
    writeJson(join(parentPkgStore, 'package.json'), {
      name: 'parent-pkg',
      version: '1.0.0',
      type: 'module',
      exports: { '.': './index.mjs' },
      dependencies: { 'js-yaml': '^4.2.0' },
    })
    writeFileSync(join(parentPkgStore, 'index.mjs'), 'export * from "js-yaml";\n')
    mkdirSync(join(parentPkgStore, 'node_modules'), { recursive: true })
    symlinkSync(pnpmPackage, join(parentPkgStore, 'node_modules', 'js-yaml'), 'junction')
    symlinkSync(parentPkgStore, join(fallbackNodeModules, 'parent-pkg'), 'junction')

    const stagingPackage = join(source, 'node_modules', 'js-yaml')
    mkdirSync(stagingPackage, { recursive: true })
    writeJson(join(stagingPackage, 'package.json'), {
      name: 'js-yaml',
      version: '4.2.0',
      type: 'module',
      exports: { '.': './index.mjs' },
    })
    writeFileSync(join(stagingPackage, 'index.mjs'), 'export const value = "yaml-ok";\n')

    mkdirSync(join(source, 'node_modules', 'parent-pkg'), { recursive: true })
    writeJson(join(source, 'node_modules', 'parent-pkg', 'package.json'), {
      name: 'parent-pkg',
      version: '1.0.0',
      type: 'module',
      exports: { '.': './index.mjs' },
      dependencies: { 'js-yaml': '^4.2.0' },
    })
    writeFileSync(join(source, 'node_modules', 'parent-pkg', 'index.mjs'), 'export * from "js-yaml";\n')

    configurePayload?.({ workspaceRoot, stagingPackage, pnpmPackage })
    writeFileSync(
      join(source, 'lib', 'bin.js'),
      'import { value as direct } from "js-yaml"; import { value as indirect } from "parent-pkg"; console.log(`${direct}:${indirect}`);',
    )

    return spawnSync(
      process.execPath,
      buildBaseArgs(source, destination, sourceNodeModules, fallbackNodeModules),
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
    rmSync(destination, { recursive: true, force: true })
  }
}

describe('materialize-desktop-runtime.mjs', () => {
  it('dereferences symlinks and verifies the staged CLI', () => {
    const source = makeTemp('dsh-runtime-source')
    const sourceNodeModules = makeTemp('dsh-runtime-source-node-modules')
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
        buildBaseArgs(source, destination, sourceNodeModules),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('staged CLI smoke output: 9.9.9-test')
      expect(result.stdout).toContain('is fully materialized')

      expect(isSymlink(join(destination, 'node_modules', 'external-dep'))).toBe(false)
      expect(lstatSync(join(destination, 'node_modules', 'external-dep', 'helper.js')).isFile()).toBe(true)
      expect(lstatSync(join(destination, 'lib', 'bin.js')).isFile()).toBe(true)
      expect(lstatSync(join(destination, 'package.json')).isFile()).toBe(true)
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(sourceNodeModules, { recursive: true, force: true })
      rmSync(external, { recursive: true, force: true })
      rmSync(destination, { recursive: true, force: true })
    }
  })

  it('restores the full dependency closure so the staged CLI can import a transitive package', () => {
    const source = makeTemp('dsh-runtime-closure-source')
    const sourceNodeModules = makeTemp('dsh-runtime-closure-source-node-modules')
    const fallbackNodeModules = makeTemp('dsh-runtime-closure-fallback-node-modules')
    const virtualStore = makeTemp('dsh-runtime-closure-virtual-store')
    const destination = makeTemp('dsh-runtime-closure-dest')

    try {
      mkdirSync(join(source, 'lib'), { recursive: true })
      mkdirSync(join(source, 'config'), { recursive: true })
      mkdirSync(join(source, 'node_modules'), { recursive: true })
      writeJson(join(source, 'package.json'), {
        name: '@deepseek-ai/dsh',
        version: '3.0.0-test',
        dependencies: { 'direct-pkg': '^1.0.0' },
      })

      // Model pnpm's virtual-store layout: the staging node_modules entry is a
      // junction to the real package, and its dependencies live in the virtual
      // store context's sibling node_modules directory.
      const directPkgReal = join(virtualStore, 'direct-pkg@1.0.0', 'node_modules', 'direct-pkg')
      mkdirSync(directPkgReal, { recursive: true })
      writeJson(join(directPkgReal, 'package.json'), {
        name: 'direct-pkg',
        type: 'module',
        exports: { '.': './index.mjs' },
        dependencies: { 'transitive-pkg': '^1.0.0' },
      })
      writeFileSync(
        join(directPkgReal, 'index.mjs'),
        'export * from "transitive-pkg";\n',
      )
      symlinkSync(directPkgReal, join(source, 'node_modules', 'direct-pkg'), 'junction')

      const transitivePkgReal = join(virtualStore, 'direct-pkg@1.0.0', 'node_modules', 'transitive-pkg')
      mkdirSync(transitivePkgReal, { recursive: true })
      writeJson(join(transitivePkgReal, 'package.json'), {
        name: 'transitive-pkg',
        type: 'module',
        exports: { '.': './index.mjs' },
      })
      writeFileSync(
        join(transitivePkgReal, 'index.mjs'),
        'export const value = "transitive-ok";\n',
      )

      // The staged CLI imports through direct-pkg, which imports transitive-pkg,
      // and also imports transitive-pkg directly to prove it is resolvable.
      writeFileSync(
        join(source, 'lib', 'bin.js'),
        'import { value as indirect } from "direct-pkg"; import { value as direct } from "transitive-pkg"; console.log(`${indirect}:${direct}`);',
      )

      const result = spawnSync(
        process.execPath,
        buildBaseArgs(source, destination, sourceNodeModules, fallbackNodeModules),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('restored closure packages: transitive-pkg')
      expect(result.stdout).toContain('staged CLI smoke output: transitive-ok:transitive-ok')
      expect(lstatSync(join(destination, 'node_modules', 'transitive-pkg', 'index.mjs')).isFile()).toBe(true)
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(sourceNodeModules, { recursive: true, force: true })
      rmSync(fallbackNodeModules, { recursive: true, force: true })
      rmSync(virtualStore, { recursive: true, force: true })
      rmSync(destination, { recursive: true, force: true })
    }
  })

  it('uses the source package context to resolve children of a hoisted staged package', () => {
    const source = makeTemp('dsh-runtime-source-context-source')
    const sourceNodeModules = makeTemp('dsh-runtime-source-context-source-node-modules')
    const destination = makeTemp('dsh-runtime-source-context-dest')

    try {
      mkdirSync(join(source, 'lib'), { recursive: true })
      mkdirSync(join(source, 'config'), { recursive: true })
      mkdirSync(join(source, 'node_modules'), { recursive: true })
      writeJson(join(source, 'package.json'), {
        name: '@deepseek-ai/dsh',
        version: '3.1.0-test',
        dependencies: { 'source-context-pkg': '^1.0.0' },
      })

      // Model a workspace override: in the source tree the package is a junction
      // to a workspace directory that holds additional dependencies. In the
      // hoisted staging tree it is a real copied directory with no nested
      // node_modules, so child dependencies must be discovered through the
      // source context.
      const workspacePkg = join(sourceNodeModules, '..', 'workspace-context-pkg')
      mkdirSync(workspacePkg, { recursive: true })
      writeJson(join(workspacePkg, 'package.json'), {
        name: 'source-context-pkg',
        version: '1.0.0',
        type: 'module',
        exports: { '.': './index.mjs' },
        dependencies: { 'nested-pkg': '^1.0.0' },
      })
      writeFileSync(
        join(workspacePkg, 'index.mjs'),
        'export * from "nested-pkg";\n',
      )
      mkdirSync(join(workspacePkg, 'node_modules', 'nested-pkg'), { recursive: true })
      writeJson(join(workspacePkg, 'node_modules', 'nested-pkg', 'package.json'), {
        name: 'nested-pkg',
        version: '1.0.0',
        type: 'module',
        exports: { '.': './index.mjs' },
      })
      writeFileSync(
        join(workspacePkg, 'node_modules', 'nested-pkg', 'index.mjs'),
        'export const value = "nested-ok";\n',
      )
      symlinkSync(workspacePkg, join(sourceNodeModules, 'source-context-pkg'), 'junction')

      // The staging copy is a real directory without nested dependencies.
      mkdirSync(join(source, 'node_modules', 'source-context-pkg'), { recursive: true })
      writeJson(join(source, 'node_modules', 'source-context-pkg', 'package.json'), {
        name: 'source-context-pkg',
        version: '1.0.0',
        type: 'module',
        exports: { '.': './index.mjs' },
        dependencies: { 'nested-pkg': '^1.0.0' },
      })
      writeFileSync(
        join(source, 'node_modules', 'source-context-pkg', 'index.mjs'),
        'export * from "nested-pkg";\n',
      )

      writeFileSync(
        join(source, 'lib', 'bin.js'),
        'import { value } from "source-context-pkg"; console.log(value);',
      )

      const result = spawnSync(
        process.execPath,
        buildBaseArgs(source, destination, sourceNodeModules),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('restored closure packages: nested-pkg')
      expect(result.stdout).toContain('staged CLI smoke output: nested-ok')
      expect(lstatSync(join(destination, 'node_modules', 'nested-pkg', 'index.mjs')).isFile()).toBe(true)
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(sourceNodeModules, { recursive: true, force: true })
      rmSync(destination, { recursive: true, force: true })
    }
  })

  it('skips missing optional dependencies and includes installed optional dependencies', () => {
    const source = makeTemp('dsh-runtime-optional-source')
    const sourceNodeModules = makeTemp('dsh-runtime-optional-source-node-modules')
    const destination = makeTemp('dsh-runtime-optional-dest')

    try {
      mkdirSync(join(source, 'lib'), { recursive: true })
      mkdirSync(join(source, 'config'), { recursive: true })
      mkdirSync(join(source, 'node_modules'), { recursive: true })
      writeJson(join(source, 'package.json'), {
        name: '@deepseek-ai/dsh',
        version: '4.0.0-test',
        optionalDependencies: {
          'missing-opt': '^1.0.0',
          'present-opt': '^1.0.0',
        },
      })

      // present-opt is installed in the explicit source root.
      mkdirSync(join(sourceNodeModules, 'present-opt'), { recursive: true })
      writeJson(join(sourceNodeModules, 'present-opt', 'package.json'), {
        name: 'present-opt',
        type: 'module',
        exports: { '.': './index.mjs' },
      })
      writeFileSync(
        join(sourceNodeModules, 'present-opt', 'index.mjs'),
        'export const value = "opt-ok";\n',
      )

      writeFileSync(
        join(source, 'lib', 'bin.js'),
        'import { value } from "present-opt"; console.log(value);',
      )

      const result = spawnSync(
        process.execPath,
        buildBaseArgs(source, destination, sourceNodeModules),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('restored closure packages: present-opt')
      expect(result.stdout).not.toContain('missing-opt')
      expect(result.stdout).toContain('staged CLI smoke output: opt-ok')
      expect(lstatSync(join(destination, 'node_modules', 'present-opt', 'index.mjs')).isFile()).toBe(true)
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(sourceNodeModules, { recursive: true, force: true })
      rmSync(destination, { recursive: true, force: true })
    }
  })

  it('treats a name in both dependencies and optionalDependencies as optional', () => {
    const source = makeTemp('dsh-runtime-overlap-source')
    const sourceNodeModules = makeTemp('dsh-runtime-overlap-source-node-modules')
    const destination = makeTemp('dsh-runtime-overlap-dest')

    try {
      mkdirSync(join(source, 'lib'), { recursive: true })
      mkdirSync(join(source, 'config'), { recursive: true })
      mkdirSync(join(source, 'node_modules'), { recursive: true })
      writeJson(join(source, 'package.json'), {
        name: '@deepseek-ai/dsh',
        version: '4.1.0-test',
        dependencies: { 'overlap': '^1.0.0', 'regular-dep': '^1.0.0' },
        optionalDependencies: { 'overlap': '^1.0.0' },
      })

      // regular-dep is present and required; overlap is missing but optional.
      mkdirSync(join(sourceNodeModules, 'regular-dep'), { recursive: true })
      writeJson(join(sourceNodeModules, 'regular-dep', 'package.json'), {
        name: 'regular-dep',
        type: 'module',
        exports: { '.': './index.mjs' },
      })
      writeFileSync(
        join(sourceNodeModules, 'regular-dep', 'index.mjs'),
        'export const value = "regular-ok";\n',
      )

      writeFileSync(
        join(source, 'lib', 'bin.js'),
        'import { value } from "regular-dep"; console.log(value);',
      )

      const result = spawnSync(
        process.execPath,
        buildBaseArgs(source, destination, sourceNodeModules),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('restored closure packages: regular-dep')
      expect(result.stdout).not.toContain('restored closure packages: overlap')
      expect(result.stdout).toContain('staged CLI smoke output: regular-ok')
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(sourceNodeModules, { recursive: true, force: true })
      rmSync(destination, { recursive: true, force: true })
    }
  })

  it('treats transitive overlapping dependencies/optionalDependencies as optional', () => {
    const source = makeTemp('dsh-runtime-transitive-overlap-source')
    const sourceNodeModules = makeTemp('dsh-runtime-transitive-overlap-source-node-modules')
    const destination = makeTemp('dsh-runtime-transitive-overlap-dest')

    try {
      mkdirSync(join(source, 'lib'), { recursive: true })
      mkdirSync(join(source, 'config'), { recursive: true })
      mkdirSync(join(source, 'node_modules'), { recursive: true })
      writeJson(join(source, 'package.json'), {
        name: '@deepseek-ai/dsh',
        version: '4.2.0-test',
        dependencies: { 'direct-pkg': '^1.0.0' },
      })

      mkdirSync(join(source, 'node_modules', 'direct-pkg'), { recursive: true })
      writeJson(join(source, 'node_modules', 'direct-pkg', 'package.json'), {
        name: 'direct-pkg',
        type: 'module',
        exports: { '.': './index.mjs' },
        dependencies: { 'trans-overlap': '^1.0.0' },
        optionalDependencies: { 'trans-overlap': '^1.0.0' },
      })
      writeFileSync(
        join(source, 'node_modules', 'direct-pkg', 'index.mjs'),
        'export const value = "direct-ok";\n',
      )

      writeFileSync(
        join(source, 'lib', 'bin.js'),
        'import { value } from "direct-pkg"; console.log(value);',
      )

      const result = spawnSync(
        process.execPath,
        buildBaseArgs(source, destination, sourceNodeModules),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )

      expect(result.status).toBe(0)
      expect(result.stdout).not.toContain('restored closure packages: trans-overlap')
      expect(result.stdout).toContain('staged CLI smoke output: direct-ok')
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(sourceNodeModules, { recursive: true, force: true })
      rmSync(destination, { recursive: true, force: true })
    }
  })

  it('restores required peer dependencies and fails when a required peer is missing', () => {
    const source = makeTemp('dsh-runtime-peer-source')
    const sourceNodeModules = makeTemp('dsh-runtime-peer-source-node-modules')
    const virtualStore = makeTemp('dsh-runtime-peer-virtual-store')
    const destination = makeTemp('dsh-runtime-peer-dest')

    try {
      mkdirSync(join(source, 'lib'), { recursive: true })
      mkdirSync(join(source, 'config'), { recursive: true })
      mkdirSync(join(source, 'node_modules'), { recursive: true })
      writeJson(join(source, 'package.json'), {
        name: '@deepseek-ai/dsh',
        version: '5.0.0-test',
        dependencies: { 'direct-pkg': '^1.0.0' },
      })

      // Model pnpm's virtual-store layout for the peer-positive case.
      const directPkgReal = join(virtualStore, 'direct-pkg@1.0.0', 'node_modules', 'direct-pkg')
      mkdirSync(directPkgReal, { recursive: true })
      writeJson(join(directPkgReal, 'package.json'), {
        name: 'direct-pkg',
        type: 'module',
        exports: { '.': './index.mjs' },
        peerDependencies: { 'peer-pkg': '^1.0.0' },
      })
      writeFileSync(
        join(directPkgReal, 'index.mjs'),
        'export * from "peer-pkg";\n',
      )
      symlinkSync(directPkgReal, join(source, 'node_modules', 'direct-pkg'), 'junction')

      const peerPkgReal = join(virtualStore, 'direct-pkg@1.0.0', 'node_modules', 'peer-pkg')
      mkdirSync(peerPkgReal, { recursive: true })
      writeJson(join(peerPkgReal, 'package.json'), {
        name: 'peer-pkg',
        type: 'module',
        exports: { '.': './index.mjs' },
      })
      writeFileSync(
        join(peerPkgReal, 'index.mjs'),
        'export const value = "peer-ok";\n',
      )

      writeFileSync(
        join(source, 'lib', 'bin.js'),
        'import { value } from "direct-pkg"; console.log(value);',
      )

      const result = spawnSync(
        process.execPath,
        buildBaseArgs(source, destination, sourceNodeModules),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('restored closure packages: peer-pkg')
      expect(result.stdout).toContain('staged CLI smoke output: peer-ok')
      expect(lstatSync(join(destination, 'node_modules', 'peer-pkg', 'index.mjs')).isFile()).toBe(true)
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(sourceNodeModules, { recursive: true, force: true })
      rmSync(virtualStore, { recursive: true, force: true })
      rmSync(destination, { recursive: true, force: true })
    }
  })

  it('fails when a regular dependency is missing', () => {
    const source = makeTemp('dsh-runtime-missing-dep-source')
    const sourceNodeModules = makeTemp('dsh-runtime-missing-dep-source-node-modules')
    const destination = makeTemp('dsh-runtime-missing-dep-dest')

    try {
      mkdirSync(join(source, 'lib'), { recursive: true })
      mkdirSync(join(source, 'config'), { recursive: true })
      mkdirSync(join(source, 'node_modules'), { recursive: true })
      writeJson(join(source, 'package.json'), {
        name: '@deepseek-ai/dsh',
        version: '6.0.0-test',
        dependencies: { 'missing-dep': '^1.0.0' },
      })

      const result = spawnSync(
        process.execPath,
        buildBaseArgs(source, destination, sourceNodeModules),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('missing-dep not found')
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(sourceNodeModules, { recursive: true, force: true })
      rmSync(destination, { recursive: true, force: true })
    }
  })

  it('fails when a required peer dependency is missing', () => {
    const source = makeTemp('dsh-runtime-missing-peer-source')
    const sourceNodeModules = makeTemp('dsh-runtime-missing-peer-source-node-modules')
    const destination = makeTemp('dsh-runtime-missing-peer-dest')

    try {
      mkdirSync(join(source, 'lib'), { recursive: true })
      mkdirSync(join(source, 'config'), { recursive: true })
      mkdirSync(join(source, 'node_modules'), { recursive: true })
      writeJson(join(source, 'package.json'), {
        name: '@deepseek-ai/dsh',
        version: '7.0.0-test',
        dependencies: { 'direct-pkg': '^1.0.0' },
      })

      mkdirSync(join(source, 'node_modules', 'direct-pkg'), { recursive: true })
      writeJson(join(source, 'node_modules', 'direct-pkg', 'package.json'), {
        name: 'direct-pkg',
        type: 'module',
        exports: { '.': './index.mjs' },
        peerDependencies: { 'missing-peer': '^1.0.0' },
      })

      const result = spawnSync(
        process.execPath,
        buildBaseArgs(source, destination, sourceNodeModules),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('missing-peer not found')
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(sourceNodeModules, { recursive: true, force: true })
      rmSync(destination, { recursive: true, force: true })
    }
  })

  it('resolves packages that do not export ./package.json in their exports field', () => {
    const source = makeTemp('dsh-runtime-exports-source')
    const sourceNodeModules = makeTemp('dsh-runtime-exports-source-node-modules')
    const destination = makeTemp('dsh-runtime-exports-dest')

    try {
      mkdirSync(join(source, 'lib'), { recursive: true })
      mkdirSync(join(source, 'config'), { recursive: true })
      mkdirSync(join(source, 'node_modules'), { recursive: true })
      writeJson(join(source, 'package.json'), {
        name: '@deepseek-ai/dsh',
        version: '8.0.0-test',
        dependencies: { 'exports-pkg': '^1.0.0' },
      })

      // exports-pkg restricts exports to the main entry only; ./package.json
      // is not exported, so require.resolve('exports-pkg/package.json') would
      // fail. The materializer must still find the package directory.
      mkdirSync(join(sourceNodeModules, 'exports-pkg'), { recursive: true })
      writeJson(join(sourceNodeModules, 'exports-pkg', 'package.json'), {
        name: 'exports-pkg',
        type: 'module',
        exports: { '.': { import: './index.mjs' } },
      })
      writeFileSync(
        join(sourceNodeModules, 'exports-pkg', 'index.mjs'),
        'export const value = "exports-ok";\n',
      )

      writeFileSync(
        join(source, 'lib', 'bin.js'),
        'import { value } from "exports-pkg"; console.log(value);',
      )

      const result = spawnSync(
        process.execPath,
        buildBaseArgs(source, destination, sourceNodeModules),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('restored closure packages: exports-pkg')
      expect(result.stdout).toContain('staged CLI smoke output: exports-ok')
      expect(lstatSync(join(destination, 'node_modules', 'exports-pkg', 'index.mjs')).isFile()).toBe(true)
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(sourceNodeModules, { recursive: true, force: true })
      rmSync(destination, { recursive: true, force: true })
    }
  })

  it('fails when the same package name resolves to different realpaths', () => {
    const source = makeTemp('dsh-runtime-conflict-source')
    const sourceNodeModules = makeTemp('dsh-runtime-conflict-source-node-modules')
    const destination = makeTemp('dsh-runtime-conflict-dest')

    try {
      mkdirSync(join(source, 'lib'), { recursive: true })
      mkdirSync(join(source, 'config'), { recursive: true })
      mkdirSync(join(source, 'node_modules'), { recursive: true })
      writeJson(join(source, 'package.json'), {
        name: '@deepseek-ai/dsh',
        version: '9.0.0-test',
        dependencies: { 'dep-a': '^1.0.0', 'dep-b': '^1.0.0' },
      })

      mkdirSync(join(source, 'node_modules', 'dep-a'), { recursive: true })
      writeJson(join(source, 'node_modules', 'dep-a', 'package.json'), {
        name: 'dep-a',
        type: 'module',
        dependencies: { 'shared-pkg': '^1.0.0' },
      })
      mkdirSync(join(source, 'node_modules', 'dep-a', 'node_modules', 'shared-pkg'), { recursive: true })
      writeJson(join(source, 'node_modules', 'dep-a', 'node_modules', 'shared-pkg', 'package.json'), {
        name: 'shared-pkg',
        version: '1.0.0',
      })

      mkdirSync(join(source, 'node_modules', 'dep-b'), { recursive: true })
      writeJson(join(source, 'node_modules', 'dep-b', 'package.json'), {
        name: 'dep-b',
        type: 'module',
        dependencies: { 'shared-pkg': '^2.0.0' },
      })
      mkdirSync(join(source, 'node_modules', 'dep-b', 'node_modules', 'shared-pkg'), { recursive: true })
      writeJson(join(source, 'node_modules', 'dep-b', 'node_modules', 'shared-pkg', 'package.json'), {
        name: 'shared-pkg',
        version: '2.0.0',
      })

      const result = spawnSync(
        process.execPath,
        buildBaseArgs(source, destination, sourceNodeModules),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('shared-pkg')
      expect(result.stderr).toContain('conflicting realpaths')
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(sourceNodeModules, { recursive: true, force: true })
      rmSync(destination, { recursive: true, force: true })
    }
  })

  it('fails when staging root and virtual-store parent resolve the same name to different realpaths', () => {
    const source = makeTemp('dsh-runtime-virtual-store-conflict-source')
    const sourceNodeModules = makeTemp('dsh-runtime-virtual-store-conflict-source-node-modules')
    const virtualStore = makeTemp('dsh-runtime-virtual-store-conflict-virtual-store')
    const destination = makeTemp('dsh-runtime-virtual-store-conflict-dest')

    try {
      mkdirSync(join(source, 'lib'), { recursive: true })
      mkdirSync(join(source, 'config'), { recursive: true })
      mkdirSync(join(source, 'node_modules'), { recursive: true })
      writeJson(join(source, 'package.json'), {
        name: '@deepseek-ai/dsh',
        version: '9.1.0-test',
        dependencies: { 'direct-pkg': '^1.0.0', 'shared-pkg': '^1.0.0' },
      })

      // Staging root has shared-pkg v1 as a direct dependency.
      mkdirSync(join(source, 'node_modules', 'shared-pkg'), { recursive: true })
      writeJson(join(source, 'node_modules', 'shared-pkg', 'package.json'), {
        name: 'shared-pkg',
        version: '1.0.0',
        type: 'module',
      })

      // direct-pkg lives in the virtual store and depends on shared-pkg v2 in
      // its own context. Because it is a transitive dependency, the parent
      // context must be consulted before the staging root.
      const directPkgReal = join(virtualStore, 'direct-pkg@1.0.0', 'node_modules', 'direct-pkg')
      mkdirSync(directPkgReal, { recursive: true })
      writeJson(join(directPkgReal, 'package.json'), {
        name: 'direct-pkg',
        version: '1.0.0',
        type: 'module',
        dependencies: { 'shared-pkg': '^2.0.0' },
      })
      symlinkSync(directPkgReal, join(source, 'node_modules', 'direct-pkg'), 'junction')

      const sharedPkgV2Real = join(virtualStore, 'direct-pkg@1.0.0', 'node_modules', 'shared-pkg')
      mkdirSync(sharedPkgV2Real, { recursive: true })
      writeJson(join(sharedPkgV2Real, 'package.json'), {
        name: 'shared-pkg',
        version: '2.0.0',
        type: 'module',
      })

      const result = spawnSync(
        process.execPath,
        buildBaseArgs(source, destination, sourceNodeModules),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('shared-pkg')
      expect(result.stderr).toContain('conflicting realpaths')
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(sourceNodeModules, { recursive: true, force: true })
      rmSync(virtualStore, { recursive: true, force: true })
      rmSync(destination, { recursive: true, force: true })
    }
  })

  it('fails when two unrelated realpaths share the same name and version', () => {
    const source = makeTemp('dsh-runtime-unrelated-alias-source')
    const sourceNodeModules = makeTemp('dsh-runtime-unrelated-alias-source-node-modules')
    const destination = makeTemp('dsh-runtime-unrelated-alias-dest')

    try {
      mkdirSync(join(source, 'lib'), { recursive: true })
      mkdirSync(join(source, 'config'), { recursive: true })
      mkdirSync(join(source, 'node_modules'), { recursive: true })
      writeJson(join(source, 'package.json'), {
        name: '@deepseek-ai/dsh',
        version: '9.3.0-test',
        dependencies: { 'dep-a': '^1.0.0', 'dep-b': '^1.0.0' },
      })

      mkdirSync(join(source, 'node_modules', 'dep-a'), { recursive: true })
      writeJson(join(source, 'node_modules', 'dep-a', 'package.json'), {
        name: 'dep-a',
        type: 'module',
        dependencies: { 'shared-pkg': '^1.0.0' },
      })
      mkdirSync(join(source, 'node_modules', 'dep-a', 'node_modules', 'shared-pkg'), { recursive: true })
      writeJson(join(source, 'node_modules', 'dep-a', 'node_modules', 'shared-pkg', 'package.json'), {
        name: 'shared-pkg',
        version: '1.0.0',
        type: 'module',
      })

      mkdirSync(join(source, 'node_modules', 'dep-b'), { recursive: true })
      writeJson(join(source, 'node_modules', 'dep-b', 'package.json'), {
        name: 'dep-b',
        type: 'module',
        dependencies: { 'shared-pkg': '^1.0.0' },
      })
      mkdirSync(join(source, 'node_modules', 'dep-b', 'node_modules', 'shared-pkg'), { recursive: true })
      writeJson(join(source, 'node_modules', 'dep-b', 'node_modules', 'shared-pkg', 'package.json'), {
        name: 'shared-pkg',
        version: '1.0.0',
        type: 'module',
      })

      const result = spawnSync(
        process.execPath,
        buildBaseArgs(source, destination, sourceNodeModules),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('shared-pkg')
      expect(result.stderr).toContain('conflicting realpaths')
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(sourceNodeModules, { recursive: true, force: true })
      rmSync(destination, { recursive: true, force: true })
    }
  })

  it('accepts a pnpm source alias reached before the hoisted staging copy', () => {
    const source = makeTemp('dsh-runtime-pnpm-alias-source')
    const workspaceRoot = makeTemp('dsh-runtime-pnpm-alias-workspace-root')
    const sourceNodeModules = join(workspaceRoot, 'source-node-modules')
    const destination = makeTemp('dsh-runtime-pnpm-alias-dest')

    try {
      mkdirSync(sourceNodeModules, { recursive: true })
      mkdirSync(join(source, 'lib'), { recursive: true })
      mkdirSync(join(source, 'config'), { recursive: true })
      mkdirSync(join(source, 'node_modules'), { recursive: true })
      // List parent-pkg first so it is queued before the direct js-yaml root
      // dependency. js-yaml is then reached transitively through the pnpm
      // virtual-store context before the staging root copy is examined.
      writeJson(join(source, 'package.json'), {
        name: '@deepseek-ai/dsh',
        version: '9.4.0-test',
        dependencies: { 'parent-pkg': '^1.0.0', 'js-yaml': '^4.2.0' },
      })

      const pnpmStore = join(workspaceRoot, 'node_modules', '.pnpm')

      // js-yaml in the pnpm store.
      const jsYamlStore = join(pnpmStore, 'js-yaml@4.2.0', 'node_modules', 'js-yaml')
      mkdirSync(jsYamlStore, { recursive: true })
      writeJson(join(jsYamlStore, 'package.json'), {
        name: 'js-yaml',
        version: '4.2.0',
        type: 'module',
        exports: { '.': './index.mjs' },
      })
      writeFileSync(join(jsYamlStore, 'index.mjs'), 'export const value = "yaml-ok";\n')
      symlinkSync(jsYamlStore, join(sourceNodeModules, 'js-yaml'), 'junction')

      // parent-pkg in the pnpm store depends on the same js-yaml store entry.
      const parentPkgStore = join(pnpmStore, 'parent-pkg@1.0.0', 'node_modules', 'parent-pkg')
      mkdirSync(parentPkgStore, { recursive: true })
      writeJson(join(parentPkgStore, 'package.json'), {
        name: 'parent-pkg',
        version: '1.0.0',
        type: 'module',
        exports: { '.': './index.mjs' },
        dependencies: { 'js-yaml': '^4.2.0' },
      })
      writeFileSync(join(parentPkgStore, 'index.mjs'), 'export * from "js-yaml";\n')
      mkdirSync(join(parentPkgStore, 'node_modules'), { recursive: true })
      symlinkSync(jsYamlStore, join(parentPkgStore, 'node_modules', 'js-yaml'), 'junction')
      symlinkSync(parentPkgStore, join(sourceNodeModules, 'parent-pkg'), 'junction')

      // Staging root has hoisted real copies with no nested node_modules.
      mkdirSync(join(source, 'node_modules', 'js-yaml'), { recursive: true })
      writeJson(join(source, 'node_modules', 'js-yaml', 'package.json'), {
        name: 'js-yaml',
        version: '4.2.0',
        type: 'module',
        exports: { '.': './index.mjs' },
      })
      writeFileSync(join(source, 'node_modules', 'js-yaml', 'index.mjs'), 'export const value = "yaml-ok";\n')

      mkdirSync(join(source, 'node_modules', 'parent-pkg'), { recursive: true })
      writeJson(join(source, 'node_modules', 'parent-pkg', 'package.json'), {
        name: 'parent-pkg',
        version: '1.0.0',
        type: 'module',
        exports: { '.': './index.mjs' },
        dependencies: { 'js-yaml': '^4.2.0' },
      })
      writeFileSync(join(source, 'node_modules', 'parent-pkg', 'index.mjs'), 'export * from "js-yaml";\n')

      writeFileSync(
        join(source, 'lib', 'bin.js'),
        'import { value as direct } from "js-yaml"; import { value as indirect } from "parent-pkg"; console.log(`${direct}:${indirect}`);',
      )

      const result = spawnSync(
        process.execPath,
        buildBaseArgs(source, destination, sourceNodeModules),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('staged CLI smoke output: yaml-ok:yaml-ok')
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(workspaceRoot, { recursive: true, force: true })
      rmSync(destination, { recursive: true, force: true })
    }
  })

  it('accepts identical staging and pnpm payloads when an explicit source copy masks fallback identity', () => {
    const result = runMaskedPnpmAliasFixture()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('staged CLI smoke output: yaml-ok:yaml-ok')
  })

  it('rejects matching link text whose targets escape their package roots', () => {
    const result = runMaskedPnpmAliasFixture(({ workspaceRoot, stagingPackage, pnpmPackage }) => {
      if (process.platform === 'win32') {
        const sharedTarget = join(workspaceRoot, 'shared-link-target')
        mkdirSync(sharedTarget, { recursive: true })
        symlinkSync(sharedTarget, join(stagingPackage, 'payload-link'), 'junction')
        symlinkSync(sharedTarget, join(pnpmPackage, 'payload-link'), 'junction')
        return
      }

      const relativeTarget = '../outside-target'
      mkdirSync(join(stagingPackage, relativeTarget), { recursive: true })
      mkdirSync(join(pnpmPackage, relativeTarget), { recursive: true })
      symlinkSync(relativeTarget, join(stagingPackage, 'payload-link'), 'dir')
      symlinkSync(relativeTarget, join(pnpmPackage, 'payload-link'), 'dir')
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('conflicting realpaths')
  })

  it('rejects payload links whose targets escape the workspace', () => {
    const externalTarget = makeTemp('dsh-runtime-payload-link-external')
    try {
      const result = runMaskedPnpmAliasFixture(({ stagingPackage, pnpmPackage }) => {
        symlinkSync(externalTarget, join(stagingPackage, 'payload-link'), process.platform === 'win32' ? 'junction' : 'dir')
        symlinkSync(externalTarget, join(pnpmPackage, 'payload-link'), process.platform === 'win32' ? 'junction' : 'dir')
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('conflicting realpaths')
    } finally {
      rmSync(externalTarget, { recursive: true, force: true })
    }
  })

  it('rejects unrelated same-version packages across multiple source roots', () => {
    const source = makeTemp('dsh-runtime-multi-root-alias-source')
    const workspaceRoot = makeTemp('dsh-runtime-multi-root-alias-workspace-root')
    const sourceNodeModules = join(workspaceRoot, 'source-node-modules')
    const fallbackNodeModules = join(workspaceRoot, 'node_modules')
    const destination = makeTemp('dsh-runtime-multi-root-alias-dest')

    try {
      mkdirSync(sourceNodeModules, { recursive: true })
      mkdirSync(fallbackNodeModules, { recursive: true })
      mkdirSync(join(source, 'lib'), { recursive: true })
      mkdirSync(join(source, 'config'), { recursive: true })
      mkdirSync(join(source, 'node_modules'), { recursive: true })
      writeJson(join(source, 'package.json'), {
        name: '@deepseek-ai/dsh',
        version: '9.6.0-test',
        dependencies: { 'parent-pkg': '^1.0.0', 'js-yaml': '^4.2.0' },
      })

      // The explicit source root has a real-directory copy of js-yaml v4.2.0.
      mkdirSync(join(sourceNodeModules, 'js-yaml'), { recursive: true })
      writeJson(join(sourceNodeModules, 'js-yaml', 'package.json'), {
        name: 'js-yaml',
        version: '4.2.0',
        type: 'module',
        exports: { '.': './index.mjs' },
      })
      writeFileSync(join(sourceNodeModules, 'js-yaml', 'index.mjs'), 'export const value = "source-root";\n')

      // The fallback root exposes the same version through a pnpm-store junction.
      const pnpmStore = join(fallbackNodeModules, '.pnpm')
      const jsYamlStore = join(pnpmStore, 'js-yaml@4.2.0', 'node_modules', 'js-yaml')
      mkdirSync(jsYamlStore, { recursive: true })
      writeJson(join(jsYamlStore, 'package.json'), {
        name: 'js-yaml',
        version: '4.2.0',
        type: 'module',
        exports: { '.': './index.mjs' },
      })
      writeFileSync(join(jsYamlStore, 'index.mjs'), 'export const value = "fallback-root";\n')
      symlinkSync(jsYamlStore, join(fallbackNodeModules, 'js-yaml'), 'junction')

      const parentPkgStore = join(pnpmStore, 'parent-pkg@1.0.0', 'node_modules', 'parent-pkg')
      mkdirSync(parentPkgStore, { recursive: true })
      writeJson(join(parentPkgStore, 'package.json'), {
        name: 'parent-pkg',
        version: '1.0.0',
        type: 'module',
        exports: { '.': './index.mjs' },
        dependencies: { 'js-yaml': '^4.2.0' },
      })
      writeFileSync(join(parentPkgStore, 'index.mjs'), 'export * from "js-yaml";\n')
      mkdirSync(join(parentPkgStore, 'node_modules'), { recursive: true })
      symlinkSync(jsYamlStore, join(parentPkgStore, 'node_modules', 'js-yaml'), 'junction')
      symlinkSync(parentPkgStore, join(fallbackNodeModules, 'parent-pkg'), 'junction')

      mkdirSync(join(source, 'node_modules', 'js-yaml'), { recursive: true })
      writeJson(join(source, 'node_modules', 'js-yaml', 'package.json'), {
        name: 'js-yaml',
        version: '4.2.0',
        type: 'module',
        exports: { '.': './index.mjs' },
      })
      writeFileSync(join(source, 'node_modules', 'js-yaml', 'index.mjs'), 'export const value = "staging-root";\n')

      mkdirSync(join(source, 'node_modules', 'parent-pkg'), { recursive: true })
      writeJson(join(source, 'node_modules', 'parent-pkg', 'package.json'), {
        name: 'parent-pkg',
        version: '1.0.0',
        type: 'module',
        exports: { '.': './index.mjs' },
        dependencies: { 'js-yaml': '^4.2.0' },
      })
      writeFileSync(join(source, 'node_modules', 'parent-pkg', 'index.mjs'), 'export * from "js-yaml";\n')

      writeFileSync(
        join(source, 'lib', 'bin.js'),
        'import { value as direct } from "js-yaml"; import { value as indirect } from "parent-pkg"; console.log(`${direct}:${indirect}`);',
      )

      const result = spawnSync(
        process.execPath,
        buildBaseArgs(source, destination, sourceNodeModules, fallbackNodeModules),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('js-yaml')
      expect(result.stderr).toContain('conflicting realpaths')
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(workspaceRoot, { recursive: true, force: true })
      rmSync(destination, { recursive: true, force: true })
    }
  })

  it('treats validated staging and source realpaths of the same package as equivalent aliases', () => {
    const source = makeTemp('dsh-runtime-equivalent-alias-source')
    const workspaceRoot = makeTemp('dsh-runtime-equivalent-alias-workspace-root')
    const sourceNodeModules = join(workspaceRoot, 'source-node-modules')
    const destination = makeTemp('dsh-runtime-equivalent-alias-dest')

    try {
      mkdirSync(sourceNodeModules, { recursive: true })
      mkdirSync(join(source, 'lib'), { recursive: true })
      mkdirSync(join(source, 'config'), { recursive: true })
      mkdirSync(join(source, 'node_modules'), { recursive: true })
      writeJson(join(source, 'package.json'), {
        name: '@deepseek-ai/dsh',
        version: '9.2.0-test',
        dependencies: { 'direct-pkg': '^1.0.0', 'shared-pkg': '^1.0.0' },
      })

      // Workspace packages live outside the source node_modules root and are
      // exposed through junctions. shared-pkg v1 is present both as a hoisted
      // real copy in staging and as a source junction to the same workspace
      // directory; direct-pkg transitively reaches shared-pkg through its own
      // source context.
      const workspaceSharedPkg = join(workspaceRoot, 'workspace-shared-pkg')
      mkdirSync(workspaceSharedPkg, { recursive: true })
      writeJson(join(workspaceSharedPkg, 'package.json'), {
        name: 'shared-pkg',
        version: '1.0.0',
        type: 'module',
        exports: { '.': './index.mjs' },
        dependencies: { 'nested-pkg': '^1.0.0' },
      })
      writeFileSync(join(workspaceSharedPkg, 'index.mjs'), 'export const value = "shared-ok";\n')
      mkdirSync(join(workspaceSharedPkg, 'node_modules', 'nested-pkg'), { recursive: true })
      writeJson(join(workspaceSharedPkg, 'node_modules', 'nested-pkg', 'package.json'), {
        name: 'nested-pkg',
        version: '1.0.0',
        type: 'module',
        exports: { '.': './index.mjs' },
      })
      writeFileSync(join(workspaceSharedPkg, 'node_modules', 'nested-pkg', 'index.mjs'), 'export const value = "nested-ok";\n')
      symlinkSync(workspaceSharedPkg, join(sourceNodeModules, 'shared-pkg'), 'junction')

      // Staging root has a hoisted real copy of shared-pkg v1 (no node_modules).
      mkdirSync(join(source, 'node_modules', 'shared-pkg'), { recursive: true })
      writeJson(join(source, 'node_modules', 'shared-pkg', 'package.json'), {
        name: 'shared-pkg',
        version: '1.0.0',
        type: 'module',
        exports: { '.': './index.mjs' },
        dependencies: { 'nested-pkg': '^1.0.0' },
      })
      writeFileSync(join(source, 'node_modules', 'shared-pkg', 'index.mjs'), 'export const value = "shared-ok";\n')

      const workspaceDirectPkg = join(workspaceRoot, 'workspace-direct-pkg')
      mkdirSync(workspaceDirectPkg, { recursive: true })
      writeJson(join(workspaceDirectPkg, 'package.json'), {
        name: 'direct-pkg',
        version: '1.0.0',
        type: 'module',
        exports: { '.': './index.mjs' },
        dependencies: { 'shared-pkg': '^1.0.0' },
      })
      writeFileSync(join(workspaceDirectPkg, 'index.mjs'), 'export * from "shared-pkg";\n')
      mkdirSync(join(workspaceDirectPkg, 'node_modules'), { recursive: true })
      symlinkSync(workspaceSharedPkg, join(workspaceDirectPkg, 'node_modules', 'shared-pkg'), 'junction')
      symlinkSync(workspaceDirectPkg, join(sourceNodeModules, 'direct-pkg'), 'junction')

      // The staging copy of direct-pkg is a real directory (hoisted deploy).
      mkdirSync(join(source, 'node_modules', 'direct-pkg'), { recursive: true })
      writeJson(join(source, 'node_modules', 'direct-pkg', 'package.json'), {
        name: 'direct-pkg',
        version: '1.0.0',
        type: 'module',
        exports: { '.': './index.mjs' },
        dependencies: { 'shared-pkg': '^1.0.0' },
      })
      writeFileSync(join(source, 'node_modules', 'direct-pkg', 'index.mjs'), 'export * from "shared-pkg";\n')

      writeFileSync(
        join(source, 'lib', 'bin.js'),
        'import { value as direct } from "direct-pkg"; import { value as shared } from "shared-pkg"; console.log(`${direct}:${shared}`);',
      )

      const result = spawnSync(
        process.execPath,
        buildBaseArgs(source, destination, sourceNodeModules),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('restored closure packages: nested-pkg')
      expect(result.stdout).toContain('staged CLI smoke output: shared-ok:shared-ok')
      expect(lstatSync(join(destination, 'node_modules', 'nested-pkg', 'index.mjs')).isFile()).toBe(true)
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(workspaceRoot, { recursive: true, force: true })
      rmSync(destination, { recursive: true, force: true })
    }
  })

  it('copies sibling aliases of one directory without dropping entries', () => {
    const source = makeTemp('dsh-runtime-alias-source')
    const sourceNodeModules = makeTemp('dsh-runtime-alias-source-node-modules')
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
        buildBaseArgs(source, destination, sourceNodeModules),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )

      expect(result.status).toBe(0)
      for (const alias of ['first-alias', 'second-alias']) {
        expect(lstatSync(join(destination, 'node_modules', alias, 'first.js')).isFile()).toBe(true)
        expect(lstatSync(join(destination, 'node_modules', alias, 'nested', 'second.js')).isFile()).toBe(true)
      }
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(sourceNodeModules, { recursive: true, force: true })
      rmSync(external, { recursive: true, force: true })
      rmSync(destination, { recursive: true, force: true })
    }
  })

  it('fails when the source is missing required entries', () => {
    const source = makeTemp('dsh-runtime-bad-source')
    const sourceNodeModules = makeTemp('dsh-runtime-bad-source-node-modules')
    const destination = makeTemp('dsh-runtime-bad-dest')

    try {
      mkdirSync(join(source, 'lib'), { recursive: true })
      // package.json, config, and node_modules are intentionally absent.
      const result = spawnSync(
        process.execPath,
        buildBaseArgs(source, destination, sourceNodeModules),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('required entry missing')
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(sourceNodeModules, { recursive: true, force: true })
      rmSync(destination, { recursive: true, force: true })
    }
  })
})
