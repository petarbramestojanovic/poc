import { cpSync, statSync } from 'node:fs'

// tsc emits only TypeScript; the .sql files loaded by src/sql-file.ts are copied alongside.
cpSync('src', 'dist', {
  recursive: true,
  filter: (source) => statSync(source).isDirectory() || source.endsWith('.sql'),
})
