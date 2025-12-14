// @ts-check

import { describe, expect, it } from 'vitest'

import { __testUtils } from './index.js'

const { coerceValue, isLikelyFilePath } = __testUtils

describe('coerceValue', () => {
  it('coerces number and boolean previews', () => {
    expect(coerceValue('42', 'number')).toBe(42)
    expect(coerceValue('false', 'boolean')).toBe(false)
  })

  it('returns the raw preview when coercion fails', () => {
    expect(coerceValue('not-a-number', 'number')).toBe('not-a-number')
  })

  it('treats the literal "null" preview as null', () => {
    expect(coerceValue('null', 'string')).toBeNull()
  })

  it('falls back to the declared type when no preview is provided', () => {
    expect(coerceValue(undefined, 'string')).toBe('string')
  })
})

describe('isLikelyFilePath', () => {
  it('accepts file:// URIs and absolute paths', () => {
    expect(isLikelyFilePath('file:///tmp/app.js')).toBe(true)
    expect(isLikelyFilePath('/usr/src/app.js')).toBe(true)
  })

  it('rejects node/internal and pseudo-paths', () => {
    expect(isLikelyFilePath('node:internal/fs')).toBe(false)
    expect(isLikelyFilePath('<anonymous>')).toBe(false)
  })
})
