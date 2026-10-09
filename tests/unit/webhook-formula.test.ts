import { describe, expect, it } from 'vitest'
import { InvalidFormulaError } from '../../src/modules/webhooks/errors.ts'
import {
  evaluate,
  fromNumber,
  MAX_FORMULA_DEPTH,
  MAX_FORMULA_LENGTH,
  parseDecimal,
  parseFormula,
  toRoundedNumber,
  variablesOf,
  type Fraction,
} from '../../src/modules/webhooks/formula.ts'

// The formulas behind calculated webhook fields. Everything a client is billed from goes through
// here, so the cases are the ones that go wrong in practice: precedence, exact money, rounding at
// the half, null and division by zero, and every way a formula can be mistyped.

const values: Record<string, number | null> = {
  impressions: 12610,
  price: 15.5876,
  clicks: 0,
  zero: 0,
  missing: null,
}

/** Computes a formula with the table above and rounds it, or returns null. */
function compute(formula: string, decimals = 6): number | null {
  const result = evaluate(parseFormula(formula), (name) => {
    const value = values[name]
    return value === null || value === undefined ? null : fromNumber(value)
  })
  return result === null ? null : toRoundedNumber(result, decimals)
}

function errorOf(formula: string): string {
  try {
    parseFormula(formula)
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidFormulaError)
    return (error as InvalidFormulaError).message
  }
  throw new Error(`"${formula}" parsed`)
}

describe('parseFormula and evaluate', () => {
  it.each([
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['10 - 4 - 3', 3], // left to right, not 10 - (4 - 3)
    ['100 / 10 / 5', 2],
    ['-2 * 3', -6],
    ['- -2', 2],
    ['2 * -3', -6],
    ['1.5 + 0.25', 1.75],
    ['  impressions   /1000*price ', 196.559636],
  ])('%s = %d', (formula, expected) => {
    expect(compute(formula)).toBe(expected)
  })

  it('computes money exactly and rounds once, at the end', () => {
    // 12610 × 15.5876 / 1000 = 196.559636 exactly; floating point gives 196.55963600000001.
    expect(compute('impressions / 1000 * price', 2)).toBe(196.56)
    expect(compute('impressions * price / 1000', 2)).toBe(196.56)
  })

  it('gives null, never 0, when a variable has no value', () => {
    expect(compute('impressions / 1000 * missing')).toBeNull()
    expect(compute('missing * 0')).toBeNull()
  })

  it('gives null for a division by zero, wherever it happens', () => {
    expect(compute('clicks / zero')).toBeNull()
    expect(compute('1 + impressions / (price - price)')).toBeNull()
    // Zero divided by something is an honest 0.
    expect(compute('clicks / impressions')).toBe(0)
  })

  it('lists the variables a formula reads, once each, in order', () => {
    expect(variablesOf(parseFormula('clicks / impressions + impressions * price'))).toEqual([
      'clicks',
      'impressions',
      'price',
    ])
    expect(variablesOf(parseFormula('1000 * 2'))).toEqual([])
  })

  it('asks the lookup for any name, including ones an object would already have', () => {
    const asked: string[] = []
    const result = evaluate(parseFormula('constructor + __proto__'), (name) => {
      asked.push(name)
      return null
    })
    expect(result).toBeNull()
    expect(asked).toEqual(['constructor'])
  })
})

describe('parseFormula refuses', () => {
  it.each([
    ['', 'formula is empty'],
    ['   ', 'formula is empty'],
    ['impressions / 1000 *', 'formula ends where a number, a variable or "(" should follow'],
    ['impressions / 1000 * price)', 'unexpected ")" at 27'],
    ['(impressions / 1000', 'missing ")" for the "(" at 1'],
    ['impressions price', 'unexpected "price" at 13'],
    ['impressions % 2', 'unexpected "%" at 13'],
    ['1. + 2', 'malformed number at 1'],
    ['1.5.2', 'malformed number at 1'],
    ['.5 * price', 'unexpected "." at 1'],
    ['* price', 'unexpected "*" at 1'],
    ['()', 'unexpected ")" at 2'],
    ['impressions / 1000 * price; drop table', 'unexpected ";" at 27'],
  ])('%j: %s', (formula, message) => {
    expect(errorOf(formula)).toBe(message)
  })

  it('a formula longer than the limit', () => {
    const formula = `1${' + 1'.repeat(MAX_FORMULA_LENGTH)}`
    expect(errorOf(formula)).toBe(`formula is longer than ${MAX_FORMULA_LENGTH} characters`)
  })

  it('nesting deeper than the limit, before the stack notices', () => {
    const deep = `${'('.repeat(MAX_FORMULA_DEPTH + 1)}1${')'.repeat(MAX_FORMULA_DEPTH + 1)}`
    expect(errorOf(deep)).toMatch(/^formula nests deeper than 32 levels at \d+$/)
    expect(errorOf(`${'-'.repeat(MAX_FORMULA_DEPTH + 1)}1`)).toMatch(/nests deeper/)
    // Exactly at the limit is fine.
    const limit = `${'('.repeat(MAX_FORMULA_DEPTH)}1${')'.repeat(MAX_FORMULA_DEPTH)}`
    expect(compute(limit)).toBe(1)
  })
})

describe('fractions', () => {
  const round = (text: string, decimals: number) => toRoundedNumber(parseDecimal(text), decimals)

  it('round half away from zero, as Postgres round(numeric) does', () => {
    expect(round('0.125', 2)).toBe(0.13)
    expect(round('-0.125', 2)).toBe(-0.13)
    expect(round('0.1249999', 2)).toBe(0.12)
    expect(round('2.5', 0)).toBe(3)
    expect(round('-2.5', 0)).toBe(-3)
    expect(round('15.5876', 4)).toBe(15.5876)
  })

  it('never produce -0', () => {
    expect(Object.is(round('-0.001', 2), 0)).toBe(true)
  })

  it('read a JSON number exactly as it was written', () => {
    const exact = (value: number, n: bigint, d: bigint) => {
      expect(fromNumber(value)).toEqual<Fraction>({ n, d })
    }
    exact(1166.67, 116667n, 100n)
    exact(15.5876, 38969n, 2500n)
    exact(1e-7, 1n, 10_000_000n) // String(1e-7) is '1e-7'
    exact(1e21, 10n ** 21n, 1n) // String(1e21) is '1e+21'
    expect(() => fromNumber(Number.NaN)).toThrow(RangeError)
    expect(() => fromNumber(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })

  it('refuse text that is not a decimal', () => {
    expect(() => parseDecimal('12,5')).toThrow(RangeError)
    expect(() => parseDecimal('')).toThrow(RangeError)
  })

  it('refuse a meaningless number of decimals', () => {
    expect(() => toRoundedNumber(parseDecimal('1'), -1)).toThrow(RangeError)
    expect(() => toRoundedNumber(parseDecimal('1'), 1.5)).toThrow(RangeError)
  })
})
