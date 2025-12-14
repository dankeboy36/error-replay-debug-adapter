// @ts-check

import path from 'node:path'
import { fileURLToPath } from 'node:url'

// @ts-ignore
const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** @type {import('webpack').Configuration} */
const extensionConfig = {
  target: 'node',
  mode: 'none',
  entry: './packages/extension/src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'packages/extension/out'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
  },
  externals: {
    vscode: 'commonjs vscode',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
          },
        ],
      },
    ],
  },
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: 'log',
  },
}

export default [extensionConfig]
