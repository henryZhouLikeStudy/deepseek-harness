#!/usr/bin/env node
/**
 * Materialize a pnpm-deployed dsh runtime into a self-contained, relocatable tree.
 *
 * `pnpm deploy --legacy` leaves symlinks/junctions that point outside the target
 * directory (workspace links, vendor overrides, .pnpm virtual-store entries) and
 * may contain cyclic peer-dependency symlinks. This script copies the deploy tree
 * while dereferencing every symlink and junction, deduplicating already-copied
 * directories, and hard-linking files when possible so the operation stays fast.
 * After copying it asserts that no symlink or junction remains and boots the
 * staged CLI with `--version`.
 *
 * Usage:
 *   node scripts/materialize-desktop-runtime.mjs --from <staging-dir> --to <runtime-dir>
 */

import { spawnSync } from 'node:child_process'
import {
  cp,
  lstat,
  link,
  mkdir,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises'
import { resolve, join } from 'node:path'

const REQUIRED_ROOT_ENTRIES = ['package.json', 'lib', 'config', 'node_modules']
const COPY_CONCURRENCY = 64

function usage() {
  return 'Usage: node scripts/materialize-desktop-runtime.mjs --from <staging-dir> --to <runtime-dir>'
}

function parseArgs(argv) {
  let from
  let to
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--from') {
      from = argv[index + 1]
      index += 1
    } else if (flag === '--to') {
      to = argv[index + 1]
      index += 1
    }
  }
  if (typeof from !== 'string' || typeof to !== 'string') {
    throw new Error(usage())
  }
  return { from: resolve(from), to: resolve(to) }
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

async function materialize(from, to) {
  console.log(`[materialize] from: ${from}`)
  console.log(`[materialize]   to: ${to}`)

  await assertRequiredEntries(from)

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
  console.log(`[materialize] verifying staged CLI: ${bin} --version`)
  const result = spawnSync(process.execPath, [bin, '--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? ''
    const stdout = result.stdout?.trim() ?? ''
    throw new Error(
      `staged CLI --version failed (exit ${result.status}): ${stderr || stdout}`,
    )
  }
  const version = result.stdout.trim()
  console.log(`[materialize] staged CLI version: ${version}`)
  console.log(`[materialize] ok: ${to} is fully materialized`)
}

const { from, to } = parseArgs(process.argv.slice(2))
materialize(from, to).catch((error) => {
  console.error(`[materialize] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
