import { describe, expect, it } from 'vitest'
import {
  crc32,
  PLACEHOLDER_HEIGHT,
  PLACEHOLDER_WIDTH,
  placeholderFilename,
  placeholderIndexHtml,
  placeholderZip,
  storedZip,
} from '../../../src/modules/sync/connectors/nexd/placeholder.ts'
import { at } from '../../helpers.ts'

// The zip provisioning imports, read back the way an unzipper would: local headers, central
// directory, end record. No library, so the reader here is the spec.

interface Entry {
  name: string
  crc: number
  size: number
  data: Buffer
}

/** Reads a stored zip through its central directory. */
function readZip(zip: Buffer): Entry[] {
  const end = zip.length - 22
  expect(zip.readUInt32LE(end)).toBe(0x06054b50)
  const count = zip.readUInt16LE(end + 10)
  let offset = zip.readUInt32LE(end + 16)
  const entries: Entry[] = []
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50)
    const crc = zip.readUInt32LE(offset + 16)
    const size = zip.readUInt32LE(offset + 24)
    const nameLength = zip.readUInt16LE(offset + 28)
    const local = zip.readUInt32LE(offset + 42)
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    // The local header the directory points at, then the stored bytes.
    expect(zip.readUInt32LE(local)).toBe(0x04034b50)
    expect(zip.readUInt16LE(local + 8)).toBe(0) // stored
    const localNameLength = zip.readUInt16LE(local + 26)
    const start = local + 30 + localNameLength
    entries.push({ name, crc, size, data: zip.subarray(start, start + size) })
    offset += 46 + nameLength
  }
  return entries
}

describe('placeholder creative', () => {
  it('computes CRC-32 as everyone else does', () => {
    // The check value of the CRC-32 everyone implements (IEEE 802.3): crc32("123456789").
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
    expect(crc32(Buffer.alloc(0))).toBe(0)
  })

  it('is a zip with index.html and manifest.json at the root, bytes and checksums intact', () => {
    const zip = placeholderZip({ campaignName: 'DE2611 Tchibo Winter', creativeName: 'Swipe Card' })
    const entries = readZip(zip)

    expect(entries.map((e) => e.name)).toEqual(['index.html', 'manifest.json'])
    for (const entry of entries) {
      expect(entry.data.length).toBe(entry.size)
      expect(crc32(entry.data)).toBe(entry.crc)
    }
    expect(JSON.parse(at(entries, 1).data.toString('utf8'))).toEqual({
      width: PLACEHOLDER_WIDTH,
      height: PLACEHOLDER_HEIGHT,
      source: 'index.html',
    })
  })

  it('declares what NEXD reads: the ad size, a clickTag opened by script, one block root', () => {
    const html = placeholderIndexHtml({ campaignName: 'A <b>', creativeName: 'Swipe "Card"' })
    expect(html).toContain(
      `<meta name="ad.size" content="width=${PLACEHOLDER_WIDTH},height=${PLACEHOLDER_HEIGHT}">`,
    )
    expect(html).toContain('var clickTag = "https://www.brame.io/";')
    expect(html).toContain('href="javascript:void(window.open(clickTag))"')
    expect(html).toContain(
      `#ad { width: ${PLACEHOLDER_WIDTH}px; height: ${PLACEHOLDER_HEIGHT}px; display: block;`,
    )
    // Names are shown, never injected as markup.
    expect(html).toContain('A &lt;b&gt; · Swipe &quot;Card&quot;')
    expect(html).not.toContain('<b>')
  })

  it('is the same bytes for the same input, so a re-import is a no-op in content', () => {
    const input = { campaignName: 'X', creativeName: 'Y' }
    expect(placeholderZip(input).equals(placeholderZip(input))).toBe(true)
  })

  it('names the file after the creative and its size, in a form every platform takes', () => {
    expect(placeholderFilename('Swipe Card')).toBe('swipe-card-300x600.zip')
    expect(placeholderFilename('Überraschung / Ad')).toBe('uberraschung-ad-300x600.zip')
    expect(placeholderFilename('***')).toBe('creative-300x600.zip')
  })

  it('writes an empty archive correctly too', () => {
    expect(readZip(storedZip([]))).toEqual([])
  })
})
