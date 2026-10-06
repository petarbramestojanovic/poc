import { InvalidFormulaError } from './errors.ts'

// The formulas behind calculated webhook fields (src/webhooks/fields.ts), e.g. the cost of a
// campaign as `impressions / 1000 * price`. A Brame admin writes them; this module reads and
// computes them. Two properties matter more than anything else here:
//
//   * Nothing is executed. A formula is parsed into a tree by the recursive-descent parser below
//     and computed by walking that tree: no eval, no Function, no SQL.
//   * Money is exact. Every value is a fraction of two BigInts, so 12610 × 15.5876 / 1000 is
//     196.559636 exactly, not a float near it, and rounding happens once, at the very end.
//
// Grammar:
//   expression := term (('+' | '-') term)*
//   term       := unary (('*' | '/') unary)*
//   unary      := '-' unary | primary
//   primary    := number | variable | '(' expression ')'
//   number     := digit+ ('.' digit+)?
//   variable   := [A-Za-z_][A-Za-z0-9_]*
//
// Which variables exist, and what they hold, is the caller's business: fields.ts checks them
// before a formula is saved and supplies their values at every level of a payload.

export const MAX_FORMULA_LENGTH = 500

/** How deep parentheses and unary minus may nest, so the recursion stays bounded. */
export const MAX_FORMULA_DEPTH = 32

/** An exact rational number n / d, with d > 0 and the fraction in lowest terms. */
export interface Fraction {
  readonly n: bigint
  readonly d: bigint
}

export type BinaryOperator = '+' | '-' | '*' | '/'

export type Expr =
  | { readonly kind: 'number'; readonly value: Fraction }
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'negate'; readonly operand: Expr }
  | {
      readonly kind: 'binary'
      readonly op: BinaryOperator
      readonly left: Expr
      readonly right: Expr
    }

// ---------------------------------------------------------------------------------------------
// Fractions
// ---------------------------------------------------------------------------------------------

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a
  let y = b < 0n ? -b : b
  while (y !== 0n) [x, y] = [y, x % y]
  return x
}

function fraction(n: bigint, d: bigint): Fraction {
  if (d === 0n) throw new RangeError('a fraction cannot have a zero denominator')
  const sign = d < 0n ? -1n : 1n
  const divisor = gcd(n, d) || 1n
  return { n: (sign * n) / divisor, d: (sign * d) / divisor }
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/

/** A decimal written out in text, exactly: '15.5876', '-3', '1e-7'. */
export function parseDecimal(text: string): Fraction {
  const match = DECIMAL.exec(text)
  if (!match) throw new RangeError(`not a decimal number: ${text}`)
  const [, sign = '', whole = '', decimals = '', exponent = '0'] = match
  let n = BigInt(whole + decimals)
  let d = 10n ** BigInt(decimals.length)
  const shift = Number(exponent)
  if (shift > 0) n *= 10n ** BigInt(shift)
  if (shift < 0) d *= 10n ** BigInt(-shift)
  return fraction(sign === '-' ? -n : n, d)
}

/**
 * A JSON number, exactly as it was written. `String(value)` is the shortest decimal that reads back
 * as the same double, which for the values a payload carries (counts, and averages and prices of at
 * most four decimals) is the decimal Postgres sent.
 */
export function fromNumber(value: number): Fraction {
  if (!Number.isFinite(value)) throw new RangeError(`not a finite number: ${String(value)}`)
  return parseDecimal(String(value))
}

/**
 * Rounds half away from zero to `decimals` places, as Postgres round(numeric) does, and returns
 * the JSON number for it. -0 never comes out: a value that rounds to zero is 0.
 */
export function toRoundedNumber(value: Fraction, decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(`decimals must be a whole number >= 0, got ${String(decimals)}`)
  }
  const scaled = value.n * 10n ** BigInt(decimals)
  const negative = scaled < 0n
  const magnitude = negative ? -scaled : scaled
  let units = magnitude / value.d
  if ((magnitude % value.d) * 2n >= value.d) units += 1n
  const digits = units.toString().padStart(decimals + 1, '0')
  const text = decimals === 0 ? digits : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`
  return Number(negative && units !== 0n ? `-${text}` : text)
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

type Token =
  | { readonly kind: 'number' | 'variable'; readonly text: string; readonly at: number }
  | { readonly kind: 'symbol'; readonly text: BinaryOperator | '(' | ')'; readonly at: number }
  | { readonly kind: 'end'; readonly at: number }

const SYMBOLS = new Set(['+', '-', '*', '/', '(', ')'])
const NUMBER = /^\d+(\.\d+)?/
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*/

/** Positions in messages are 1-based characters, as a person counts them in the formula. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < text.length) {
    const char = text.charAt(index)
    const at = index + 1
    if (/\s/.test(char)) {
      index += 1
    } else if (SYMBOLS.has(char)) {
      tokens.push({ kind: 'symbol', text: char as BinaryOperator | '(' | ')', at })
      index += 1
    } else if (/\d/.test(char)) {
      const literal = NUMBER.exec(text.slice(index))?.[0] ?? char
      // '1.' and '1.5.2': a dot that no digits follow is not part of any number.
      if (text.charAt(index + literal.length) === '.') {
        throw new InvalidFormulaError(`malformed number at ${at}`)
      }
      tokens.push({ kind: 'number', text: literal, at })
      index += literal.length
    } else if (VARIABLE.test(char)) {
      const name = VARIABLE.exec(text.slice(index))?.[0] ?? char
      tokens.push({ kind: 'variable', text: name, at })
      index += name.length
    } else {
      throw new InvalidFormulaError(`unexpected ${JSON.stringify(char)} at ${at}`)
    }
  }
  tokens.push({ kind: 'end', at: text.length + 1 })
  return tokens
}

type SymbolToken = Extract<Token, { kind: 'symbol' }>

class Parser {
  private readonly tokens: readonly Token[]
  private index = 0

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens
  }

  parse(): Expr {
    const expr = this.expression(0)
    const next = this.peek()
    if (next.kind !== 'end') throw unexpected(next)
    return expr
  }

  private expression(depth: number): Expr {
    let left = this.term(depth)
    for (let next = this.peek(); isSymbol(next, '+') || isSymbol(next, '-'); next = this.peek()) {
      this.advance()
      left = { kind: 'binary', op: next.text as BinaryOperator, left, right: this.term(depth) }
    }
    return left
  }

  private term(depth: number): Expr {
    let left = this.unary(depth)
    for (let next = this.peek(); isSymbol(next, '*') || isSymbol(next, '/'); next = this.peek()) {
      this.advance()
      left = { kind: 'binary', op: next.text as BinaryOperator, left, right: this.unary(depth) }
    }
    return left
  }

  private unary(depth: number): Expr {
    const token = this.peek()
    if (isSymbol(token, '-')) {
      this.advance()
      return { kind: 'negate', operand: this.unary(deeper(depth, token)) }
    }
    return this.primary(depth)
  }

  private primary(depth: number): Expr {
    const token = this.advance()
    switch (token.kind) {
      case 'number':
        return { kind: 'number', value: parseDecimal(token.text) }
      case 'variable':
        return { kind: 'variable', name: token.text }
      case 'symbol': {
        if (token.text !== '(') throw unexpected(token)
        const inner = this.expression(deeper(depth, token))
        const close = this.advance()
        if (close.kind === 'end') {
          throw new InvalidFormulaError(`missing ")" for the "(" at ${token.at}`)
        }
        if (!isSymbol(close, ')')) throw unexpected(close)
        return inner
      }
      case 'end':
        throw unexpected(token)
    }
  }

  private peek(): Token {
    return this.tokens[this.index] ?? { kind: 'end', at: 0 }
  }

  private advance(): Token {
    const token = this.peek()
    if (token.kind !== 'end') this.index += 1
    return token
  }
}

function isSymbol(token: Token, text: SymbolToken['text']): token is SymbolToken {
  return token.kind === 'symbol' && token.text === text
}

function deeper(depth: number, token: Token): number {
  if (depth >= MAX_FORMULA_DEPTH) {
    throw new InvalidFormulaError(
      `formula nests deeper than ${MAX_FORMULA_DEPTH} levels at ${token.at}`,
    )
  }
  return depth + 1
}

function unexpected(token: Token): InvalidFormulaError {
  return token.kind === 'end'
    ? new InvalidFormulaError('formula ends where a number, a variable or "(" should follow')
    : new InvalidFormulaError(`unexpected "${token.text}" at ${token.at}`)
}

/** Reads a formula, or throws InvalidFormulaError saying what is wrong and where. */
export function parseFormula(text: string): Expr {
  if (text.length > MAX_FORMULA_LENGTH) {
    throw new InvalidFormulaError(`formula is longer than ${MAX_FORMULA_LENGTH} characters`)
  }
  if (text.trim() === '') throw new InvalidFormulaError('formula is empty')
  return new Parser(tokenize(text)).parse()
}

/** Every variable a formula reads, in order of first use. */
export function variablesOf(expr: Expr): string[] {
  const names = new Set<string>()
  const walk = (node: Expr): void => {
    switch (node.kind) {
      case 'variable':
        names.add(node.name)
        return
      case 'negate':
        walk(node.operand)
        return
      case 'binary':
        walk(node.left)
        walk(node.right)
        return
      case 'number':
        return
    }
  }
  walk(expr)
  return [...names]
}

// ---------------------------------------------------------------------------------------------
// Computing
// ---------------------------------------------------------------------------------------------

/** A variable's value at one level of a payload; null when it has none there. */
export type Lookup = (name: string) => Fraction | null

/**
 * Computes a formula exactly. Null in, null out: a variable without a value, or a division by
 * zero, makes the whole result null — never 0, which would claim a value nobody measured.
 */
export function evaluate(expr: Expr, lookup: Lookup): Fraction | null {
  switch (expr.kind) {
    case 'number':
      return expr.value
    case 'variable':
      return lookup(expr.name)
    case 'negate': {
      const value = evaluate(expr.operand, lookup)
      return value === null ? null : fraction(-value.n, value.d)
    }
    case 'binary': {
      const left = evaluate(expr.left, lookup)
      if (left === null) return null
      const right = evaluate(expr.right, lookup)
      if (right === null) return null
      switch (expr.op) {
        case '+':
          return fraction(left.n * right.d + right.n * left.d, left.d * right.d)
        case '-':
          return fraction(left.n * right.d - right.n * left.d, left.d * right.d)
        case '*':
          return fraction(left.n * right.n, left.d * right.d)
        case '/':
          return right.n === 0n ? null : fraction(left.n * right.d, left.d * right.n)
      }
    }
  }
}
