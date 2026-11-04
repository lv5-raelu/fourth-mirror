import { parseEnv } from 'node:util';

export function envValue(name, value) {
  // Node's .env grammar is not JSON; escaped quotation marks do not round-trip.
  for (const quote of ["'", '"', '`']) {
    const candidate = quote + value + quote;
    if (parseEnv('VALUE=' + candidate).VALUE === value) return candidate;
  }
  throw new Error(`Cannot copy ${name} into a .env file without changing its value. Keep it in the original file or configure it separately.`);
}
