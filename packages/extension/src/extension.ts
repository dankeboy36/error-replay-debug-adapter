import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  ErrorReplaySession,
  type FixtureScope,
  type LoadStackTraceParams,
  type LoadVariablesParams,
  type ReplayDataSource,
  type ReplayFixture,
  type ReplayFixtureFrame,
  type StackTrace,
  type StackTraceFrame,
  type VariablePayload,
  type Variables,
} from '@error-replay/adapter'
import {
  GENERATED_DIRNAME,
  generateMockReplay,
  MockRegistry,
} from '@error-replay/mock'
import * as vscode from 'vscode'

const DEBUG_TYPE = 'error-replay'
let replaySessionActive = false

interface ReplayRegistryEntry {
  id: string
  label: string
  replayPath: string
  sourcePath: string
  line: number
  functionName?: string
  frameOrder?: number
  errorTitle?: string
  occurredAt?: string
}

class FileReplayDataSource implements ReplayDataSource {
  private cache?: { stackTrace: StackTrace; variables: Map<string, Variables> }

  constructor(private readonly replayFile: string) {}

  async loadStackTrace(_params: LoadStackTraceParams): Promise<StackTrace> {
    const loaded = await this.ensureLoaded()
    return loaded.stackTrace
  }

  async loadVariables(
    params: LoadVariablesParams
  ): Promise<Variables | undefined> {
    const loaded = await this.ensureLoaded()
    return loaded.variables.get(params.snapshotId)
  }

  private async ensureLoaded(): Promise<{
    stackTrace: StackTrace
    variables: Map<string, Variables>
  }> {
    if (this.cache) {
      return this.cache
    }
    const fixture = await readFixture(this.replayFile)
    const { stackTrace, variables } = this.buildStackTrace(fixture)
    this.cache = { stackTrace, variables }
    return this.cache
  }

  private buildStackTrace(fixture: ReplayFixture): {
    stackTrace: StackTrace
    variables: Map<string, Variables>
  } {
    const variablesBySnapshot = new Map<string, Variables>()
    const frames: StackTraceFrame[] = (fixture.frames ?? []).map(
      (frame: ReplayFixtureFrame, idx) => {
        const snapshotId =
          frame.snapshotId ??
          frame.snapshot_id ??
          (frame.id !== undefined ? String(frame.id) : `snap-${idx}`)
        const filePath = normalizeFixturePath(frame.filePath)
        const lineZero = Math.max(0, (frame.line ?? 1) - 1)
        const columnZero = Math.max(0, (frame.column ?? 1) - 1)
        const tokens: StackTraceFrame['tokens'] =
          filePath === undefined
            ? []
            : [
                {
                  kind: 'runtimeCoordinate' as const,
                  value: { uri: { path: filePath }, location: lineZero },
                },
              ]
        const content = frame.functionName
          ? `${frame.functionName} @ ${filePath ?? 'unknown'}:${lineZero + 1}`
          : (filePath ?? `frame-${idx}`)

        variablesBySnapshot.set(
          snapshotId,
          this.convertScopesToVariables(frame.scopes)
        )

        return {
          id: frame.id !== undefined ? String(frame.id) : String(idx),
          content,
          tokens,
          file: filePath,
          function: frame.functionName,
          line: lineZero,
          column: columnZero,
          snapshotId,
          snapshotIndex: frame.snapshotIndex,
        }
      }
    )

    const stackTrace: StackTrace = {
      id: fixture.id ?? 'recorded-error',
      frames,
      traceId: fixture.id,
      eventId: fixture.id,
      timestamp: fixture.occurredAt
        ? Date.parse(fixture.occurredAt)
        : Date.now(),
      source: fixture.source ?? 'mock',
      snapshotCount:
        fixture.meta?.snapshotCount ?? fixture.frames?.length ?? frames.length,
      symbolicated: fixture.meta?.symbolicated,
      architecture: fixture.meta?.architecture,
      registers: fixture.meta?.registers,
      exception: fixture.exception,
    }

    return { stackTrace, variables: variablesBySnapshot }
  }

  private convertScopesToVariables(
    scopes: FixtureScope[] | undefined
  ): Variables {
    const locals: Record<string, VariablePayload> = {}
    const args: Record<string, VariablePayload> = {}
    for (const scope of scopes ?? []) {
      const target = scope.type === 'arguments' ? args : locals
      for (const variable of scope.variables ?? []) {
        const name = variable.name ?? 'value'
        target[name] = {
          type: variable.type,
          value: variable.valuePreview,
        }
      }
    }
    return { locals, arguments: args }
  }
}

async function readFixture(filePath: string): Promise<ReplayFixture> {
  const content = await fs.promises.readFile(filePath, 'utf-8')
  return JSON.parse(content) as ReplayFixture
}

function normalizeFixturePath(maybePath?: string): string | undefined {
  if (!maybePath) {
    return undefined
  }
  const fileScheme = maybePath.startsWith('file://')
    ? maybePath.replace('file://', '')
    : maybePath
  return path.normalize(fileScheme)
}

function buildSkipMatchers(patterns: string[]): RegExp[] {
  const out: RegExp[] = []
  for (const pattern of patterns) {
    const re = toRegExp(pattern)
    if (re) {
      out.push(re)
    }
  }
  return out
}

function toRegExp(pattern: string): RegExp | null {
  if (!pattern) {
    return null
  }
  if (pattern.includes('<node_internals>')) {
    return /(node:internal|[\\/](internal|node_modules)[\\/])/i
  }
  const normalized = pattern.replace(/\\/g, '/')
  const segments = normalized.split('/')
  const parts = segments.map((seg) => {
    if (seg === '**') {
      return '.*'
    }
    const escaped = seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    return escaped.replace(/\*/g, '[^/]*')
  })
  const reStr = `^${parts.join('[\\\\/]')}$`
  try {
    return new RegExp(reStr)
  } catch {
    return null
  }
}

function matchesAny(matchers: RegExp[], sourcePath?: string): boolean {
  if (!sourcePath) {
    return false
  }
  const normalized = path.normalize(sourcePath)
  return matchers.some((re) => re.test(normalized))
}

async function pickTargetFile(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<vscode.Uri | undefined> {
  const pattern = '**/*.{js,cjs,mjs}'
  const uris = await vscode.workspace.findFiles(
    pattern,
    '**/node_modules/**',
    200
  )

  const items: Array<
    vscode.QuickPickItem & { uri?: vscode.Uri; browse?: boolean }
  > = uris
    .map((uri) => {
      const label = path.basename(uri.fsPath)
      const description = path.relative(workspaceFolder.uri.fsPath, uri.fsPath)
      return { label, description, uri }
    })
    .sort((left, right) => left.label.localeCompare(right.label))

  items.push({
    label: 'Browse for file…',
    description: 'Pick any JavaScript file',
    browse: true,
  })

  const picked = await vscode.window.showQuickPick(items, {
    title:
      'Select JavaScript file to generate errors from (runs until uncaught exception)',
    placeHolder:
      items.length > 1
        ? 'Choose a file or browse…'
        : 'Browse for a JavaScript file',
  })

  if (!picked) {
    return undefined
  }

  if (picked.browse) {
    const filePick = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      title:
        'Select JavaScript file to generate errors from (runs until uncaught exception)',
      defaultUri: workspaceFolder.uri,
      filters: { JavaScript: ['js', 'cjs', 'mjs'] },
    })
    return filePick?.[0]
  }

  return picked.uri
}

class ReplayRegistry implements MockRegistry {
  private readonly entries = new Map<string, ReplayRegistryEntry>()
  private readonly byReplayPath = new Map<string, Set<string>>()
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  private readonly watchers: vscode.FileSystemWatcher[] = []
  private readonly watchPatterns: vscode.RelativePattern[]
  private readonly fsWatcher: vscode.FileSystemWatcher

  public readonly onDidChange: vscode.Event<void> = this._onDidChange.event

  constructor(private readonly workspaceFolder: string) {
    const generatedDir = path.join(workspaceFolder, GENERATED_DIRNAME)
    fs.mkdirSync(generatedDir, { recursive: true })

    this.watchPatterns = [
      new vscode.RelativePattern(workspaceFolder, '**/fixtures/**/*.json'),
    ]

    this.watchers = this.watchPatterns.map((pattern) => {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern)
      watcher.onDidCreate((uri) => this.addOrUpdate(uri.fsPath))
      watcher.onDidChange((uri) => this.addOrUpdate(uri.fsPath))
      watcher.onDidDelete((uri) => this.remove(uri.fsPath))
      return watcher
    })

    // Terminal-driven deletions/creates
    this.fsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceFolder, '**/fixtures/**/*.json')
    )
    this.fsWatcher.onDidCreate((uri) => this.addOrUpdate(uri.fsPath))
    this.fsWatcher.onDidChange((uri) => this.addOrUpdate(uri.fsPath))
    this.fsWatcher.onDidDelete((uri) => this.remove(uri.fsPath))

    this.refreshAll().catch(() => {
      // best effort
    })
  }

  dispose(): void {
    for (const watcher of this.watchers) {
      watcher.dispose()
    }
    this.fsWatcher.dispose()
    this._onDidChange.dispose()
  }

  private async refreshAll(): Promise<void> {
    for (const pattern of this.watchPatterns) {
      const uris = await vscode.workspace.findFiles(pattern)
      for (const uri of uris) {
        await this.addOrUpdate(uri.fsPath)
      }
    }
  }

  async addOrUpdate(filePath: string): Promise<void> {
    const entries = await this.readEntries(filePath)
    if (!entries.length) {
      return
    }
    this.remove(filePath)
    for (const entry of entries) {
      this.entries.set(entry.id, entry)
      let ids = this.byReplayPath.get(filePath)
      if (!ids) {
        ids = new Set()
        this.byReplayPath.set(filePath, ids)
      }
      ids.add(entry.id)
    }
    this._onDidChange.fire()
  }

  remove(filePath: string): void {
    const ids = this.byReplayPath.get(filePath)
    if (ids) {
      for (const id of ids) {
        this.entries.delete(id)
      }
      this.byReplayPath.delete(filePath)
    }
    this._onDidChange.fire()
  }

  getEntriesForSource(sourcePath: string): ReplayRegistryEntry[] {
    const normalized = path.normalize(sourcePath)
    return Array.from(this.entries.values()).filter(
      (entry) => path.normalize(entry.sourcePath) === normalized
    )
  }

  private async readEntries(filePath: string): Promise<ReplayRegistryEntry[]> {
    try {
      const replay = await readFixture(filePath)
      const frame = replay.frames?.[0]
      if (!frame || typeof frame.line !== 'number' || !frame.filePath) {
        return []
      }
      const sourcePath = normalizeFixturePath(frame.filePath)
      if (!sourcePath) {
        return []
      }
      const id = `${path.normalize(filePath)}#0`
      return [
        {
          id,
          label: `${path.basename(filePath)}:${frame.functionName ?? '(error)'}`,
          replayPath: filePath,
          sourcePath,
          line: frame.line,
          functionName: frame.functionName,
          errorTitle: replay.title,
          occurredAt: replay.occurredAt,
        },
      ]
    } catch {
      return []
    }
  }
}

class ReplayCodeLensProvider implements vscode.CodeLensProvider {
  constructor(private readonly registry: ReplayRegistry) {
    this.registryListener = this.registry.onDidChange(() =>
      this._onDidChangeCodeLenses.fire()
    )
  }

  private activeReplayPath?: string
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>()
  readonly onDidChangeCodeLenses: vscode.Event<void> =
    this._onDidChangeCodeLenses.event

  private readonly registryListener: vscode.Disposable

  dispose(): void {
    this._onDidChangeCodeLenses.dispose()
    this.registryListener.dispose()
  }

  setActiveReplay(replayPath: string | undefined): void {
    this.activeReplayPath = replayPath ? path.normalize(replayPath) : undefined
    this._onDidChangeCodeLenses.fire()
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const entries = this.registry.getEntriesForSource(document.uri.fsPath)
    if (!entries.length) {
      return []
    }

    const byLine = new Map<number, ReplayRegistryEntry[]>()
    for (const entry of entries) {
      if (
        this.activeReplayPath &&
        path.normalize(entry.replayPath) === this.activeReplayPath
      ) {
        continue
      }
      const line = entry.line ?? 1
      const list = byLine.get(line) ?? []
      list.push(entry)
      byLine.set(line, list)
    }

    const lenses: vscode.CodeLens[] = []
    for (const [line, group] of byLine.entries()) {
      const position = new vscode.Position(Math.max(0, line - 1), 0)
      const command: vscode.Command = {
        title: buildCodeLensTitle(group[0]),
        command: 'errorReplay.startReplayFile',
        arguments: [group],
      }
      lenses.push(
        new vscode.CodeLens(new vscode.Range(position, position), command)
      )
    }

    return lenses
  }
}

function buildCodeLensTitle(entry: ReplayRegistryEntry): string {
  const message = entry.errorTitle ?? entry.functionName ?? entry.label
  const trimmed = message ? message.split('\n')[0] : 'Recorded error'
  return `Replay error: ${trimmed}`
}

async function startReplayMultiCommand(
  entries: ReplayRegistryEntry[]
): Promise<void> {
  if (!entries || !entries.length) {
    return
  }

  const pickItems = entries.map((entry) => ({
    label: entry.errorTitle ? entry.errorTitle.split('\n')[0] : entry.label,
    description: entry.occurredAt ? `at ${entry.occurredAt}` : undefined,
    detail: `${entry.sourcePath}:${entry.line ?? ''}`,
    entry,
  }))

  const picked =
    pickItems.length === 1
      ? pickItems[0]
      : await vscode.window.showQuickPick(pickItems, {
          placeHolder: 'Type to filter recorded error',
          title: 'Select error replay',
          canPickMany: false,
        })

  const target = picked?.entry
  if (!target) {
    return
  }
  await startReplayCommand(
    target.replayPath,
    target.line,
    target.sourcePath,
    target.errorTitle
  )
}

export function activate(context: vscode.ExtensionContext): void {
  const workspaceFolderPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  const registry = workspaceFolderPath
    ? new ReplayRegistry(workspaceFolderPath)
    : undefined
  let codeLensProvider: ReplayCodeLensProvider | undefined
  if (registry) {
    context.subscriptions.push(registry)
    codeLensProvider = new ReplayCodeLensProvider(registry)
    context.subscriptions.push(
      vscode.languages.registerCodeLensProvider(
        { scheme: 'file', language: 'javascript' },
        codeLensProvider
      ),
      codeLensProvider
    )
  }

  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession((session) => {
      if (session.type === DEBUG_TYPE) {
        replaySessionActive = true
        codeLensProvider?.setActiveReplay(
          session.configuration?.replayFile as string | undefined
        )
      }
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (session.type === DEBUG_TYPE) {
        replaySessionActive = false
        codeLensProvider?.setActiveReplay(undefined)
      }
    }),
    vscode.debug.onDidChangeActiveDebugSession((session) => {
      if (!session || session.type !== DEBUG_TYPE) {
        replaySessionActive = false
        codeLensProvider?.setActiveReplay(undefined)
      }
    })
  )

  const factory: vscode.DebugAdapterDescriptorFactory = {
    createDebugAdapterDescriptor(session: vscode.DebugSession) {
      const workspaceFolder = session.workspaceFolder?.uri?.fsPath
      const replayFile =
        (session.configuration?.replayFile as string | undefined) ??
        (workspaceFolder
          ? path.join(workspaceFolder, 'fixtures', 'replay.json')
          : undefined)
      if (!replayFile) {
        throw new Error('Replay file not provided in configuration.')
      }
      const resolvedReplayFile = path.isAbsolute(replayFile)
        ? replayFile
        : path.join(workspaceFolder ?? process.cwd(), replayFile)
      const dataSource = new FileReplayDataSource(resolvedReplayFile)
      const matchers = buildSkipMatchers(
        (session.configuration?.skipFiles as string[] | undefined) ?? []
      )
      const options = {
        shouldDeemphasize: (sourcePath?: string) =>
          matchesAny(matchers, sourcePath),
      }
      return new vscode.DebugAdapterInlineImplementation(
        new ErrorReplaySession(dataSource, workspaceFolder, options)
      )
    },
  }

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, factory),
    vscode.debug.registerDebugConfigurationProvider(
      DEBUG_TYPE,
      new (class implements vscode.DebugConfigurationProvider {
        resolveDebugConfiguration(
          folder: vscode.WorkspaceFolder | undefined,
          config: vscode.DebugConfiguration
        ) {
          if (!config.type && !config.request && !config.name) {
            config.type = DEBUG_TYPE
            config.name = 'Error Replay'
            config.request = 'launch'
          }

          if (!config.replayFile && folder) {
            const defaultPath = path.join(
              folder.uri.fsPath,
              'fixtures',
              'replay.json'
            )
            if (fs.existsSync(defaultPath)) {
              config.replayFile = defaultPath
            }
          }

          return config
        }
      })()
    ),
    vscode.commands.registerCommand(
      'errorReplay.startReplayFile',
      (
        arg1?: string | ReplayRegistryEntry[],
        arg2?: number,
        arg3?: string,
        arg4?: string
      ) => {
        if (Array.isArray(arg1)) {
          return startReplayMultiCommand(arg1)
        }
        return startReplayCommand(
          typeof arg1 === 'string' ? arg1 : undefined,
          arg2,
          arg3,
          arg4
        )
      }
    ),
    vscode.commands.registerCommand('errorReplay.generateMock', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('Open a workspace to generate replays.')
        return
      }
      const target = await pickTargetFile(workspaceFolder)
      if (!target) {
        return
      }
      try {
        const output = await generateMockReplay(
          workspaceFolder.uri.fsPath,
          target.fsPath,
          registry
        )
        vscode.window.showInformationMessage(
          `Generated mock error replay fixture: ${path.relative(
            workspaceFolder.uri.fsPath,
            output
          )}`
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        vscode.window.showErrorMessage(
          `Failed to generate mock error replay: ${message}`
        )
      }
    })
  )
}

export function deactivate(): void {
  // no-op
}

async function startReplayCommand(
  replayFileArg?: string,
  startLine?: number,
  startSourcePath?: string,
  errorTitle?: string
): Promise<void> {
  if (replaySessionActive) {
    vscode.window.showWarningMessage(
      'An Error Replay session is already running.'
    )
    return
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
  const defaultUri = workspaceFolder
    ? vscode.Uri.file(
        path.join(workspaceFolder.uri.fsPath, 'fixtures', 'replay.json')
      )
    : undefined

  let replayFile = replayFileArg
  if (!replayFile) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      title: 'Select replay JSON',
      defaultUri,
      filters: { JSON: ['json'] },
    })

    replayFile = picked?.[0]?.fsPath ?? defaultUri?.fsPath
  }

  if (!replayFile) {
    vscode.window.showWarningMessage('No replay file selected.')
    return
  }

  const folder = workspaceFolder ?? undefined
  const config: vscode.DebugConfiguration = {
    type: DEBUG_TYPE,
    name: 'Error Replay',
    request: 'launch',
    replayFile,
    startLine,
    startSourcePath,
    errorTitle,
  }

  await vscode.commands.executeCommand('workbench.view.debug')
  await vscode.debug.startDebugging(folder, config)
}
