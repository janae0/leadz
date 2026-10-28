import { migrate } from "./db/migrate.js";
import { seedTemplates } from "./draft/templates.js";
import { seedSequence } from "./send/sequence.js";

// Applies migrations and seeds the default templates and sequence. Safe to run
// on every start.
export async function bootstrap(): Promise<string[]> {
  const ran = await migrate();
  await seedTemplates();
  await seedSequence();
  return ran;
}
