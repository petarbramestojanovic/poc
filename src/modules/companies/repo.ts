import type { Queryable } from '../../core/db.ts'
import {
  toExternalRef,
  type ExternalRef,
  type ExternalRefColumns,
} from '../../core/external-ref.ts'
import { loadSql } from '../../core/sql-file.ts'

// Every company statement, one function each. SQL lives in ./sql/*.sql and is read at import time.
const sql = loadSql(import.meta.url, [
  'find_company',
  'find_company_by_ref',
  'find_company_by_name',
  'insert_company',
  'update_company_name',
  'list_companies',
] as const)

export interface CompanyRecord {
  id: string
  name: string
  externalRef: ExternalRef | null
}

interface CompanyRow extends ExternalRefColumns {
  id: string
  name: string
}

const toCompany = (row: CompanyRow): CompanyRecord => ({
  id: row.id,
  name: row.name,
  externalRef: toExternalRef(row),
})

const first = (rows: CompanyRow[]): CompanyRecord | undefined =>
  rows[0] === undefined ? undefined : toCompany(rows[0])

function required(row: CompanyRow | undefined, statement: string): CompanyRow {
  if (row === undefined) throw new Error(`${statement} returned no row`)
  return row
}

export async function findCompany(q: Queryable, id: string): Promise<CompanyRecord | undefined> {
  return first(await q.query<CompanyRow>(sql.find_company, [id]))
}

export async function findCompanyByRef(
  q: Queryable,
  ref: ExternalRef,
): Promise<CompanyRecord | undefined> {
  return first(await q.query<CompanyRow>(sql.find_company_by_ref, [ref.system, ref.id]))
}

export async function findCompanyByName(
  q: Queryable,
  name: string,
): Promise<CompanyRecord | undefined> {
  return first(await q.query<CompanyRow>(sql.find_company_by_name, [name]))
}

export async function insertCompany(
  q: Queryable,
  name: string,
  ref: ExternalRef | undefined,
): Promise<CompanyRecord> {
  const rows = await q.query<CompanyRow>(sql.insert_company, [
    name,
    ref?.system ?? null,
    ref?.id ?? null,
  ])
  return toCompany(required(rows[0], 'insert_company'))
}

export async function updateCompanyName(
  q: Queryable,
  id: string,
  name: string,
): Promise<CompanyRecord> {
  const rows = await q.query<CompanyRow>(sql.update_company_name, [id, name])
  return toCompany(required(rows[0], 'update_company_name'))
}

export interface CompanyListItem extends CompanyRecord {
  campaigns: number
}

export async function listCompanies(q: Queryable): Promise<CompanyListItem[]> {
  const rows = await q.query<CompanyRow & { campaigns: number }>(sql.list_companies)
  return rows.map((row) => ({ ...toCompany(row), campaigns: row.campaigns }))
}
