import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type pg from 'pg';

export type Role = 'admin' | 'user';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export class DuplicateEmailError extends Error {}
export class WeakPasswordError extends Error {}

const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

/**
 * NIST SP 800-63B: length matters, composition rules ("one symbol, one digit") don't; they push
 * people toward predictable patterns. So: minimum 12 characters, maximum 256 (argon2 input bound).
 */
export function checkPassword(password: string) {
  if (password.length < 12) throw new WeakPasswordError('Password must be at least 12 characters');
  if (password.length > 256) throw new WeakPasswordError('Password must be at most 256 characters');
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const generatePassword = () => randomBytes(18).toString('base64url'); // 144 bits

export interface UserStore {
  count(): Promise<number>;
  create(input: { email: string; name: string; password: string; role: Role }): Promise<User>;
  /** Returns the user only if the password matches and the account is enabled. */
  authenticate(email: string, password: string): Promise<User | null>;
  get(id: string): Promise<User | null>;
  list(): Promise<User[]>;
  setDisabled(id: string, disabled: boolean): Promise<User | null>;
}

const COLUMNS = `id, email, name, role, disabled, created_at AS "createdAt", last_login_at AS "lastLoginAt"`;

export function createUserStore(pool: pg.Pool): UserStore {
  // Verified against for unknown emails so "no such user" and "wrong password" take equal time.
  const dummyHash = hash(randomBytes(32).toString('base64url'), ARGON2);

  return {
    async count() {
      const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM web_users');
      return rows[0]!.n;
    },

    async create({ email, name, password, role }) {
      checkPassword(password);
      try {
        const { rows } = await pool.query<User>(
          `INSERT INTO web_users (email, name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
          [normalizeEmail(email), name.trim(), await hash(password, ARGON2), role],
        );
        return rows[0]!;
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new DuplicateEmailError('A user with this email already exists');
        throw err;
      }
    },

    async authenticate(email, password) {
      const { rows } = await pool.query<User & { password_hash: string }>(
        `SELECT ${COLUMNS}, password_hash FROM web_users WHERE email = $1`,
        [normalizeEmail(email)],
      );
      const row = rows[0];
      const ok = await verify(row?.password_hash ?? (await dummyHash), password);
      if (!row || !ok || row.disabled) return null;
      await pool.query('UPDATE web_users SET last_login_at = now() WHERE id = $1', [row.id]);
      const { password_hash: _h, ...user } = row;
      return user;
    },

    async get(id) {
      const { rows } = await pool.query<User>(`SELECT ${COLUMNS} FROM web_users WHERE id = $1`, [id]);
      return rows[0] ?? null;
    },

    async list() {
      const { rows } = await pool.query<User>(`SELECT ${COLUMNS} FROM web_users ORDER BY created_at`);
      return rows;
    },

    async setDisabled(id, disabled) {
      const { rows } = await pool.query<User>(`UPDATE web_users SET disabled = $2 WHERE id = $1 RETURNING ${COLUMNS}`, [id, disabled]);
      return rows[0] ?? null;
    },
  };
}
