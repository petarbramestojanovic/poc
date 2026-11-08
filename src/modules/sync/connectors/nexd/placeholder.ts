// The placeholder creative provisioning imports for every creative type: the smallest HTML5 banner
// NEXD's import accepts (support.nexd.com, "Import HTML5 banners"): index.html and manifest.json
// at the root of the zip, the manifest naming source, width and height, the ad.size meta tag, a
// clickTag opened through JavaScript, one block root node of the ad's size. Another application
// replaces it with the real creative later; the live id stays.
//
// The zip is built here, stored (no compression), so the repo ships no binary and the build copies
// nothing: a zip is a sequence of local headers + data, a central directory and an end record.

export const PLACEHOLDER_WIDTH = 300
export const PLACEHOLDER_HEIGHT = 600

export interface PlaceholderInput {
  /** Shown inside the banner, so a person looking at NEXD sees which creative this is. */
  campaignName: string
  creativeName: string
}

export function placeholderIndexHtml(input: PlaceholderInput): string {
  const title = escapeHtml(`${input.campaignName} · ${input.creativeName}`)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="ad.size" content="width=${PLACEHOLDER_WIDTH},height=${PLACEHOLDER_HEIGHT}">
<title>${title}</title>
<script>var clickTag = "https://www.brame.io/";</script>
<style>
html, body { margin: 0; padding: 0; }
#ad { width: ${PLACEHOLDER_WIDTH}px; height: ${PLACEHOLDER_HEIGHT}px; display: block; overflow: hidden;
      background: #1c2024; color: #f6f5f0; font: 14px/1.4 Helvetica, Arial, sans-serif; }
#ad a { display: block; width: 100%; height: 100%; color: inherit; text-decoration: none; }
#ad span { display: block; padding: 24px 20px; }
</style>
</head>
<body>
<div id="ad"><a href="javascript:void(window.open(clickTag))"><span>Placeholder<br>${title}</span></a></div>
</body>
</html>
`
}

export function placeholderManifest(): string {
  return `${JSON.stringify({ width: PLACEHOLDER_WIDTH, height: PLACEHOLDER_HEIGHT, source: 'index.html' })}\n`
}

/** The zip NEXD imports, as bytes. Deterministic for one input (fixed timestamp). */
export function placeholderZip(input: PlaceholderInput): Buffer {
  return storedZip([
    { name: 'index.html', data: Buffer.from(placeholderIndexHtml(input), 'utf8') },
    { name: 'manifest.json', data: Buffer.from(placeholderManifest(), 'utf8') },
  ])
}

export function placeholderFilename(creativeName: string): string {
  const slug =
    creativeName
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'creative'
  return `${slug}-${PLACEHOLDER_WIDTH}x${PLACEHOLDER_HEIGHT}.zip`
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

// --- a stored zip -------------------------------------------------------------------------------

export interface ZipEntry {
  name: string
  data: Buffer
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** MS-DOS date/time fields: 2026-01-01 00:00, fixed so one input always gives one zip. */
const DOS_TIME = 0
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1

export function storedZip(entries: readonly ZipEntry[]): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header
    local.writeUInt16LE(20, 4) // version needed: 2.0
    local.writeUInt16LE(0x0800, 6) // flags: UTF-8 names
    local.writeUInt16LE(0, 8) // method: stored
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    parts.push(local, name, entry.data)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0) // central directory header
    header.writeUInt16LE(20, 4) // made by
    header.writeUInt16LE(20, 6) // needed
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(DOS_TIME, 12)
    header.writeUInt16LE(DOS_DATE, 14)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(entry.data.length, 20)
    header.writeUInt32LE(entry.data.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt16LE(0, 30) // extra
    header.writeUInt16LE(0, 32) // comment
    header.writeUInt16LE(0, 34) // disk
    header.writeUInt16LE(0, 36) // internal attributes
    header.writeUInt32LE(0, 38) // external attributes
    header.writeUInt32LE(offset, 42)
    central.push(header, name)

    offset += local.length + name.length + entry.data.length
  }

  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // end of central directory
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...parts, directory, end])
}
