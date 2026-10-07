// Imports the built modules that load SQL at import time. A missing or un-copied .sql file, or a
// broken emit, fails here — in CI — instead of at the first nightly run.
const modules = [
  'app.js',
  'sync/engine.js',
  'sync/connectors/nexd/connector.js',
  'sync/connectors/zeus/connector.js',
  'sync/nightly.js',
  'runtime.js',
  'cli/sync-commands.js',
  'sync/scheduler.js',
  'routes/sync.js',
  'webhooks/scheduler.js',
  'routes/webhooks.js',
  'routes/campaigns.js',
  'routes/inbound.js',
  'webhooks/admin.js',
  'webhooks/build.js',
  'webhooks/fields.js',
]
for (const module of modules) {
  await import(new URL(`../dist/${module}`, import.meta.url).href)
}
process.stdout.write(`build smoke: ${modules.length} modules imported\n`)
