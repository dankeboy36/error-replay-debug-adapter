export type Architecture = 'xtensa' | 'riscv' | 'unknown' | (string & {})

export interface ReplayFixture {
  id: string
  title?: string
  source?: string
  occurredAt?: string
  exception?: ReplayFixtureException
  frames: ReplayFixtureFrame[]
  variables?: ReplayFixtureVariablesEntry[]
  meta?: ReplayFixtureMeta
}

export interface ReplayFixtureException {
  name?: string
  message?: string
  stack?: string
}

export interface ReplayFixtureMeta {
  snapshotCount?: number
  symbolicated?: boolean
  architecture?: Architecture
  registers?: Record<string, string>
  tasks?: ReplayFixtureTask[]
}

export interface ReplayFixtureFrame {
  id?: string | number
  functionName?: string
  filePath?: string
  line?: number
  column?: number
  snapshotId?: string
  snapshot_id?: string
  snapshotIndex?: number
  scopes?: FixtureScope[]
}

export interface FixtureScope {
  type?: string
  name?: string
  variables?: FixtureVariable[]
}

export interface FixtureVariable {
  name?: string
  type?: string
  valuePreview?: string
}

export interface ReplayFixtureVariablesEntry {
  snapshotId: string
  captures: {
    locals?: Record<string, unknown>
    arguments?: Record<string, unknown>
  }
}

export interface ReplayFixtureTask {
  id: string
  name: string
  frames: Array<{
    filePath?: string
    line?: number
    column?: number
    functionName?: string
    snapshotId?: string
  }>
}

export interface ReplayFixtureIndexEntry {
  id: string
  replayPath: string
  sourcePath?: string
  line?: number
  title?: string
  occurredAt?: string
}
