import type { Tx } from '../../core/db.ts'
import { CompanyNameExistsError, CompanyNotFoundError } from './errors.ts'
import type { CompanyRef } from './input.ts'
import * as repo from './repo.ts'

// How a company is found or created. There is no route for it: companies are created only inside
// a campaign setup (campaigns/service.ts setUpCampaign), which the Salesforce webhook drives, so
// both functions take the setup's transaction. Lock order: the company first, then the campaign.

/** Serialises setups naming the same company, so two of them cannot both create it. */
export async function lockCompany(tx: Tx, ref: CompanyRef): Promise<void> {
  if ('id' in ref) return
  // By reference when there is one; otherwise by name, so two people creating "Rauch" at the
  // same moment cannot both pass the name check.
  await tx.xactLock(
    ref.externalRef
      ? `company-setup:${ref.externalRef.system}:${ref.externalRef.id}`
      : `company-name:${ref.name.toLowerCase()}`,
  )
  // Then the former reference, always second: two accounts that once shared it cannot both move
  // the same company to themselves.
  if (ref.formerRef) {
    await tx.xactLock(`company-setup:${ref.formerRef.system}:${ref.formerRef.id}`)
  }
}

/**
 * The company a setup means: by our id; by its external reference, created the first time and
 * renamed when the name it is pushed with changes; or by a name that must not exist yet.
 *
 * A company not yet known by its external reference but by `formerRef` — the key its system used
 * before — is moved to the new reference once, so its campaigns and webhooks stay with it. After
 * that the former key finds nothing, and a second account that once shared it gets its own company.
 *
 * `known` is the company of the campaign a push matched: a push that names that company by name
 * alone means that company, and is not refused as a duplicate name.
 */
export async function resolveCompany(
  tx: Tx,
  ref: CompanyRef,
  known: repo.CompanyRecord | undefined,
): Promise<repo.CompanyRecord> {
  if ('id' in ref) {
    const company = await repo.findCompany(tx, ref.id)
    if (!company) throw new CompanyNotFoundError(`company ${ref.id} does not exist`)
    return company
  }

  if (ref.externalRef) {
    let company = await repo.findCompanyByRef(tx, ref.externalRef)
    if (!company && ref.formerRef) {
      const former = await repo.findCompanyByRef(tx, ref.formerRef)
      if (former) company = await repo.updateCompanyRef(tx, former.id, ref.externalRef)
    }
    if (!company) return repo.insertCompany(tx, ref.name, ref.externalRef)
    return company.name === ref.name ? company : repo.updateCompanyName(tx, company.id, ref.name)
  }

  if (known?.name.toLowerCase() === ref.name.toLowerCase()) return known

  // A name is never matched silently: a company is the boundary a client's webhook reports
  // across, and attaching a campaign to a namesake would leak it into another client's report.
  const namesake = await repo.findCompanyByName(tx, ref.name)
  if (namesake) {
    throw new CompanyNameExistsError(
      `a company named '${namesake.name}' already exists (${namesake.id}); pass company.id to use it`,
    )
  }
  return repo.insertCompany(tx, ref.name, undefined)
}
