# error-replay-debug-adapter

Generic inline debug adapter that replays recorded errors through VS Code’s debug UI. It is backend-agnostic: you provide a `ReplayDataSource` that returns a stack trace and lazily resolves variables per snapshot.

> [!NOTE]
> There is no live execution: everything shown comes from recorded snapshots supplied by your data source.

## What it supports

- Single synthetic thread, restart frame, next/continue, and inline breakpoints.
- Scopes: Locals, Arguments, Replay Meta (trace/span/snapshot info).
- Variable expansion backed by recorded payloads (no live execution or evaluation beyond recorded data).
- Deemphasize/skip frames via optional callbacks when constructing the session.

## API

- `ReplayDataSource` (`loadStackTrace`, `loadVariables`) from this package.
- `ErrorReplaySession` from this package; wire it in a `DebugAdapterInlineImplementation` and feed it your data source.
- `ReplayLaunchArgs` extends DAP launch args with your lookup hints (errorId/traceId/spanId, etc.).

## Usage

```ts
import {
  ErrorReplaySession,
  type ReplayDataSource,
} from 'error-replay-debug-adapter'
import * as vscode from 'vscode'

const dataSource: ReplayDataSource = {
  /* implement loadStackTrace/loadVariables */
}

const factory: vscode.DebugAdapterDescriptorFactory = {
  createDebugAdapterDescriptor() {
    return new vscode.DebugAdapterInlineImplementation(
      new ErrorReplaySession(dataSource)
    )
  },
}
```

## Limits

> [!NOTE]
> No evaluate/setVariable/step-in; stepping is linear across recorded frames.
>
> Assumes pre-recorded snapshots; not a live debugger or turing-complete VM.
