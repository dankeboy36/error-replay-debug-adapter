#!/usr/bin/env node

const fs = require('node:fs/promises')
const path = require('node:path')

const { createVSIX } = require('@vscode/vsce')

const root = path.resolve(__dirname, '..')
const extRoot = path.join(root, 'packages', 'extension')
const stage = path.join(extRoot, '.vsce')

async function main() {
  await fs.rm(stage, { recursive: true, force: true })
  await fs.mkdir(stage, { recursive: true })

  await fs.copyFile(
    path.join(extRoot, 'package.json'),
    path.join(stage, 'package.json')
  )
  await fs.copyFile(
    path.join(extRoot, 'README.md'),
    path.join(stage, 'README.md')
  )
  await fs.copyFile(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'))
  await fs.cp(path.join(extRoot, 'dist'), path.join(stage, 'dist'), {
    recursive: true,
  })

  await createVSIX({
    allowMissingRepository: true,
    skipLicense: true,
    dependencies: false,
    cwd: stage,
  })
}

main()
