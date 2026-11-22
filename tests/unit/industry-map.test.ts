import { describe, expect, it } from 'vitest'
import { INDUSTRY_MAP, mapIndustry, normalize } from '../../src/modules/industries/map.ts'

// The keyword table: known brands by plain substring, first hit wins, umlauts folded. That every
// industry it names exists in app.industry is tests/integration/schema.test.ts.

describe('mapIndustry', () => {
  it('folds umlauts, so Vöslauer and Voeslauer are the same brand', () => {
    expect(mapIndustry('Vöslauer Mineralwasser GmbH', 'AT2604 Summer')).toBe('FMCG / CPG')
    expect(mapIndustry('Voeslauer Mineralwasser GmbH', 'AT2604 Summer')).toBe('FMCG / CPG')
  })

  it('finds the brand in the campaign name when the company says nothing', () => {
    expect(mapIndustry('', 'AT2603 BRAVO Awareness')).toBe('FMCG / CPG')
    expect(mapIndustry(null, 'AT2603 BRAVO Awareness')).toBe('FMCG / CPG')
  })

  it('knows a food retailer', () => {
    expect(mapIndustry('Some Agency GmbH', 'DE2606 LIDL Punkte')).toBe('Food Retail')
  })

  it('takes the earlier entry when two brands match', () => {
    // 'rauch' is FMCG / CPG, 'penny' Food Retail; FMCG / CPG comes first in the table.
    expect(mapIndustry('Penny Markt GmbH', 'AT2605 Rauch Eistee at Penny')).toBe('FMCG / CPG')
  })

  it('reads the company and the campaign name as one text, normalized', () => {
    // 'carpe diem' only exists once both are joined.
    expect(mapIndustry('Carpe', 'Diem Kombucha')).toBe('FMCG / CPG')
    expect(mapIndustry('Schloß Schönbrunn', 'Winter')).toBe('Travel & Tourism')
  })

  it('answers null when nothing matches, for the LLM to decide', () => {
    expect(mapIndustry('Acme Widgets AG', 'CH2607 Launch')).toBeNull()
  })

  it('answers null for empty input', () => {
    expect(mapIndustry('', '')).toBeNull()
    expect(mapIndustry(null, undefined)).toBeNull()
    expect(mapIndustry('  ', ' – ')).toBeNull()
  })
})

describe('INDUSTRY_MAP', () => {
  it('holds every keyword already in normalized form', () => {
    for (const { industry, keywords } of INDUSTRY_MAP) {
      for (const keyword of keywords) expect(normalize(keyword), industry).toBe(keyword)
    }
  })

  it('names each industry once', () => {
    const names = INDUSTRY_MAP.map((entry) => entry.industry)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('normalize', () => {
  it('lowercases, folds umlauts and ß, and collapses everything else to single spaces', () => {
    expect(normalize('  Dragée-Keksi  ÄÖÜ ß!! ')).toBe('drag e keksi aeoeue ss')
    expect(normalize(null)).toBe('')
  })
})
