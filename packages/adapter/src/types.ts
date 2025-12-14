export type StackTrace = {
  readonly id: string
  readonly frames: readonly StackTraceFrame[]
  readonly eventId?: string
  readonly spanId?: string
  readonly traceId?: string
  readonly timestamp?: number
  readonly source?: string
  readonly snapshotCount?: number
  readonly symbolicated?: boolean
  readonly architecture?: string
  readonly registers?: Record<string, string>
  readonly tasks?: unknown
  readonly exception?: {
    readonly name?: string
    readonly message?: string
    readonly stack?: string
  }
}

export type StackTraceFrame = {
  readonly id: string
  readonly content: string
  readonly tokens: readonly StackTraceToken[]
  readonly file?: string
  readonly function?: string
  readonly line?: number
  readonly column?: number
  readonly snapshotId?: string
  readonly snapshot_id?: string
  readonly snapshotIndex?: number
}

export type StackTraceToken =
  | {
      readonly kind: 'repositoryCoordinate'
      readonly value: { uri: { path: string }; location?: number }
    }
  | {
      readonly kind: 'runtimeCoordinate'
      readonly value: { uri: { path: string }; location?: number }
    }
  | {
      readonly kind: 'packageName' | 'className' | 'functionName'
      readonly value: string
    }
  | { readonly kind: 'lineNumber'; readonly value: number }
  | { readonly kind: 'characterNumber'; readonly value: number }
  | { readonly kind: 'isTargetFrame'; readonly value: boolean }
  | {
      readonly kind: 'unknown'
      readonly unknownKind: string
      readonly value: string | number
    }

export type Variables = {
  readonly arguments?: Record<string, VariablePayload>
  readonly locals?: Record<string, VariablePayload>
  readonly language?: string
  readonly columnStack?: unknown
}

export type VariablePayload = {
  readonly type?: string
  readonly name?: string
  readonly notCapturedReason?:
    | 'fieldCount'
    | 'redactedIdent'
    | 'collectionSize'
    | 'depth'
  readonly size?: number
  readonly entries?: readonly [VariablePayload, VariablePayload][]
  readonly elements?: readonly VariablePayload[]
  readonly value?: string
  readonly fields?: { readonly [key: string]: VariablePayload }
  readonly isNull?: boolean
}

export interface ReplayDataSource {
  loadStackTrace(params: LoadStackTraceParams): Promise<StackTrace>
  loadVariables(params: LoadVariablesParams): Promise<Variables | undefined>
}

export type LoadStackTraceParams = {
  errorId?: string
  traceId?: string
  spanId?: string
  timestamp?: number
  context?: Record<string, unknown>
}

export type LoadVariablesParams = {
  snapshotId: string
  timestamp: number
  context?: Record<string, unknown>
}
