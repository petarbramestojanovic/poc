import type { CellValue, ReportRow } from './rows.ts'

// The CSV form of a report (docs/WEBHOOK-PAYLOAD-v2.md), as Funnel's File Import reads it: UTF-8
// without a byte order mark, comma-separated, a header row with the column names, CRLF line ends
// (RFC 4180). A cell is quoted only when it has to be — a comma, a double quote, a line break or
// space at either end — and a quote inside it is doubled. A number is written exactly as the JSON
// body writes it (dot decimal, no thousands separator); a cell without a value is empty.

const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/

export function renderCsv(names: readonly string[], rows: readonly ReportRow[]): string {
  const lines = [names, ...rows].map((cells) => cells.map(cell).join(','))
  return `${lines.join('\r\n')}\r\n`
}

function cell(value: CellValue): string {
  if (value === null) return ''
  const text = typeof value === 'number' ? JSON.stringify(value) : value
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
