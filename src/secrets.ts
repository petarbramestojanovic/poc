// external.credential.secret_env_var is a pointer to an environment variable; this is the
// only place that dereferences it. Secret values never enter the database or the logs.

export class MissingSecretError extends Error {
  override readonly name = 'MissingSecretError'
  readonly envVar: string
  constructor(envVar: string) {
    super(`Environment variable ${envVar} is not set`)
    this.envVar = envVar
  }
}

export function resolveSecret(envVar: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[envVar]
  if (value === undefined || value === '') throw new MissingSecretError(envVar)
  return value
}
