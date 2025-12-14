# @error-replay/mock

Tools to generate realistic replay fixtures without a backend.

> [!TIP]
> Point the harvester at a script that throws quickly; long-running targets will delay fixture generation.

## Harvest script

- `packages/mock/dist/harvestReplay.js`: runs a Node script under the inspector, pauses on the first uncaught exception, and records stack frames + locals/arguments per scope.
- Usage: `node packages/mock/dist/harvestReplay.js ./path/to/target.js ./fixtures/replay.json`
  - Writes a replay JSON (frames + variables) suitable for the adapter/extension.

## VS Code helper

- `generateMockReplay(workspacePath, targetFile, registry?)`: programmatic API to harvest a replay, drop it into `fixtures/generated/`, and notify a registry if provided.
- The `Error Replay: Generate Mock Error` command in the extension wraps this helper; generated fixtures appear in `fixtures/generated/` and surface via CodeLens.

These fixtures let you exercise the adapter/extension without connecting to Datadog or an ESP crash pipeline.
