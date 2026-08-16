import { app, BrowserWindow, dialog } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const READY_TIMEOUT_MS = 30_000
const URL_REGEX = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+)/

function resolveDshBin(): string {
  if (process.env.DSH_BIN) {
    return process.env.DSH_BIN
  }

  // Packaged app: dsh is shipped as an extra resource under Electron's resources dir.
  const packagedBin = path.join(process.resourcesPath, 'apps', 'cli', 'lib', 'bin.js')
  if (existsSync(packagedBin)) {
    return packagedBin
  }

  const packagedNodeModulesBin = path.join(process.resourcesPath, 'node_modules', '.bin', 'dsh')
  if (existsSync(packagedNodeModulesBin)) {
    return packagedNodeModulesBin
  }

  // Built main lives at apps/desktop/dist/main.js; three levels up reaches the repo root.
  const repoRelative = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'apps',
    'cli',
    'lib',
    'bin.js',
  )
  if (existsSync(repoRelative)) {
    return repoRelative
  }

  const nodeModulesBin = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'node_modules',
    '.bin',
    'dsh',
  )
  if (existsSync(nodeModulesBin)) {
    return nodeModulesBin
  }

  return repoRelative
}

function fail(message: string): void {
  dialog.showErrorBox('DeepSeek Harness Desktop', message)
  app.quit()
}

let child: ChildProcess | undefined
let mainWindow: BrowserWindow | null = null
let resolvedUrl: string | undefined

function createMainWindow(url: string): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
    },
  })
  mainWindow.loadURL(url)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function boot(): void {
  const dshBin = resolveDshBin()
  const timeout = setTimeout(() => {
    fail(`dsh web did not become ready within ${READY_TIMEOUT_MS / 1000}s`)
  }, READY_TIMEOUT_MS)

  child = spawn(process.execPath, [dshBin, 'web', '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: String(1) },
  })

  child.on('error', (err) => {
    clearTimeout(timeout)
    fail(`Failed to start dsh web: ${err.message}`)
  })

  child.on('exit', (code) => {
    clearTimeout(timeout)
    if (!resolvedUrl) {
      fail(`dsh web exited${code === null ? '' : ` with code ${String(code)}`} before becoming ready`)
    }
  })

  if (!child.stdout) {
    clearTimeout(timeout)
    fail('dsh web stdout is not available')
    return
  }

  child.stderr?.on('data', () => {
    // Drain stderr so the child never blocks on a full error buffer.
  })

  const rl = createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    const match = URL_REGEX.exec(line)
    if (!match) return

    const url = match[1]
    resolvedUrl = url
    clearTimeout(timeout)
    rl.close()

    if (app.isReady()) {
      createMainWindow(url)
    } else {
      app.whenReady().then(() => createMainWindow(url))
    }
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.on('window-all-closed', () => {
    child?.kill()
  })

  app.on('before-quit', () => {
    child?.kill()
  })

  boot()
}
