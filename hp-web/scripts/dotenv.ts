// Next loads .env/.env.local into the server automatically; tsx scripts get
// nothing, which was fine while the only knob was DATABASE_URL (always passed
// on the command line) but not for the blob-store settings that live beside
// the app. Mirror Next's behavior: .env first, .env.local on top — though as
// process.loadEnvFile never overrides what's already set, variables from the
// environment win over both, and precedence between the files means "first
// load wins" here, so .env.local is loaded first.

export function loadDotEnv(): void {
  for (const f of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(f);
    } catch {
      // no such file — nothing to load
    }
  }
}
