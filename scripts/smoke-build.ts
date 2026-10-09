// Imports the built modules that load SQL at import time. A missing or un-copied .sql file, or a
// broken emit, fails here — in CI — instead of at the first nightly run.
const modules = [
  'app.js',
  'modules/sync/engine.js',
  'modules/sync/connectors/nexd/connector.js',
  'modules/sync/connectors/zeus/connector.js',
  'modules/sync/nightly.js',
  'runtime.js',
  'cli/sync-commands.js',
  'modules/sync/scheduler.js',
  'modules/sync/routes.js',
  'modules/webhooks/scheduler.js',
  'modules/webhooks/routes.js',
  'modules/campaigns/routes.js',
  'modules/companies/routes.js',
  'modules/salesforce/routes.js',
  'modules/webhooks/admin.js',
  'modules/webhooks/build.js',
  'modules/webhooks/fields.js',
]
for (const module of modules) {
  await import(new URL(`../dist/${module}`, import.meta.url).href)
}
process.stdout.write(`build smoke: ${modules.length} modules imported\n`)
