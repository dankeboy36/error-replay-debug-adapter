import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import WebSocket from 'ws'

const [, , targetArg, outArg] = process.argv
if (!targetArg) {
  console.error(
    'Usage: node packages/mock/dist/harvestReplay.js <target.js> [output.json]'
  )
  process.exit(1)
}

const target = path.resolve(targetArg)
const outputPath = path.resolve(
  outArg ?? path.join(process.cwd(), 'fixtures', 'replay.json')
)

const node = spawn(process.execPath, ['--inspect=0', target], {
  stdio: ['ignore', 'inherit', 'pipe'],
})

let inspectorUrl: string
let captured = false
const scripts = new Map()

/* 1) Capture inspector websocket URL from stderr */
node.stderr.on('data', (data) => {
  const text = data.toString()
  const match = text.match(/ws:\/\/[^\s]+/)
  if (match && !inspectorUrl) {
    inspectorUrl = match[0]
    attach(inspectorUrl).catch((err) => {
      console.error('Failed to attach to inspector:', err)
      process.exit(1)
    })
  }
})

node.on('exit', (code) => {
  if (!captured) {
    console.error(
      `Target exited before capture. Exit code: ${code ?? 'unknown'}`
    )
    process.exitCode = code ?? 1
  }
})

/* 2) Inspector RPC plumbing */
let msgId = 0
const pending = new Map()

function rpc(
  ws: WebSocket,
  method: string,
  params = {} as Record<string, unknown>
): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }), (err) => {
      if (err) {
        pending.delete(id)
        reject(err)
      }
    })
  })
}

async function attach(wsUrl: string) {
  const ws = new WebSocket(wsUrl)

  ws.on('close', () => {
    if (!captured) {
      console.error('Inspector connection closed before capture.')
    }
  })

  ws.on('message', async (raw) => {
    const msg = JSON.parse(raw.toString())

    if (msg.method === 'Debugger.scriptParsed') {
      if (msg.params?.scriptId) {
        const url = msg.params.url || ''
        scripts.set(msg.params.scriptId, url)
      }
      return
    }

    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) {
        reject(new Error(msg.error.message || 'Inspector error'))
      } else {
        resolve(msg.result)
      }
      return
    }

    if (msg.method === 'Debugger.paused') {
      if (
        msg.params?.reason !== 'exception' &&
        msg.params?.reason !== 'promiseRejection'
      ) {
        await rpc(ws, 'Debugger.resume').catch(() => {})
        return
      }
      captured = true
      await handlePause(ws, msg.params)
      ws.close()
      node.kill()
      process.exit(0)
    }
  })

  await new Promise((resolve) => ws.once('open', resolve))

  /* 3) Enable debugger + pause on exception */
  await rpc(ws, 'Debugger.enable')
  await rpc(ws, 'Runtime.enable')
  await rpc(ws, 'Debugger.setPauseOnExceptions', { state: 'uncaught' })
  // Kick execution after the initial --inspect-brk pause.
  await rpc(ws, 'Runtime.runIfWaitingForDebugger').catch(() =>
    rpc(ws, 'Debugger.resume').catch(() => {})
  )
}

interface Location {
  scriptId: string
  lineNumber: number
  columnNumber: number
}

interface Scope {
  name: string
  type: string
  object: any
}

interface CallFrame {
  url?: string
  location: Location
  functionName?: string
  callFrameId?: string
  scopeChain: Scope[]
}

interface HandleLocationParams {
  callFrames: CallFrame[]
  data: { description?: string; className?: string }
}

async function handlePause(
  ws: WebSocket,
  { callFrames, data }: HandleLocationParams
) {
  const frames: any[] = []
  const variables: any[] = []

  for (const [i, frame] of callFrames.entries()) {
    const scopes: any[] = []
    const locals: Record<string, unknown> = {}
    const args: Record<string, unknown> = {}
    const scriptUrl =
      frame.url ||
      scripts.get(frame.location?.scriptId) ||
      scripts.get(frame.callFrameId) ||
      ''

    for (const scope of frame.scopeChain) {
      const vars: any[] = []

      if (scope.object?.objectId) {
        const props = await rpc(ws, 'Runtime.getProperties', {
          objectId: scope.object.objectId,
          ownProperties: true,
        })

        for (const p of props.result ?? []) {
          if (!p.value) continue
          vars.push({
            name: p.name,
            type: p.value.type,
            valuePreview: preview(p.value),
          })
          const target =
            scope.type === 'local' ||
            scope.type === 'closure' ||
            scope.type === 'block'
              ? locals
              : scope.type === 'arguments'
                ? args
                : locals
          target[p.name] = {
            type: p.value.type,
            value: p.value.value ?? p.value.description,
          }
        }
      }

      scopes.push({
        type: scope.type,
        name: scope.name,
        variables: vars,
      })
    }

    const snapshotId = `frame-${i}`
    frames.push({
      id: i,
      functionName: frame.functionName || '(anonymous)',
      filePath: scriptUrl,
      line: frame.location.lineNumber + 1,
      column: frame.location.columnNumber + 1,
      snapshotId,
      snapshotIndex: i + 1,
      scopes,
    })

    variables.push({
      snapshotId,
      captures: {
        return: {
          locals,
          arguments: args,
        },
      },
    })
  }

  const replay = {
    id: 'mock_err_001',
    occurredAt: new Date().toISOString(),
    source: 'mock',
    title: data?.description || 'Uncaught exception',
    exception: {
      name: data?.className,
      message: data?.description,
      stack: data?.description,
    },
    frames,
    variables,
    meta: {
      snapshotCount: frames.length,
      symbolicated: true,
      architecture: 'unknown',
    },
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, JSON.stringify(replay, null, 2))
  console.log(`\nReplay written to ${outputPath}`)
}

/** @param {any} v */
function preview(v) {
  if (v.value !== undefined) return JSON.stringify(v.value)
  if (v.subtype === 'array') return `Array(${v.description})`
  if (v.type === 'object') return v.description || '{…}'
  return String(v.description ?? v.type ?? '')
}
// @ts-nocheck
