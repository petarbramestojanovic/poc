// The keyword table: known brands and the industry they belong to, checked against the account
// name and the campaign name. Pure, no I/O. A hit is written in the transaction that creates the
// campaign (campaigns/service.ts); no hit leaves the industry to the LLM (./llm.ts).
//
// The table, its order and the matching (plain substring, first hit wins) are those of Brame's KPI
// dashboard, so both services put a campaign in the same industry. Every industry named here must
// exist in app.industry: verifyIndustryMap (./service.ts) checks that at boot.

/** Who set a campaign's industry: the keyword table, the LLM, or a person. */
export const INDUSTRY_SOURCES = ['map', 'llm', 'manual'] as const
export type IndustrySource = (typeof INDUSTRY_SOURCES)[number]

/** Lowercase, fold German umlauts to their expanded form, collapse everything else to single spaces. */
export function normalize(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Ordered. Keywords are already normalized. Keep the order: an earlier entry wins. */
export const INDUSTRY_MAP: readonly { industry: string; keywords: readonly string[] }[] = [
  {
    industry: 'FMCG / CPG',
    keywords: [
      'rauch',
      'bravo',
      'carpe diem',
      'happy day',
      'eistee',
      'my tea',
      'mytea',
      'cafemio',
      'juice bar',
      'eislimo',
      'yippy',
      'voeslauer',
      'stiegl',
      'privatbrauerei',
      'privatbrauerein',
      'pernod ricard',
      'lillet',
      'dragee keksi',
    ],
  },
  { industry: 'Retail', keywords: ['tchibo', 'eduscho', 'xlch', 'mediamarkt'] },
  { industry: 'Food Retail', keywords: ['penny', 'lidl', 'hofer', 'denner'] },
  {
    industry: 'Travel & Tourism',
    keywords: [
      'schauinsland',
      'saalbach',
      'tourismusverband',
      'schloss schoenbrunn',
      'schoenbrunn',
      'schloss hof',
    ],
  },
  { industry: 'Automotive', keywords: ['byd', 'porsche', 'volvo', 'mazda'] },
  {
    industry: 'Finance & Insurance',
    keywords: ['nlb', 'ebspk', 'unicredit', 'volksbank', 'teambank', 'baufinanzierung'],
  },
  { industry: 'Other Industries', keywords: ['msd'] },
]

/** The industry of a known brand, or null (→ the LLM decides). */
export function mapIndustry(
  companyName: string | null | undefined,
  campaignName: string | null | undefined,
): string | null {
  const hay = normalize(`${companyName ?? ''} ${campaignName ?? ''}`)
  if (!hay) return null
  for (const entry of INDUSTRY_MAP) {
    for (const keyword of entry.keywords) {
      if (hay.includes(keyword)) return entry.industry
    }
  }
  return null
}
