import { readFileSync } from 'node:fs'

// The script a client's page loads with
//
//   <script async src="https://<service>/pages/tag.js" data-campaign="<app.campaign.id>"
//           data-language="de"></script>
//
// It lives in assets/tag.js as plain browser JavaScript, and is read once, at import time, like the
// SQL files: a missing file fails the boot. The build copies assets/ next to the compiled module
// (scripts/copy-sql.ts). What it does is tested by running these exact bytes against a fake window
// (tests/unit/tracking-tag.test.ts).
//
// On every page load it posts a visit with the page's utm_ and brame_ parameters and the referrer.
// It keeps the values the visitor arrived with in sessionStorage (the tab's own storage, gone when
// the tab closes), and brame.conversion() posts a conversion with them, so a conversion on a later
// page lands on the row of the visit that brought the visitor. Nothing else is stored, and nothing
// identifies the visitor.

export const TAG_SCRIPT = readFileSync(new URL('./assets/tag.js', import.meta.url), 'utf8')
