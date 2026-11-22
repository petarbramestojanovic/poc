import { describe, expect, it } from 'vitest'
import {
  checkZeusInvariants,
  mapZeusRows,
  type CountedPixel,
  type Matched,
  type ZeusMapperInput,
} from '../../../src/modules/sync/connectors/zeus/mapper.ts'
import {
  zeusCampaignsRow,
  zeusCreativesRow,
  zeusDevicesRow,
  zeusTrackerRow,
  type ZeusCampaignsRow,
  type ZeusCreativesRow,
  type ZeusDevicesRow,
} from '../../../src/modules/sync/connectors/zeus/schema.ts'
import { ENTITIES, loadFixture } from './helpers.ts'

const creatives = (): Matched<ZeusCreativesRow>[] =>
  loadFixture('creatives').rows.map((raw) => {
    const row = zeusCreativesRow.parse(raw)
    return { entity: row.creative_id === 'ENG Swipe MPU V1' ? ENTITIES.mpuV1 : ENTITIES.mpuV2, row }
  })

/** The fixture's pixels as the connector resolves them: 9001 by the rule, 9002 mapped by hand. */
const tracker = (): CountedPixel[] =>
  loadFixture('tracker')
    .rows.map((raw) => zeusTrackerRow.parse(raw))
    .filter((row) => row.pixel_id !== '9999')
    .map((row) =>
      row.pixel_id === '9001'
        ? { entity: ENTITIES.mpuV1, role: 'engagement', row }
        : { entity: ENTITIES.finish, role: 'finish', row },
    )

const campaigns = (): Matched<ZeusCampaignsRow>[] =>
  loadFixture('campaigns').rows.map((raw) => ({
    entity: ENTITIES.campaign,
    row: zeusCampaignsRow.parse(raw),
  }))

/** The fixture's device rows of our campaign, on the campaign's own row. */
const devices = (): Matched<ZeusDevicesRow>[] =>
  loadFixture('devices')
    .rows.map((raw) => zeusDevicesRow.parse(raw))
    .filter((row) => row.campaign_id === '501')
    .map((row) => ({ entity: ENTITIES.campaign, row }))

const deviceRow = (over: Record<string, unknown> = {}): ZeusDevicesRow =>
  zeusDevicesRow.parse({
    date: '2026-09-01',
    campaign_id: 501,
    external_id: 'camp-ext-1',
    device_type: 'mobile',
    impressions: 100,
    clicks: 3,
    visible_impressions: 80,
    ...over,
  })

const mapperInput = (over: Partial<ZeusMapperInput> = {}): ZeusMapperInput => ({
  language: 'de',
  clickthroughCtaId: 'clickthrough',
  creatives: [],
  campaigns: [],
  devices: [],
  tracker: [],
  unmappedPixels: [],
  ...over,
})

const campaignRow = zeusCampaignsRow.parse({
  date: '2026-09-01',
  campaign_id: '501',
  impressions: 30_000,
  clicks: 210,
  visible_impressions: 23_500,
})

describe('Zeus mapper', () => {
  const UNMAPPED = 'pixel 9003 with code "view" on ENG Swipe MPU V1'
  const rows = mapZeusRows(
    mapperInput({
      creatives: creatives(),
      tracker: tracker(),
      unmappedPixels: [{ label: UNMAPPED, date: '2026-09-01', fires: 40 }],
    }),
  )

  it('produces one row per (date, campaign_tag) from the creatives report', () => {
    expect(rows.map((r) => `${r.date}|${r.campaignTag}`)).toEqual([
      '2026-09-01|',
      '2026-09-01|mpu_v1',
      '2026-09-01|mpu_v2',
      '2026-09-02|mpu_v1',
      '2026-09-02|mpu_v2',
      '2026-09-03|mpu_v1',
      '2026-09-03|mpu_v2',
    ])
    expect(rows[1]).toMatchObject({
      language: 'de',
      metrics: {
        impressions: 20_000,
        in_view: 16_000,
        unique_impressions_reported: 17_000,
        unique_clicks_reported: 140,
      },
      ctaClicks: [{ ctaId: 'clickthrough', count: 150 }],
      pageViews: [],
    })
  })

  it('counts a pixel’s fires as what its role says, on its entity’s creative only', () => {
    const v1 = rows.filter((r) => r.campaignTag === 'mpu_v1')
    const v2 = rows.filter((r) => r.campaignTag === 'mpu_v2')
    expect(v1.map((r) => r.metrics.game_started)).toEqual([600, 620, 640])
    expect(v1.map((r) => r.metrics.game_finished)).toEqual([290, 300, 310])
    for (const row of v2) {
      expect(row.metrics).not.toHaveProperty('game_started')
      expect(row.metrics).not.toHaveProperty('game_finished')
    }
  })

  it('never stores ratios or metrics Zeus does not measure', () => {
    for (const row of rows) {
      expect(Object.keys(row.metrics)).not.toContain('ctr')
      expect(Object.keys(row.metrics)).not.toContain('visibility')
      expect(row.metrics).not.toHaveProperty('dwell_avg_ms')
      expect(row.metrics).not.toHaveProperty('interactions')
    }
  })

  it('puts a pixel nobody has a role for into unmapped on an untagged row, counting nothing', () => {
    expect(rows[0]?.campaignTag).toBe('')
    expect(rows[0]?.metrics).toEqual({})
    expect(rows[0]?.unmapped).toEqual(new Map([[UNMAPPED, 40]]))
  })

  it('adds counts across creatives sharing a tag but never adds their per-day unique scalars', () => {
    const [first, second] = creatives().filter((c) => c.row.date === '2026-09-01')
    if (!first || !second) throw new Error('fixture needs two creatives on 2026-09-01')
    const sameTag = { ...ENTITIES.mpuV1, campaignTag: 'shared' }
    const warnings: string[] = []
    const merged = mapZeusRows(
      mapperInput({
        creatives: [
          { entity: sameTag, row: first.row },
          { entity: sameTag, row: second.row },
        ],
      }),
      (w) => warnings.push(w),
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]?.metrics.impressions).toBe(first.row.impressions + second.row.impressions)
    expect(merged[0]?.ctaClicks).toEqual([
      { ctaId: 'clickthrough', count: first.row.clicks + second.row.clicks },
    ])
    expect(merged[0]?.metrics).not.toHaveProperty('unique_impressions_reported')
    expect(merged[0]?.metrics).not.toHaveProperty('unique_clicks_reported')
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('uses the campaigns report the same way when a link has no creatives', () => {
    const campaignRows = mapZeusRows(
      mapperInput({ language: '', campaigns: [{ entity: ENTITIES.campaign, row: campaignRow }] }),
    )
    expect(campaignRows).toEqual([
      {
        date: '2026-09-01',
        language: '',
        campaignTag: '',
        metrics: { impressions: 30_000, in_view: 23_500 },
        ctaClicks: [{ ctaId: 'clickthrough', count: 210 }],
        pageViews: [],
        devices: [],
        unmapped: new Map(),
      },
    ])
  })
})

describe('Zeus mapper, the device split', () => {
  it('puts the campaign’s device rows on the campaign’s own row, beside its creatives’ rows', () => {
    const rows = mapZeusRows(mapperInput({ creatives: creatives(), devices: devices() }))
    const own = rows.filter((r) => r.campaignTag === '')

    expect(own.map((r) => r.date)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03'])
    expect(own[0]).toMatchObject({
      metrics: {},
      ctaClicks: [],
      devices: [
        { deviceType: 'desktop', impressions: 18_000, inView: 14_100, clicks: 126 },
        { deviceType: 'mobile', impressions: 10_000, inView: 7_900, clicks: 70 },
        { deviceType: 'tablet', impressions: 2_000, inView: 1_500, clicks: 14 },
      ],
    })
    // The creatives keep their delivery and get no device split of their own.
    for (const row of rows.filter((r) => r.campaignTag !== '')) expect(row.devices).toEqual([])
  })

  it('puts a device row that names a creative on that creative’s row', () => {
    const [first] = creatives()
    if (!first) throw new Error('fixture is empty')
    const [row] = mapZeusRows(
      mapperInput({
        creatives: [first],
        devices: [
          { entity: first.entity, row: deviceRow({ external_id: first.entity.externalId }) },
        ],
      }),
    )
    expect(row).toMatchObject({
      campaignTag: 'mpu_v1',
      metrics: { impressions: 20_000 },
      devices: [{ deviceType: 'mobile', impressions: 100, inView: 80, clicks: 3 }],
    })
  })

  it('keeps a day at one level: the creatives’ rows when it has any, else the campaign’s', () => {
    // Zeus sends the campaign's own split and, from 09-02, a split per creative too. Storing
    // both would count 09-02 twice in every read that adds the campaign's rows up.
    const onCreative = (date: string) => ({
      entity: ENTITIES.mpuV1,
      row: deviceRow({ date, external_id: ENTITIES.mpuV1.externalId, impressions: 60 }),
    })
    const rows = mapZeusRows(
      mapperInput({ devices: [...devices(), onCreative('2026-09-02'), onCreative('2026-09-03')] }),
    )
    expect(
      rows.map((r) => [r.date, r.campaignTag, r.devices.map((d) => [d.deviceType, d.impressions])]),
    ).toEqual([
      [
        '2026-09-01',
        '',
        [
          ['desktop', 18_000],
          ['mobile', 10_000],
          ['tablet', 2_000],
        ],
      ],
      ['2026-09-02', 'mpu_v1', [['mobile', 60]]],
      ['2026-09-03', 'mpu_v1', [['mobile', 60]]],
    ])
  })

  it('never stores the ratios Zeus sends with a device row', () => {
    const [row] = mapZeusRows(mapperInput({ devices: devices().slice(0, 1) }))
    expect(Object.keys(row?.devices[0] ?? {}).sort()).toEqual([
      'clicks',
      'deviceType',
      'impressions',
      'inView',
    ])
  })

  it.each([
    ['', 'unknown'],
    [null, 'unknown'],
    ['Mobile', 'mobile'],
    [' tablet ', 'tablet'],
  ])('reads the device %j as %s without a warning', (reported, deviceType) => {
    const warnings: string[] = []
    const [row] = mapZeusRows(
      mapperInput({
        devices: [{ entity: ENTITIES.campaign, row: deviceRow({ device_type: reported }) }],
      }),
      (w) => warnings.push(w),
    )
    expect(row?.devices).toEqual([{ deviceType, impressions: 100, inView: 80, clicks: 3 }])
    expect(warnings).toEqual([])
  })

  it('counts a device it has never heard of as unknown, says so once, and loses nothing', () => {
    const warnings: string[] = []
    const rows = mapZeusRows(
      mapperInput({
        devices: [
          { entity: ENTITIES.campaign, row: deviceRow({ device_type: 'tv', impressions: 7 }) },
          { entity: ENTITIES.campaign, row: deviceRow({ device_type: '', impressions: 5 }) },
          {
            entity: ENTITIES.campaign,
            row: deviceRow({ date: '2026-09-02', device_type: 'tv', impressions: 9 }),
          },
        ],
      }),
      (w) => warnings.push(w),
    )
    // Both land on `unknown` and add up, so the devices still total the delivery.
    expect(rows.map((r) => [r.date, r.devices.map((d) => [d.deviceType, d.impressions])])).toEqual([
      ['2026-09-01', [['unknown', 12]]],
      ['2026-09-02', [['unknown', 9]]],
    ])
    expect(warnings).toEqual([
      'devices: Zeus names a device "tv" we do not know; its rows are counted as unknown',
    ])
  })
})

describe('Zeus invariants', () => {
  const base = creatives()
  const input = (over: Partial<Parameters<typeof checkZeusInvariants>[0]> = {}) => ({
    creatives: base,
    campaigns: [],
    devices: [],
    tracker: tracker(),
    ...over,
  })

  it('passes on the fixture', () => {
    expect(() => {
      checkZeusInvariants(input())
    }).not.toThrow()
  })

  it.each([
    ['clicks', { clicks: 20_001 }],
    ['visible_impressions', { visible_impressions: 20_001 }],
    ['unique_impressions', { unique_impressions: 20_001 }],
  ])('warns instead of failing on a creative with %s > impressions', (name, patch) => {
    const [first, ...rest] = base
    if (!first) throw new Error('fixture is empty')
    const broken = [{ entity: first.entity, row: { ...first.row, ...patch } }, ...rest]
    const warnings: string[] = []

    expect(() => {
      checkZeusInvariants(input({ creatives: broken }), (w) => warnings.push(w))
    }).not.toThrow()
    expect(warnings).toEqual([
      `creative ${first.row.creative_id} on ${first.row.date}: Zeus reports ${name} 20001 > impressions ${first.row.impressions}; stored as reported`,
    ])
  })

  it('warns instead of failing when Zeus reports more unique clicks than clicks', () => {
    const [first, ...rest] = base
    if (!first) throw new Error('fixture is empty')
    const creative = {
      entity: first.entity,
      row: { ...first.row, unique_clicks: first.row.clicks + 3 },
    }
    const campaign = {
      entity: ENTITIES.campaign,
      row: { ...campaignRow, unique_clicks: campaignRow.clicks + 1 },
    }
    const warnings: string[] = []

    expect(() => {
      checkZeusInvariants(input({ creatives: [creative, ...rest], campaigns: [campaign] }), (w) =>
        warnings.push(w),
      )
    }).not.toThrow()
    expect(warnings).toEqual([
      `creative ${first.row.creative_id} on ${first.row.date}: Zeus reports unique_clicks ${first.row.clicks + 3} > clicks ${first.row.clicks}; stored as reported`,
      `campaign ${campaignRow.campaign_id} on ${campaignRow.date}: Zeus reports unique_clicks ${campaignRow.clicks + 1} > clicks ${campaignRow.clicks}; stored as reported`,
    ])
  })

  it('fails when a creative appears twice for one day', () => {
    expect(() => {
      checkZeusInvariants(input({ creatives: [...base, ...base.slice(0, 1)] }))
    }).toThrow(/appears twice/)
  })

  it('checks the campaigns report too: ratios and duplicate days', () => {
    const campaign = { entity: ENTITIES.campaign, row: campaignRow }
    expect(() => {
      checkZeusInvariants(input({ creatives: [], campaigns: [campaign] }))
    }).not.toThrow()
    const warnings: string[] = []
    expect(() => {
      checkZeusInvariants(
        input({
          creatives: [],
          campaigns: [{ ...campaign, row: { ...campaignRow, clicks: 30_001 } }],
        }),
        (w) => warnings.push(w),
      )
    }).not.toThrow()
    expect(warnings).toEqual([
      'campaign 501 on 2026-09-01: Zeus reports clicks 30001 > impressions 30000; stored as reported',
    ])
    expect(() => {
      checkZeusInvariants(input({ creatives: [], campaigns: [campaign, campaign] }))
    }).toThrow(/appears twice/)
  })

  it('checks the tracker report too: one row per pixel per day', () => {
    const [first, ...rest] = tracker()
    if (!first) throw new Error('fixture is empty')
    expect(() => {
      checkZeusInvariants(input({ tracker: [first, ...rest, first] }))
    }).toThrow(/pixel .* appears twice/)
  })

  it('rejects negative or fractional counts at the schema', () => {
    const raw = loadFixture('tracker').rows[0]
    expect(zeusTrackerRow.safeParse({ ...raw, fires: -1 }).success).toBe(false)
    expect(zeusTrackerRow.safeParse({ ...raw, fires: 1.5 }).success).toBe(false)
  })
})

describe('Zeus invariants, the device split', () => {
  const check = (over: Partial<Parameters<typeof checkZeusInvariants>[0]>) => {
    const warnings: string[] = []
    checkZeusInvariants({ creatives: [], campaigns: [], devices: [], tracker: [], ...over }, (w) =>
      warnings.push(w),
    )
    return warnings
  }
  const onCampaign = (over: Record<string, unknown> = {}) => ({
    entity: ENTITIES.campaign,
    row: deviceRow(over),
  })
  const onCreative = (over: Record<string, unknown> = {}) => ({
    entity: ENTITIES.mpuV1,
    row: deviceRow({ external_id: ENTITIES.mpuV1.externalId, ...over }),
  })

  it('passes on the fixture: the devices add up to the campaigns report', () => {
    expect(check({ campaigns: campaigns(), devices: devices() })).toEqual([])
  })

  it('fails when a device appears twice for one campaign and day', () => {
    expect(() => check({ devices: [onCampaign(), onCampaign()] })).toThrow(
      /device mobile of camp-ext-1 appears twice for 2026-09-01/,
    )
    // Another device, another day or another creative is another row.
    expect(
      check({
        devices: [
          onCampaign(),
          onCampaign({ device_type: 'desktop' }),
          onCampaign({ date: '2026-09-02' }),
        ],
      }),
    ).toEqual([])
  })

  it('lets a day have device rows for the campaign and for its creatives: the mapper keeps one level', () => {
    expect(check({ devices: [onCampaign(), onCreative()] })).toEqual([])
  })

  it.each([
    ['clicks', { clicks: 101 }],
    ['visible_impressions', { visible_impressions: 101 }],
  ])('warns instead of failing on a device with %s > impressions', (name, patch) => {
    expect(check({ devices: [onCampaign(patch)] })).toEqual([
      `device mobile of camp-ext-1 on 2026-09-01: Zeus reports ${name} 101 > impressions 100; stored as reported`,
    ])
  })

  it('warns when a campaign’s devices do not add up to its delivery, and stores both as reported', () => {
    const [first, ...rest] = devices()
    if (!first) throw new Error('fixture is empty')
    const short = { entity: first.entity, row: { ...first.row, impressions: 17_000 } }
    expect(check({ campaigns: campaigns(), devices: [short, ...rest] })).toEqual([
      'devices: camp-ext-1 on 2026-09-01: the device rows add up to 29000 impressions, the campaigns report has 30000; stored as reported',
    ])
  })

  it('checks a creative’s devices against the creatives report', () => {
    const [first] = creatives()
    if (!first) throw new Error('fixture is empty')
    expect(
      check({ creatives: [first], devices: [onCreative({ impressions: 20_000, clicks: 3 })] }),
    ).toEqual([])
    expect(check({ creatives: [first], devices: [onCreative({ impressions: 19_999 })] })).toEqual([
      'devices: ENG Swipe MPU V1 on 2026-09-01: the device rows add up to 19999 impressions, the creatives report has 20000; stored as reported',
    ])
  })

  it('has nothing to compare a day’s devices with when the delivery report has no row for it', () => {
    expect(check({ devices: [onCampaign()] })).toEqual([])
  })

  it('rejects a negative or fractional device count at the schema', () => {
    const raw = loadFixture('devices').rows[0]
    expect(zeusDevicesRow.safeParse({ ...raw, impressions: -1 }).success).toBe(false)
    expect(zeusDevicesRow.safeParse({ ...raw, clicks: 1.5 }).success).toBe(false)
    expect(zeusDevicesRow.safeParse({ ...raw, date: '2026-02-31' }).success).toBe(false)
  })
})
