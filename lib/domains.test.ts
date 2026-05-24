import { describe, it, expect } from 'vitest'
import { DOMAINS, DEFAULT_DOMAIN, isDomainId } from './domains'

describe('isDomainId', () => {
  it('accepts all configured domain ids', () => {
    for (const id of Object.keys(DOMAINS)) {
      expect(isDomainId(id)).toBe(true)
    }
  })

  it('rejects unknown strings', () => {
    expect(isDomainId('finance')).toBe(false)
    expect(isDomainId('')).toBe(false)
  })

  it('rejects non-string values', () => {
    expect(isDomainId(null)).toBe(false)
    expect(isDomainId(undefined)).toBe(false)
    expect(isDomainId(42)).toBe(false)
  })

  it('default domain is valid', () => {
    expect(isDomainId(DEFAULT_DOMAIN)).toBe(true)
    expect(DEFAULT_DOMAIN).toBe('general')
  })
})

describe('DOMAINS', () => {
  it('every domain has at least one source', () => {
    for (const cfg of Object.values(DOMAINS)) {
      expect(cfg.sources.length).toBeGreaterThan(0)
    }
  })
})
