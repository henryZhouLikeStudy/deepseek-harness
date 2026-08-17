#!/usr/bin/env node
/**
 * Materialize a pnpm-deployed dsh runtime into a self-contained, relocatable tree.
 *
 * `pnpm deploy --legacy` leaves symlinks/junctions that point outside the target
 * directory (workspace links, vendor overrides, .pnpm virtual-store entries) and
 * may contain cyclic peer-dependency symlinks. It can also omit transitive
 * workspace packages from the staging root, leaving them only in the source
 * manifest's `node_modules` or the workspace root. This script first builds the
 * full production + required peer dependency closure from the staged manifest
 * and copies any missing packages into the staging root, then copies the deploy
 * tree while dereferencing every symlink and junction, deduplicating
 * already-copied directories, and hard-linking files when possible so the
 * operation stays fast. After copying it asserts that no symlink or junction
 * remains and boots the staged CLI with a configurable smoke command.
 *
 * Usage:
 *   node scripts/materialize-desktop-runtime.mjs --from <staging-dir> --to <runtime-dir> --source-node-modules <source-node-modules> [--fallback-node-modules <fallback-node-modules>] [--smoke-command <smoke-command>]
 */

import { spawnSync } from 'node:child_process'
import {
  cp,
  lstat,
  link,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve, join, sep } from 'node:path'

const REQUIRED_ROOT_ENTRIES = ['package.json', 'lib', 'config', 'node_modules']
const COPY_CONCURRENCY = 64

function usage() {
  return 'Usage: node scripts/materialize-desktop-runtime.mjs --from <staging-dir> --to <runtime-dir> --source-node-modules <source-node-modules> [--fallback-node-modules <fallback-node-modules>] [--smoke-command <smoke-command>]'
}

function parseArgs(argv) {
  let from
  let to
  let sourceNodeModules
  /** @type {string | undefined} */
  let fallbackNodeModules
  /** @type {string | undefined} */
  let smokeCommand
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--from') {
      from = argv[index + 1]
      index += 1
    } else if (flag === '--to') {
      to = argv[index + 1]
      index += 1
    } else if (flag === '--source-node-modules') {
      sourceNodeModules = argv[index + 1]
      index += 1
    } else if (flag === '--fallback-node-modules') {
      fallbackNodeModules = argv[index + 1]
      index += 1
    } else if (flag === '--smoke-command') {
      smokeCommand = argv[index + 1]
      index += 1
    }
  }
  if (typeof from !== 'string' || typeof to !== 'string' || typeof sourceNodeModules !== 'string') {
    throw new Error(usage())
  }
  return {
    from: resolve(from),
    to: resolve(to),
    sourceNodeModules: resolve(sourceNodeModules),
    fallbackNodeModules: fallbackNodeModules !== undefined ? resolve(fallbackNodeModules) : undefined,
    smokeCommand: smokeCommand ?? '--version',
  }
}

async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Return the real path of `path`, or `path` itself if realpath fails.
 * @param {string} path
 * @returns {Promise<string>}
 */
async function safeRealpath(path) {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

async function* walk(root) {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      yield* walk(path)
    }
    yield { path, dirent: entry }
  }
}

async function assertRequiredEntries(directory) {
  for (const name of REQUIRED_ROOT_ENTRIES) {
    const path = join(directory, name)
    if (!(await pathExists(path))) {
      throw new Error(`required entry missing: ${path}`)
    }
  }
}

async function assertNoSymbolicLinks(directory) {
  let count = 0
  /** @type {string | undefined} */
  let first
  for await (const { path, dirent } of walk(directory)) {
    if (dirent.isSymbolicLink()) {
      count += 1
      first ??= path
    }
  }
  if (count > 0) {
    throw new Error(
      `found ${count} symlink/junction entries in materialized runtime; first: ${first}`,
    )
  }
}

/**
 * Run an array of async tasks with a bounded concurrency.
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} concurrency
 * @returns {Promise<T[]>}
 */
async function mapLimit(tasks, concurrency) {
  const results = new Array(tasks.length)
  let index = 0

  async function worker() {
    while (index < tasks.length) {
      const current = index
      index += 1
      results[current] = await tasks[current]()
    }
  }

  const workers = []
  for (let workerIndex = 0; workerIndex < Math.min(concurrency, tasks.length); workerIndex += 1) {
    workers.push(worker())
  }
  await Promise.all(workers)
  return results
}

/**
 * Create a hard link from source to destination, falling back to a copy when
 * hard links are not supported across the relevant boundaries.
 * @param {string} source
 * @param {string} destination
 */
async function linkOrCopyFile(source, destination) {
  try {
    await link(source, destination)
    return
  } catch {
    // Hard links are an optimization. They may fail when the source already
    // has the maximum number of links, spans devices, or is refused by the
    // filesystem. Fall back to a plain copy and keep going.
  }
  await cp(source, destination)
}

/**
 * Recursively mirror one already-materialized directory into another using hard
 * links for files. This is used after a source directory has been copied once,
 * so later symlinks that resolve to the same real directory can be materialized
 * without duplicating file contents.
 * @param {string} source
 * @param {string} destination
 */
async function mirrorDir(source, destination) {
  await mkdir(destination, { recursive: true })
  const entries = await readdir(source, { withFileTypes: true })
  const tasks = entries.map((entry) => async () => {
    const sourcePath = join(source, entry.name)
    const destinationPath = join(destination, entry.name)
    if (entry.isDirectory()) {
      await mirrorDir(sourcePath, destinationPath)
    } else {
      await linkOrCopyFile(sourcePath, destinationPath)
    }
  })
  await mapLimit(tasks, COPY_CONCURRENCY)
}

/**
 * Recursively copy a source path into the destination, dereferencing symlinks.
 * @param {string} source - source path to copy.
 * @param {string} destination - destination path to create.
 * @param {Set<string>} copying - realpaths of directories on this recursion branch.
 * @param {Map<string, Promise<string>>} copied - realpath -> completed copy promise.
 */
async function copyDereferenced(source, destination, copying, copied) {
  let sourceReal
  try {
    sourceReal = await realpath(source)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ELOOP') {
      return
    }
    throw error
  }

  const stat = await lstat(sourceReal)

  if (stat.isDirectory()) {
    if (copying.has(sourceReal)) {
      return
    }
    const existing = copied.get(sourceReal)
    if (existing !== undefined) {
      await mirrorDir(await existing, destination)
      return
    }
    const nextCopying = new Set(copying)
    nextCopying.add(sourceReal)
    let resolveCopy
    let rejectCopy
    const copyComplete = new Promise((resolvePromise, rejectPromise) => {
      resolveCopy = resolvePromise
      rejectCopy = rejectPromise
    })
    copied.set(sourceReal, copyComplete)
    try {
      await mkdir(destination, { recursive: true })
      const entries = await readdir(sourceReal, { withFileTypes: true })
      const tasks = entries.map((entry) => async () => {
        await copyDereferenced(
          join(sourceReal, entry.name),
          join(destination, entry.name),
          nextCopying,
          copied,
        )
      })
      await mapLimit(tasks, COPY_CONCURRENCY)
      resolveCopy(destination)
    } catch (error) {
      copied.delete(sourceReal)
      rejectCopy(error)
      throw error
    }
    return
  }

  if (stat.isFile()) {
    await linkOrCopyFile(sourceReal, destination)
    return
  }

  console.log(`[materialize] skipping unsupported entry: ${sourceReal}`)
}

/**
 * Resolve the source node_modules directories used to restore missing packages.
 * Only the explicit source package's node_modules and the optional fallback
 * (repository root) node_modules are consulted; we never walk outside the workspace.
 * @param {string} sourceNodeModules
 * @param {string | undefined} fallbackNodeModules
 * @returns {string[]}
 */
function resolveSourceDirs(sourceNodeModules, fallbackNodeModules) {
  const dirs = [sourceNodeModules]
  if (fallbackNodeModules !== undefined && fallbackNodeModules !== sourceNodeModules) {
    dirs.push(fallbackNodeModules)
  }
  return dirs
}

/**
 * Return the workspace root used to bound Node resolution. When a fallback
 * (repository root) node_modules is provided, its parent directory is the root;
 * otherwise the source node_modules parent is used as a conservative bound.
 * @param {string} sourceNodeModules
 * @param {string | undefined} fallbackNodeModules
 * @returns {string}
 */
function workspaceRoot(sourceNodeModules, fallbackNodeModules) {
  if (fallbackNodeModules !== undefined) return dirname(fallbackNodeModules)
  return dirname(sourceNodeModules)
}

/**
 * @param {string} path
 * @param {string} root
 * @returns {boolean}
 */
function withinWorkspace(path, root) {
  return path === root || path.startsWith(root + sep)
}

/**
 * Resolve a dependency of `parentDir` using Node module lookup paths (the same
 * paths `require.resolve` would search), bounded to the workspace root and
 * explicit source/fallback node_modules roots. This does not require the
 * package to export `./package.json`. If the dependency is already present in
 * the staging root it is left untouched.
 * @param {string} packageName
 * @param {string} parentDir - directory containing the parent package.json.
 * @param {string} stagingNodeModules
 * @param {string[]} sourceDirs
 * @param {string} workspaceRootDir
 * @returns {Promise<{ dir: string; realDir: string; copy: boolean } | undefined>}
 */
async function resolvePackageDir(packageName, parentDir, stagingNodeModules, sourceDirs, workspaceRootDir) {
  const stagingPath = join(stagingNodeModules, packageName)
  if (await pathExists(stagingPath)) {
    return { dir: stagingPath, realDir: await safeRealpath(stagingPath), copy: false }
  }

  const require = createRequire(join(parentDir, 'package.json'))
  const lookupPaths = require.resolve.paths(packageName) ?? []
  for (const lookupPath of lookupPaths) {
    if (!withinWorkspace(lookupPath, workspaceRootDir)) continue
    const candidate = join(lookupPath, packageName)
    if (await pathExists(candidate)) {
      const realDir = await safeRealpath(candidate)
      if (withinWorkspace(realDir, workspaceRootDir)) {
        return { dir: candidate, realDir, copy: true }
      }
    }
  }

  for (const dir of sourceDirs) {
    const candidate = join(dir, packageName)
    if (await pathExists(candidate)) {
      return { dir: candidate, realDir: await safeRealpath(candidate), copy: true }
    }
  }

  return undefined
}

/**
 * Build the complete runtime dependency closure of the staged package:
 * regular dependencies, optional dependencies, and required peer dependencies.
 * Each dependency is resolved relative to its parent package's directory so
 * package-local node_modules entries (pnpm virtual-store subdirectories) are
 * discovered correctly. Missing optional dependencies are skipped; missing
 * regular dependencies and required peer dependencies are fatal. If the same
 * package name resolves to different realpaths from different parent contexts,
 * an error is thrown. The returned map gives, for each package name, the source
 * directory, its realpath, and whether it needs to be copied into the staging root.
 * @param {string} staging
 * @param {string} sourceNodeModules
 * @param {string | undefined} fallbackNodeModules
 * @returns {Promise<Map<string, { dir: string; realDir: string; copy: boolean }>>}
 */
async function buildClosure(staging, sourceNodeModules, fallbackNodeModules) {
  const manifest = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8'))
  const stagingNodeModules = join(staging, 'node_modules')
  const sourceDirs = resolveSourceDirs(sourceNodeModules, fallbackNodeModules)
  const workspaceRootDir = workspaceRoot(sourceNodeModules, fallbackNodeModules)

  /** @type {Map<string, { dir: string; realDir: string; copy: boolean }>} */
  const closure = new Map()
  /** @type {Array<{ name: string; parentDir: string; kind: 'regular' | 'optional' | 'peer' }>} */
  const queue = []
  const rootOptionalDeps = new Set(Object.keys(manifest.optionalDependencies ?? {}))
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (!rootOptionalDeps.has(name)) {
      queue.push({ name, parentDir: staging, kind: 'regular' })
    }
  }
  for (const name of rootOptionalDeps) {
    queue.push({ name, parentDir: staging, kind: 'optional' })
  }
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    const meta = manifest.peerDependenciesMeta?.[name]
    if (meta?.optional !== true) {
      queue.push({ name, parentDir: staging, kind: 'peer' })
    }
  }

  while (queue.length > 0) {
    const { name, parentDir, kind } = queue.shift()

    const resolved = await resolvePackageDir(name, parentDir, stagingNodeModules, sourceDirs, workspaceRootDir)
    if (resolved === undefined) {
      if (kind === 'optional') continue
      throw new Error(`dependency ${name} not found in staging or source node_modules`)
    }

    const existing = closure.get(name)
    if (existing !== undefined) {
      if (existing.realDir !== resolved.realDir) {
        throw new Error(
          `dependency ${name} resolves to conflicting realpaths: ${existing.realDir} and ${resolved.realDir}`,
        )
      }
      continue
    }

    closure.set(name, resolved)

    const packageManifest = JSON.parse(await readFile(join(resolved.dir, 'package.json'), 'utf8'))
    const optionalDeps = new Set(Object.keys(packageManifest.optionalDependencies ?? {}))
    // npm semantics: a name present in both dependencies and optionalDependencies
    // is treated as optional, so exclude it from the regular queue.
    for (const dep of Object.keys(packageManifest.dependencies ?? {})) {
      if (!optionalDeps.has(dep)) {
        queue.push({ name: dep, parentDir: resolved.realDir, kind: 'regular' })
      }
    }
    for (const dep of optionalDeps) {
      queue.push({ name: dep, parentDir: resolved.realDir, kind: 'optional' })
    }
    for (const dep of Object.keys(packageManifest.peerDependencies ?? {})) {
      const meta = packageManifest.peerDependenciesMeta?.[dep]
      if (meta?.optional !== true) {
        queue.push({ name: dep, parentDir: resolved.realDir, kind: 'peer' })
      }
    }
  }

  return closure
}

/**
 * Ensure every package in the staged manifest's dependency closure is present
 * in the staging root node_modules. Packages already staged are left untouched;
 * missing ones are copied from the explicit source directories with symlinks
 * dereferenced and package-local node_modules trees omitted (dependencies are
 * hoisted to the staging root).
 * @param {string} staging
 * @param {string} sourceNodeModules
 * @param {string | undefined} fallbackNodeModules
 */
async function restoreClosure(staging, sourceNodeModules, fallbackNodeModules) {
  const closure = await buildClosure(staging, sourceNodeModules, fallbackNodeModules)
  const stagingNodeModules = join(staging, 'node_modules')
  const restored = []

  for (const [packageName, { dir: sourcePath, copy }] of closure) {
    if (!copy) continue
    const destination = join(stagingNodeModules, packageName)
    if (await pathExists(destination)) continue

    await mkdir(dirname(destination), { recursive: true })
    const nestedNodeModules = join(sourcePath, 'node_modules')
    await cp(sourcePath, destination, {
      recursive: true,
      dereference: true,
      filter: (path) => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    restored.push(packageName)
  }

  if (restored.length > 0) {
    console.log(`[materialize] restored closure packages: ${restored.join(', ')}`)
  }
}

async function materialize(from, to, sourceNodeModules, fallbackNodeModules, smokeCommand) {
  console.log(`[materialize] from: ${from}`)
  console.log(`[materialize]   to: ${to}`)

  await assertRequiredEntries(from)
  await restoreClosure(from, sourceNodeModules, fallbackNodeModules)

  if (await pathExists(to)) {
    console.log(`[materialize] removing existing destination`)
    await rm(to, { recursive: true, force: true })
  }

  console.log(`[materialize] copying with symlink dereferencing`)
  await mkdir(to, { recursive: true })
  const entries = await readdir(from, { withFileTypes: true })
  /** @type {Map<string, string>} */
  const copied = new Map()
  const tasks = entries.map((entry) => async () => {
    await copyDereferenced(join(from, entry.name), join(to, entry.name), new Set(), copied)
  })
  await mapLimit(tasks, COPY_CONCURRENCY)

  await assertRequiredEntries(to)
  await assertNoSymbolicLinks(to)

  const bin = join(to, 'lib', 'bin.js')
  const smokeArgs = smokeCommand.split(/\s+/).filter(Boolean)
  console.log(`[materialize] verifying staged CLI: ${bin} ${smokeArgs.join(' ')}`)
  const result = spawnSync(process.execPath, [bin, ...smokeArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? ''
    const stdout = result.stdout?.trim() ?? ''
    throw new Error(
      `staged CLI smoke failed (exit ${result.status}): ${stderr || stdout}`,
    )
  }
  const smokeOutput = result.stdout.trim()
  console.log(`[materialize] staged CLI smoke output: ${smokeOutput}`)
  console.log(`[materialize] ok: ${to} is fully materialized`)
}

const { from, to, sourceNodeModules, fallbackNodeModules, smokeCommand } = parseArgs(process.argv.slice(2))
materialize(from, to, sourceNodeModules, fallbackNodeModules, smokeCommand).catch((error) => {
  console.error(`[materialize] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
