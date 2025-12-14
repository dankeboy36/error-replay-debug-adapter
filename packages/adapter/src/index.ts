import * as path from 'node:path'

import {
  Handles,
  InitializedEvent,
  LoggingDebugSession,
  OutputEvent,
  Scope,
  Source,
  StackFrame,
  StoppedEvent,
  TerminatedEvent,
  Thread,
} from '@vscode/debugadapter'
import type { DebugProtocol } from '@vscode/debugprotocol'

import {
  type LoadStackTraceParams,
  type LoadVariablesParams,
  type ReplayDataSource,
  type StackTrace,
  type StackTraceFrame,
  type VariablePayload,
  type Variables,
} from './types.js'

const THREAD_ID = 1

type VariableMap = Record<string, VariableNode>

interface VariableNode {
  type?: string
  value?: string | number | boolean | null
  fields?: VariableMap
}

interface SnapshotCaptures {
  locals: VariableMap
  arguments: VariableMap
}

interface InstrumentationInfo {
  traceId?: string
  spanId?: string
  timestamp?: number
  sourceObjectUri?: string
  stackId?: string
  errorId?: string
  context?: Record<string, unknown>
}

interface ReplayFrame {
  id: number
  name: string
  file?: string
  line: number
  column: number
  snapshotId: string | null
}

interface StepResult {
  terminated?: boolean
  stopped?: boolean
  reason?: string
}

export interface ReplayLaunchArgs
  extends DebugProtocol.LaunchRequestArguments, LoadStackTraceParams {
  trace?: boolean
  startLine?: number
  startSourcePath?: string
  __replayMultiSelect?: number
  errorTitle?: string
}

export interface ReplaySessionOptions {
  shouldSkipFrame?: (sourcePath?: string) => boolean | Promise<boolean>
  shouldDeemphasize?: (sourcePath?: string) => boolean | Promise<boolean>
}

function coerceValue(
  valuePreview?: string,
  type?: string
): string | number | boolean | null | undefined {
  if (valuePreview === undefined) {
    return type
  }
  if (type === 'number') {
    const n = Number(valuePreview)
    return Number.isNaN(n) ? valuePreview : n
  }
  if (type === 'boolean') {
    if (valuePreview === 'true') return true
    if (valuePreview === 'false') return false
  }
  if (valuePreview === 'null') {
    return null
  }
  return valuePreview
}

class ReplayRuntime {
  public readonly instrumentationInfo: InstrumentationInfo
  private readonly frames: ReplayFrame[]
  private readonly breakpoints: Map<string, Set<number>>
  private readonly dataSource: ReplayDataSource
  private readonly variablesCache = new Map<string, SnapshotCaptures>()
  private cursor: number

  constructor(
    stackTrace: StackTrace,
    dataSource: ReplayDataSource,
    instrumentationInfo?: InstrumentationInfo
  ) {
    this.dataSource = dataSource
    this.instrumentationInfo = {
      traceId: stackTrace.traceId ?? instrumentationInfo?.traceId,
      spanId: stackTrace.spanId ?? instrumentationInfo?.spanId,
      timestamp: stackTrace.timestamp ?? instrumentationInfo?.timestamp,
      sourceObjectUri: instrumentationInfo?.sourceObjectUri,
      stackId: stackTrace.id ?? instrumentationInfo?.stackId,
      errorId: stackTrace.eventId ?? instrumentationInfo?.errorId,
      context: instrumentationInfo?.context,
    }
    this.frames = this.buildFrames(stackTrace.frames)
    this.breakpoints = new Map()
    this.cursor = this.findInitialFrame()
  }

  private buildFrames(frames: readonly StackTraceFrame[]): ReplayFrame[] {
    const mapped = frames.map((frame, idx) => {
      const runtimeCoordinate = this.extractRuntimeCoordinate(frame)
      const file =
        this.normalizeFilePath(frame.file) ??
        this.normalizeFilePath(runtimeCoordinate?.uri?.path)
      const line =
        typeof frame.line === 'number'
          ? frame.line + 1
          : runtimeCoordinate?.location !== undefined
            ? runtimeCoordinate.location + 1
            : 1
      const column = typeof frame.column === 'number' ? frame.column + 1 : 1
      const snapshotId = frame.snapshotId ?? frame.snapshot_id ?? null
      const name =
        frame.function ??
        this.extractFunctionName(frame) ??
        frame.content ??
        (typeof frame.id === 'string' ? frame.id : `frame-${idx}`)

      return {
        id: idx,
        name,
        file,
        line,
        column,
        snapshotId,
      }
    })

    return mapped.reverse()
  }

  private normalizeFilePath(maybePath?: string): string | undefined {
    if (!maybePath) {
      return undefined
    }
    if (maybePath.startsWith('file://')) {
      return path.normalize(maybePath.replace('file://', ''))
    }
    return path.normalize(maybePath)
  }

  private extractRuntimeCoordinate(
    frame: StackTraceFrame
  ): { uri?: { path?: string }; location?: number } | undefined {
    const tokens = Array.isArray(frame.tokens) ? frame.tokens : []
    const coord = tokens.find(
      (t: StackTraceFrame['tokens'][number]) => t.kind === 'runtimeCoordinate'
    ) as { uri?: { path?: string }; location?: number } | undefined
    if (coord) {
      return coord
    }
    const repoCoord = tokens.find(
      (t: StackTraceFrame['tokens'][number]) =>
        t.kind === 'repositoryCoordinate'
    ) as { uri?: { path?: string }; location?: number } | undefined
    return repoCoord
  }

  private extractFunctionName(frame: StackTraceFrame): string | undefined {
    const tokens = Array.isArray(frame.tokens) ? frame.tokens : []
    const func = tokens.find(
      (t: StackTraceFrame['tokens'][number]) => t.kind === 'functionName'
    ) as { value?: string } | undefined
    return func?.value
  }

  private findInitialFrame(): number {
    if (!this.frames.length) {
      return 0
    }
    const idx = [...this.frames]
      .reverse()
      .findIndex((frame) => !!frame.snapshotId)
    if (idx >= 0) {
      return this.frames.length - 1 - idx
    }
    return this.frames.length - 1
  }

  public isTerminated(): boolean {
    return this.cursor >= this.frames.length || this.cursor < 0
  }

  public currentFrameIndex(): number {
    return Math.min(this.cursor, Math.max(0, this.frames.length - 1))
  }

  public getSnapshotIdForFrame(frameId: number): string | null {
    const frame = this.frames.find((f) => f.id === frameId)
    return frame?.snapshotId ?? null
  }

  public getCurrentSnapshotId(): string | null {
    const frame = this.frames[this.currentFrameIndex()]
    return frame?.snapshotId ?? null
  }

  public setCursorByFrameId(frameId: number): void {
    const idx = this.frames.findIndex((f) => f.id === frameId)
    if (idx >= 0) {
      this.cursor = idx
    }
  }

  public setCursorByLocation(
    filePath: string | undefined,
    line: number | undefined
  ): void {
    if (!this.frames.length || line === undefined) {
      return
    }
    const normalizedFile = filePath ? path.normalize(filePath) : undefined
    const idx = this.frames.findIndex((f) => {
      const sameFile = normalizedFile
        ? path.normalize(f.file ?? '') === normalizedFile
        : true
      return sameFile && f.line === line
    })
    if (idx >= 0) {
      this.cursor = idx
    }
  }

  public async getLocals(snapshotId: string | null): Promise<VariableMap> {
    if (!snapshotId) {
      return {}
    }
    const variables = await this.getOrLoadVariables(snapshotId)
    return variables.locals
  }

  public async getArguments(snapshotId: string | null): Promise<VariableMap> {
    if (!snapshotId) {
      return {}
    }
    const variables = await this.getOrLoadVariables(snapshotId)
    return variables.arguments
  }

  public getMeta(snapshotId: string | null): VariableMap {
    return {
      snapshotId: { type: 'string', value: snapshotId ?? 'n/a' },
      traceId: {
        type: 'string',
        value: this.instrumentationInfo.traceId ?? '',
      },
      spanId: { type: 'string', value: this.instrumentationInfo.spanId ?? '' },
      sourceObjectUri: {
        type: 'string',
        value: this.instrumentationInfo.sourceObjectUri ?? '',
      },
    }
  }

  public setBreakpoints(
    sourcePath: string | undefined,
    lines: number[]
  ): number[] {
    if (!sourcePath) {
      return []
    }
    const normalized = path.normalize(sourcePath)
    const uniqueLines = new Set(lines)
    this.breakpoints.set(normalized, uniqueLines)
    return Array.from(uniqueLines.values())
  }

  private hitsBreakpoint(frame: ReplayFrame | undefined): boolean {
    if (!frame?.file) {
      return false
    }
    const set = this.breakpoints.get(path.normalize(frame.file))
    if (!set) {
      return false
    }
    return set.has(frame.line)
  }

  private findNextBreakpointIndex(startIdx: number): number {
    for (let i = startIdx; i < this.frames.length; i++) {
      if (this.hitsBreakpoint(this.frames[i])) {
        return i
      }
    }
    return -1
  }

  public stepOnce(reason?: string): StepResult {
    if (this.cursor + 1 >= this.frames.length) {
      this.cursor = this.frames.length
      return { terminated: true }
    }
    this.cursor += 1
    const frame = this.frames[this.cursor]
    if (this.hitsBreakpoint(frame)) {
      return { stopped: true, reason: 'breakpoint' }
    }
    return { stopped: true, reason: reason ?? 'step' }
  }

  public continueExecution(): StepResult {
    const nextIdx = this.findNextBreakpointIndex(this.cursor + 1)
    if (nextIdx === -1) {
      this.cursor = this.frames.length
      return { terminated: true }
    }
    this.cursor = nextIdx
    return { stopped: true, reason: 'breakpoint' }
  }

  public getOrderedFrames(): ReplayFrame[] {
    if (!this.frames.length || this.cursor < 0) {
      return []
    }
    return this.frames.slice(0, this.cursor + 1).reverse()
  }

  public getAllFrames(): ReplayFrame[] {
    return this.frames.slice()
  }

  public totalFrames(): number {
    return this.frames.length
  }

  private async getOrLoadVariables(
    snapshotId: string
  ): Promise<SnapshotCaptures> {
    const cached = this.variablesCache.get(snapshotId)
    if (cached) {
      return cached
    }
    const variables = await this.fetchVariables(snapshotId)
    this.variablesCache.set(snapshotId, variables)
    return variables
  }

  private async fetchVariables(snapshotId: string): Promise<SnapshotCaptures> {
    try {
      const result = await this.dataSource.loadVariables({
        snapshotId,
        timestamp: this.instrumentationInfo.timestamp ?? Date.now(),
        context: this.instrumentationInfo.context,
      } satisfies LoadVariablesParams)
      return this.normalizeVariables(result)
    } catch {
      return { locals: {}, arguments: {} }
    }
  }

  private normalizeVariables(variables?: Variables): SnapshotCaptures {
    const locals = this.toVariableMap(variables?.locals ?? {})
    const args = this.toVariableMap(variables?.arguments ?? {})
    return { locals, arguments: args }
  }

  private toVariableMap(
    record: Record<string, VariablePayload>
  ): Record<string, VariableNode> {
    const result: Record<string, VariableNode> = {}
    for (const [key, payload] of Object.entries(record ?? {})) {
      result[key] = this.toVariableNode(payload)
    }
    return result
  }

  private toVariableNode(payload: VariablePayload | undefined): VariableNode {
    if (!payload) {
      return {}
    }
    if (payload.isNull) {
      return { type: payload.type ?? 'null', value: null }
    }
    if (payload.value !== undefined) {
      return {
        type: payload.type,
        value: coerceValue(payload.value, payload.type),
      }
    }
    if (Array.isArray(payload.elements)) {
      const fields: VariableMap = {}
      payload.elements.forEach((el: VariablePayload, idx: number) => {
        fields[String(idx)] = this.toVariableNode(el)
      })
      return { type: payload.type ?? 'array', fields }
    }
    if (Array.isArray(payload.entries)) {
      const fields: VariableMap = {}
      payload.entries.forEach(
        (
          [keyPayload, valuePayload]: [VariablePayload, VariablePayload],
          idx: number
        ) => {
          const key = this.extractKeyFromPayload(keyPayload, idx)
          fields[key] = this.toVariableNode(valuePayload)
        }
      )
      return { type: payload.type ?? 'map', fields }
    }
    if (payload.fields) {
      const fields: VariableMap = {}
      for (const [key, value] of Object.entries(payload.fields)) {
        fields[key] = this.toVariableNode(value)
      }
      return { type: payload.type ?? 'object', fields }
    }
    return { type: payload.type }
  }

  private extractKeyFromPayload(
    payload: VariablePayload | undefined,
    idx: number
  ): string {
    if (!payload) {
      return String(idx)
    }
    if (payload.value !== undefined) {
      return String(payload.value)
    }
    if (payload.fields) {
      const id =
        payload.fields.id?.value ??
        payload.fields.name?.value ??
        payload.fields.key?.value
      if (id !== undefined) {
        return String(id)
      }
    }
    return String(idx)
  }
}

function toSafeSource(frame: ReplayFrame): {
  sourcePath?: string
  sourceName: string
  origin?: string
  presentationHint?: 'normal' | 'emphasize' | 'deemphasize'
} {
  const rawPath = frame.file ?? ''
  const sourcePath = isLikelyFilePath(rawPath)
    ? path.normalize(rawPath)
    : undefined
  const sourceName = sourcePath
    ? path.basename(sourcePath)
    : frame.name || 'recorded frame'
  const origin = sourcePath
    ? undefined
    : rawPath
      ? `Recorded frame (${rawPath})`
      : 'Recorded frame'
  const presentationHint =
    !sourcePath && rawPath.startsWith('node:') ? 'deemphasize' : undefined
  return { sourcePath, sourceName, origin, presentationHint }
}

function isLikelyFilePath(maybePath: string): boolean {
  if (!maybePath) {
    return false
  }
  if (maybePath.startsWith('node:') || maybePath.startsWith('<')) {
    return false
  }
  if (maybePath.startsWith('file://')) {
    return true
  }
  return path.isAbsolute(maybePath)
}

function isDeemphasizedSource(sourcePath?: string): boolean {
  if (!sourcePath) {
    return false
  }
  const normalized = path.normalize(sourcePath)
  return (
    normalized.includes(`${path.sep}node_modules${path.sep}`) ||
    normalized.includes(`${path.sep}node${path.sep}`) ||
    normalized.includes(`${path.sep}internal${path.sep}`) ||
    normalized.startsWith('node:internal')
  )
}

export class ErrorReplaySession extends LoggingDebugSession {
  private runtime?: ReplayRuntime
  private readonly _variableHandles = new Handles<VariableContainer>()
  private readonly _pendingBreakpoints = new Map<string | undefined, number[]>()
  private startLineHint?: number
  private startSourcePathHint?: string
  private terminationMessageSent = false
  private errorSummary?: string
  private readonly dataSource: ReplayDataSource
  private readonly workspaceFolder?: string
  private readonly options?: ReplaySessionOptions

  constructor(
    dataSource: ReplayDataSource,
    workspaceFolder?: string,
    options?: ReplaySessionOptions
  ) {
    super()
    this.dataSource = dataSource
    this.workspaceFolder = workspaceFolder
    this.options = options
    this.setDebuggerLinesStartAt1(true)
    this.setDebuggerColumnsStartAt1(true)
  }

  protected override initializeRequest(
    response: DebugProtocol.InitializeResponse,
    args: DebugProtocol.InitializeRequestArguments
  ): void {
    const body: DebugProtocol.Capabilities =
      response.body ?? (response.body = {} as DebugProtocol.Capabilities)
    body.supportsConfigurationDoneRequest = true
    body.supportsEvaluateForHovers = true
    body.supportsSetVariable = false
    body.supportsTerminateRequest = true
    body.supportsDelayedStackTraceLoading = true
    body.supportsRestartFrame = true
    body.supportsStepBack = false
    body.supportsStepInTargetsRequest = false
    body.supportsExceptionInfoRequest = true
    this.sendResponse(response)
    this.sendEvent(new InitializedEvent())
  }

  protected override configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse
  ): void {
    this.sendResponse(response)
  }

  protected override async launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: ReplayLaunchArgs
  ): Promise<void> {
    try {
      const stackTrace = await this.dataSource.loadStackTrace(args)
      this.runtime = new ReplayRuntime(stackTrace, this.dataSource, {
        traceId: args.traceId,
        spanId: args.spanId,
        timestamp: args.timestamp,
        sourceObjectUri: args.startSourcePath,
        errorId: args.errorId,
        context: args.context,
      })
      this.errorSummary =
        args.errorTitle ||
        stackTrace.id ||
        stackTrace.eventId ||
        args.errorId ||
        stackTrace.traceId ||
        'Recorded error'
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error'
      this.sendErrorResponse(response, {
        id: 1001,
        format: `Failed to load replay data: ${message}`,
      })
      return
    }

    for (const [sourcePath, lines] of this._pendingBreakpoints.entries()) {
      this.runtime.setBreakpoints(sourcePath, lines)
    }
    this.startLineHint =
      typeof args.startLine === 'number' ? args.startLine : undefined
    this.startSourcePathHint = args.startSourcePath

    if (args.trace) {
      this.sendEvent(new OutputEvent('Loaded replay data\n'))
    }

    this.syncCursorToHint()
    await this.ensureVisibleCursor()
    this.sendResponse(response)
    this.stopWithReason('entry')
  }

  protected override threadsRequest(
    response: DebugProtocol.ThreadsResponse
  ): void {
    const threads = this.runtime ? [new Thread(THREAD_ID, 'Error Replay')] : []
    response.body = { threads }
    this.sendResponse(response)
  }

  protected override async stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments
  ): Promise<void> {
    if (!this.runtime || this.runtime.isTerminated()) {
      response.body = { stackFrames: [], totalFrames: 0 }
      this.sendResponse(response)
      return
    }

    const start = args.startFrame ?? 0
    const maxLevels = args.levels ?? this.runtime.totalFrames()
    const orderedFrames = this.runtime
      .getOrderedFrames()
      .slice(start, start + maxLevels)

    const filtered = await this.filterFrames(orderedFrames)

    const stackFrames: StackFrame[] = []
    for (const frame of filtered) {
      const hint = await this.getPresentationHint(frame.file)
      const { sourcePath, sourceName, origin, presentationHint } =
        toSafeSource(frame)
      const source = new Source(sourceName, sourcePath, 0, undefined, origin)
      ;(source as DebugProtocol.Source).presentationHint =
        presentationHint ??
        hint ??
        (isDeemphasizedSource(sourcePath) ? 'deemphasize' : undefined)
      ;(source as DebugProtocol.Source).origin = sourcePath
        ? undefined
        : 'Recorded frame (source unavailable)'
      const sf = new StackFrame(
        frame.id,
        frame.name,
        source,
        frame.line,
        frame.column ?? 1
      )
      const stackHint = hint
        ? 'subtle'
        : isDeemphasizedSource(sourcePath)
          ? 'subtle'
          : undefined
      sf.presentationHint = stackHint
      stackFrames.push(sf)
    }

    response.body = {
      stackFrames,
      totalFrames: filtered.length,
    }
    this.sendResponse(response)
  }

  protected override scopesRequest(
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments
  ): void {
    if (!this.runtime) {
      response.body = { scopes: [] }
      this.sendResponse(response)
      return
    }

    const snapshotId = this.runtime.getSnapshotIdForFrame(args.frameId)
    const scopes = [
      new Scope(
        'Locals',
        this._variableHandles.create({ kind: 'locals', snapshotId }),
        false
      ),
      new Scope(
        'Arguments',
        this._variableHandles.create({ kind: 'arguments', snapshotId }),
        false
      ),
      new Scope(
        'Replay Meta',
        this._variableHandles.create({ kind: 'meta', snapshotId }),
        true
      ),
    ]

    response.body = { scopes }
    this.sendResponse(response)
  }

  protected override async variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments
  ): Promise<void> {
    const container = this._variableHandles.get(args.variablesReference)
    const variables = await this.resolveVariables(container)
    response.body = { variables }
    this.sendResponse(response)
  }

  protected override async evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments
  ): Promise<void> {
    if (!this.runtime) {
      this.sendErrorResponse(response, {
        id: 2001,
        format: 'Replay runtime not initialized.',
      })
      return
    }

    const expr = (args.expression || '').trim()
    if (!expr) {
      response.body = { result: '', variablesReference: 0 }
      this.sendResponse(response)
      return
    }

    const frameId =
      typeof args.frameId === 'number'
        ? args.frameId
        : this.runtime.currentFrameIndex()
    const snapshotId = this.runtime.getSnapshotIdForFrame(frameId)
    const valueNode = await this.lookupVariable(snapshotId, expr)

    if (!valueNode) {
      response.body = { result: 'not available', variablesReference: 0 }
      this.sendResponse(response)
      return
    }

    const variable = this.convertValue(expr, valueNode)
    response.body = {
      result: variable.value,
      type: variable.type,
      variablesReference: variable.variablesReference,
    }
    this.sendResponse(response)
  }

  protected override continueRequest(
    response: DebugProtocol.ContinueResponse
  ): void {
    const result = this.runtime?.continueExecution() ?? { terminated: true }
    this.sendResponse(response)
    this.postStep(result)
  }

  protected override nextRequest(response: DebugProtocol.NextResponse): void {
    this.performStepOver(response)
  }

  protected override stepInRequest(
    response: DebugProtocol.StepInResponse
  ): void {
    this.performNoopStep(response, 'stepIn')
  }

  protected override stepOutRequest(
    response: DebugProtocol.StepOutResponse
  ): void {
    this.performNoopStep(response, 'stepOut')
  }

  protected override stepBackRequest(
    response: DebugProtocol.StepBackResponse
  ): void {
    this.sendResponse(response)
    this.sendEvent(
      new OutputEvent(
        '"stepBack" not supported; use "Restart Frame" to replay a frame.\n',
        'console'
      )
    )
    this.sendEvent(new StoppedEvent('step', THREAD_ID))
  }

  protected override reverseContinueRequest(
    response: DebugProtocol.ReverseContinueResponse
  ): void {
    this.sendResponse(response)
    this.sendEvent(
      new OutputEvent(
        '"reverseContinue" not supported; use "Restart Frame" to replay from a frame.\n',
        'console'
      )
    )
    this.sendEvent(new StoppedEvent('step', THREAD_ID))
  }

  protected override restartFrameRequest(
    response: DebugProtocol.RestartFrameResponse,
    args: DebugProtocol.RestartFrameArguments
  ): void {
    if (typeof args.frameId === 'number') {
      this.runtime?.setCursorByFrameId(args.frameId)
      this.sendEvent(new StoppedEvent('restart', THREAD_ID))
    }
    this.sendResponse(response)
  }

  protected override terminateRequest(
    response: DebugProtocol.TerminateResponse
  ): void {
    this.sendResponse(response)
    if (!this.runtime || this.runtime.isTerminated()) {
      this.emitTerminationOutput()
    }
    this.sendEvent(new TerminatedEvent())
  }

  protected override setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments
  ): void {
    const sourcePath = args.source?.path
    const lines = (args.lines ?? []).map((line) => line)
    this._pendingBreakpoints.set(sourcePath, lines)
    if (this.runtime) {
      this.runtime.setBreakpoints(sourcePath, lines)
    }
    response.body = {
      breakpoints: lines.map((line) => ({ verified: true, line })),
    }
    this.sendResponse(response)
  }

  protected override exceptionInfoRequest(
    response: DebugProtocol.ExceptionInfoResponse
  ): void {
    const info = this.buildExceptionInfo()
    if (!info) {
      this.sendErrorResponse(response, {
        id: 3001,
        format: 'No exception info available.',
      })
      return
    }
    response.body = info
    this.sendResponse(response)
  }

  private buildExceptionInfo():
    | {
        exceptionId: string
        description?: string
        breakMode: DebugProtocol.ExceptionBreakMode
        details?: DebugProtocol.ExceptionDetails
      }
    | undefined {
    const instrumentation = this.runtime?.instrumentationInfo
    const frames = this.runtime?.getAllFrames() ?? []
    if (!instrumentation && !frames.length) {
      return undefined
    }

    const exceptionId =
      instrumentation?.errorId ??
      instrumentation?.spanId ??
      instrumentation?.traceId ??
      'error-replay-exception'
    const description = this.errorSummary ?? 'Recorded error replay'
    const stackTrace = frames
      .map((frame) => {
        const location = frame.file ? `${frame.file}:${frame.line ?? ''}` : ''
        return `${frame.name}${location ? ` (${location})` : ''}`
      })
      .join('\n')

    return {
      exceptionId,
      description,
      breakMode: 'always',
      details: {
        typeName: 'Error',
        message: description,
        stackTrace: stackTrace || undefined,
      },
    }
  }

  private async resolveVariables(
    container: VariableContainer | undefined
  ): Promise<DebugProtocol.Variable[]> {
    if (!container || !this.runtime) {
      return []
    }

    const currentSnapshot = this.runtime.getCurrentSnapshotId()
    if (
      (container.kind === 'locals' || container.kind === 'arguments') &&
      container.snapshotId &&
      container.snapshotId !== currentSnapshot
    ) {
      return [
        {
          name: '(inactive frame)',
          value: 'Variables load when the frame is active',
          variablesReference: 0,
        },
      ]
    }

    switch (container.kind) {
      case 'locals':
        return this.buildVariablesFromRecord(
          await this.runtime.getLocals(container.snapshotId)
        )
      case 'arguments':
        return this.buildVariablesFromRecord(
          await this.runtime.getArguments(container.snapshotId)
        )
      case 'meta':
        return this.buildVariablesFromRecord(
          this.runtime.getMeta(container.snapshotId)
        )
      case 'object':
        return this.buildVariablesFromRecord(container.fields ?? {})
      default:
        return []
    }
  }

  private async lookupVariable(
    snapshotId: string | null,
    expression: string
  ): Promise<VariableNode | null> {
    const segments = expression.split('.').filter(Boolean)
    if (!segments.length) {
      return null
    }

    if (!this.runtime) {
      return null
    }
    const [root, ...rest] = segments
    const locals = snapshotId ? await this.runtime.getLocals(snapshotId) : {}
    const args = snapshotId ? await this.runtime.getArguments(snapshotId) : {}
    const meta = this.runtime?.getMeta(snapshotId) ?? {}

    let node: VariableNode | undefined =
      locals[root] ?? args[root] ?? meta[root]
    if (!node) {
      return null
    }

    for (const segment of rest) {
      if (
        !node.fields ||
        !Object.prototype.hasOwnProperty.call(node.fields, segment)
      ) {
        return null
      }
      node = node.fields[segment]
    }

    return node ?? null
  }

  private buildVariablesFromRecord(
    record: VariableMap
  ): DebugProtocol.Variable[] {
    return Object.entries(record ?? {}).map(([name, value]) =>
      this.convertValue(name, value)
    )
  }

  private convertValue(
    name: string,
    node: VariableNode | undefined
  ): DebugProtocol.Variable {
    if (!node) {
      return { name, value: 'undefined', variablesReference: 0 }
    }

    const valueText = this.formatNodeValue(node)
    const fields = node.fields ?? {}
    const hasChildren = Object.keys(fields).length > 0
    const variablesReference = hasChildren
      ? this._variableHandles.create({ kind: 'object', fields })
      : 0

    return {
      name,
      type: node.type,
      value: valueText || node.type || 'value',
      variablesReference,
    }
  }

  private formatNodeValue(node: VariableNode): string {
    if (node.value !== undefined) {
      return this.formatPrimitive(node)
    }

    const fields = node.fields ?? {}
    const keys = Object.keys(fields)
    if (!keys.length) {
      return node.type ?? 'value'
    }

    if (this.isArrayLike(keys)) {
      return this.formatArrayPreview(fields)
    }

    return this.formatObjectPreview(fields)
  }

  private formatPrimitive(node: VariableNode): string {
    const value = node.value
    if (value === null) {
      return 'null'
    }
    if (value === undefined) {
      return node.type ?? 'undefined'
    }

    if (typeof value === 'string') {
      if (node.type === 'object') {
        return value === 'Object' ? '{…}' : value
      }
      if (node.type === 'function') {
        return this.formatFunctionPreview(value)
      }
      if (this.looksNumeric(value)) {
        return String(Number(value))
      }
      return value
    }
    return String(value)
  }

  private formatFunctionPreview(raw: string): string {
    const firstLine = raw.split(/\r?\n/)[0] || raw
    return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine
  }

  private formatArrayPreview(fields: VariableMap): string {
    const length = this.inferArrayLength(Object.keys(fields))
    const preview: string[] = []
    const max = Math.min(length, 3)
    for (let i = 0; i < max; i++) {
      preview.push(this.previewChild(fields[String(i)]))
    }
    if (length > max) {
      preview.push('…')
    }
    return `(${length}) [${preview.join(', ')}]`
  }

  private formatObjectPreview(fields: VariableMap): string {
    const keys = Object.keys(fields)
    const previews = keys
      .slice(0, 3)
      .map((key) => `${key}: ${this.previewChild(fields[key])}`)
    if (keys.length > 3) {
      previews.push('…')
    }
    return `{ ${previews.join(', ')} }`
  }

  private previewChild(node: VariableNode | undefined): string {
    if (!node) {
      return 'undefined'
    }
    if (node.value !== undefined) {
      return this.formatPrimitive(node)
    }

    const fields = node.fields ?? {}
    const keys = Object.keys(fields)
    if (!keys.length) {
      return node.type ?? 'value'
    }

    if (this.isArrayLike(keys)) {
      const length = this.inferArrayLength(keys)
      return `Array(${length})`
    }

    return '{…}'
  }

  private isArrayLike(keys: string[]): boolean {
    if (!keys.length) {
      return false
    }
    return keys.every((k) => /^\d+$/.test(k))
  }

  private inferArrayLength(keys: string[]): number {
    if (!keys.length) {
      return 0
    }
    const numeric = keys
      .map((k) => (/^\d+$/.test(k) ? parseInt(k, 10) : NaN))
      .filter((n) => !Number.isNaN(n))
    if (!numeric.length) {
      return keys.length
    }
    return Math.max(...numeric) + 1
  }

  private looksNumeric(value: string): boolean {
    return /^-?\d+(\.\d+)?$/.test(value)
  }

  private stopWithReason(reason: string): void {
    if (!this.runtime || this.runtime.isTerminated()) {
      this.emitTerminationOutput()
      this.sendEvent(new TerminatedEvent())
      return
    }
    this.sendEvent(new StoppedEvent(reason, THREAD_ID))
  }

  private postStep(result: StepResult): void {
    if (result.terminated) {
      this.emitTerminationOutput()
      this.sendEvent(new TerminatedEvent())
      return
    }
    const allowedReasons = new Set([
      'step',
      'breakpoint',
      'exception',
      'pause',
      'entry',
      'goto',
      'function breakpoint',
      'data breakpoint',
      'instruction breakpoint',
    ])
    const reason =
      result.reason && allowedReasons.has(result.reason)
        ? result.reason
        : 'step'
    this.sendEvent(new StoppedEvent(reason, THREAD_ID))
  }

  private syncCursorToHint(): void {
    if (!this.runtime || this.startLineHint === undefined) {
      return
    }
    this.runtime.setCursorByLocation(
      this.startSourcePathHint,
      this.startLineHint
    )
    this.startLineHint = undefined
    this.startSourcePathHint = undefined
  }

  private ensureVisibleCursor(): void {
    // no-op without a runtime
  }

  private async filterFrames(frames: ReplayFrame[]): Promise<ReplayFrame[]> {
    if (!this.options?.shouldSkipFrame) {
      return frames
    }
    const kept: ReplayFrame[] = []
    for (const frame of frames) {
      const skip = await Promise.resolve(
        this.options.shouldSkipFrame(frame.file)
      )
      if (!skip) {
        kept.push(frame)
      }
    }
    return kept.length ? kept : frames
  }

  private async getPresentationHint(
    sourcePath?: string
  ): Promise<'deemphasize' | undefined> {
    if (!this.options?.shouldDeemphasize) {
      return undefined
    }
    const deemphasize = await Promise.resolve(
      this.options.shouldDeemphasize(sourcePath)
    )
    return deemphasize ? 'deemphasize' : undefined
  }

  private performStepOver(response: DebugProtocol.Response): void {
    const result = this.runtime?.stepOnce('next') ?? { terminated: true }
    this.sendResponse(response)
    this.postStep(result)
  }

  private performNoopStep(
    response: DebugProtocol.Response,
    source: 'stepIn' | 'stepOut'
  ): void {
    if (!this.runtime || this.runtime.isTerminated()) {
      this.sendResponse(response)
      this.sendEvent(new TerminatedEvent())
      return
    }
    this.sendEvent(
      new OutputEvent(
        `"${source}" not supported; staying on current frame.\n`,
        'console'
      )
    )
    this.sendResponse(response)
    this.sendEvent(new StoppedEvent('step', THREAD_ID))
  }

  private emitTerminationOutput(): void {
    if (this.terminationMessageSent) {
      return
    }
    const msg = this.errorSummary
      ? `Replay finished: ${this.errorSummary}`
      : 'Replay finished'
    this.sendEvent(new OutputEvent(`${msg}\n`, 'console'))
    this.terminationMessageSent = true
  }
}

type VariableContainer =
  | { kind: 'locals' | 'arguments' | 'meta'; snapshotId: string | null }
  | { kind: 'object'; snapshotId?: string | null; fields?: VariableMap }

export * from './types.js'
