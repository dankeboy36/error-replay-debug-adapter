import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export const GENERATED_DIRNAME = path.join('fixtures', 'generated')

export interface MockRegistry {
  addOrUpdate(filePath: string): Promise<void> | void
}

export async function generateMockReplay(
  workspacePath: string,
  targetFile: string,
  registry?: MockRegistry
): Promise<string> {
  const harvestScript = new URL('./harvestReplay.js', import.meta.url).pathname

  await fs.mkdir(path.join(workspacePath, GENERATED_DIRNAME), {
    recursive: true,
  })

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const baseName = `${path.basename(
    targetFile,
    path.extname(targetFile)
  )}-replay-${timestamp}.json`
  const outputPath = path.join(workspacePath, GENERATED_DIRNAME, baseName)

  await runNodeScript(harvestScript, [targetFile, outputPath])

  if (registry) {
    await registry.addOrUpdate(outputPath)
  }

  return outputPath
}

function runNodeScript(scriptPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env: { ...process.env },
      stdio: 'inherit',
    })

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(
          new Error(`${path.basename(scriptPath)} exited with code ${code}`)
        )
      }
    })
  })
}
