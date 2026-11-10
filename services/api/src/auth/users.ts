import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type pg from 'pg';
import type { Scope } from './tokens.js';

/**
 * The people who can authorize applications: the web app's users (table web_users, migration
 * 004). The web app owns creating and managing them; the API only signs them in during the
 * authorization flow and re-checks them on every refresh.
 */
export interface DirectoryUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
  disabled: boolean;
  /** The tenant whose data tokens issued for this user act on (clients.id). */
  tenantId: string | null;
}

/** What a person may delegate, by role: the same least-privilege mapping as the web app's BFF. */
export const SCOPES_BY_ROLE: Record<DirectoryUser['role'], Scope[]> = {
  admin: ['documents:write', 'query'],
  user: ['query'],
};

export interface UserDirectory {
  /** The user if the password matches and the account is enabled, else null (same timing either way). */
  authenticate(email: string, password: string): Promise<DirectoryUser | null>;
  get(id: string): Promise<DirectoryUser | null>;
}

const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };
const COLUMNS = `id, email, name, role, disabled, tenant_id AS "tenantId"`;

export function createUserDirectory(pool: pg.Pool): UserDirectory {
  const dummyHash = hash(randomBytes(32).toString('base64url'), ARGON2);
  return {
    async authenticate(email, password) {
      const { rows } = await pool.query<DirectoryUser & { password_hash: string }>(
        `SELECT ${COLUMNS}, password_hash FROM web_users WHERE email = $1`,
        [email.trim().toLowerCase()],
      );
      const row = rows[0];
      // Unknown emails are verified against a dummy hash: "no such user" and "wrong password"
      // take the same time, so response timing doesn't reveal who has an account.
      const ok = await verify(row?.password_hash ?? (await dummyHash), password.slice(0, 256));
      if (!row || !ok || row.disabled) return null;
      const { password_hash: _h, ...user } = row;
      return user;
    },
    async get(id) {
      const { rows } = await pool.query<DirectoryUser>(`SELECT ${COLUMNS} FROM web_users WHERE id = $1`, [id]);
      return rows[0] ?? null;
    },
  };
}
