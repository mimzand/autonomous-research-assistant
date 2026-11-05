import { defineConfig } from 'drizzle-kit';

/** Used only by `pnpm --filter @rka/storage db:generate` to write SQL migrations. */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
