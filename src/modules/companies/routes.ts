import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Db } from '../../core/db.ts'
import { externalRefSchema } from '../../core/external-ref.ts'
import * as repo from './repo.ts'

// /companies, inside its own admin scope (app.ts), so the bearer check runs first. Read-only:
// companies are created by the Salesforce report, through a campaign setup.

export interface CompanyDeps {
  db: Db
}

export const companyResponse = z.object({
  id: z.guid(),
  name: z.string(),
  externalRef: externalRefSchema.nullable(),
})

export const companyRoutes: FastifyPluginAsync<{ deps: CompanyDeps }> = async (app, { deps }) => {
  app.get(
    '/',
    { schema: { response: { 200: z.array(companyResponse.extend({ campaigns: z.number() })) } } },
    async () => repo.listCompanies(deps.db),
  )
}
