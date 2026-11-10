/**
 * Create a web user. Prints a generated password if none is given.
 *   docker compose exec web node dist/server/cli/create-user.js --email ana@example.com --name Ana --role user
 */
import { parseArgs } from 'node:util';
import pg from 'pg';
import { loadConfig } from '../config.js';
import { createUserStore, generatePassword, type Role } from '../users.js';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string', default: 'user' },
    password: { type: 'string' },
  },
});
if (!values.email || !values.name || !['admin', 'user'].includes(values.role!)) {
  console.error('usage: create-user --email <email> --name <name> [--role admin|user] [--password <pw>]');
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const password = values.password ?? generatePassword();
// Inside the web container the BFF's credentials are available: link the user to its tenant now.
// Elsewhere the user is linked the next time the web app starts.
let tenantClientId: string | undefined;
try {
  tenantClientId = loadConfig().ragClientId;
} catch {
  tenantClientId = undefined;
}
const user = await createUserStore(pool, { tenantClientId }).create({ email: values.email, name: values.name, password, role: values.role as Role });
await pool.end();
console.log(`created ${user.role} ${user.email}${values.password ? '' : `\npassword: ${password}`}`);
