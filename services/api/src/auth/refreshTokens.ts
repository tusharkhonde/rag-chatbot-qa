import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';

/**
 * Rotating refresh tokens (migration 006).
 *
 * Access tokens stay short-lived JWTs (15 minutes, verified without a database lookup). A refresh
 * token lets a client get a new one without sending the user through the browser again. It is
 * opaque, single-use and stored only as a SHA-256 hash. Every use returns a new refresh token in
 * the same *family* and marks the old one used. If a used token is ever presented again, two
 * parties hold copies, one of them an attacker, and we can't tell which: the whole family is
 * revoked (RFC 9700 §4.14.2), so both must sign in again.
 */

export interface RefreshGrant {
  clientId: string; // internal id of the client the token was issued to
  userId: string;
  scope: string;
  resource: string | null;
}

export type RotateResult =
  | { ok: true; grant: RefreshGrant; refreshToken: string }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'reused' | 'wrong_client' };

export interface RefreshTokenStore {
  /** Start a new family (after an authorization code exchange). */
  issue(grant: RefreshGrant, ttlSeconds: number): Promise<string>;
  /** Spend `token` and return its replacement, or why it can't be used. */
  rotate(token: string, clientId: string): Promise<RotateResult>;
  /** RFC 7009 revocation: revokes the token's whole family. Unknown tokens are ignored. */
  revoke(token: string, clientId: string): Promise<void>;
  /** Called when the user behind a family is no longer allowed (e.g. disabled). */
  revokeFamilyOf(token: string): Promise<void>;
}

const sha256 = (token: string) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url'); // 256 bits

export function createRefreshTokenStore(pool: pg.Pool): RefreshTokenStore {
  async function insert(db: pg.Pool | pg.PoolClient, grant: RefreshGrant, familyId: string, expiresAt: Date | string) {
    const token = newToken();
    await db.query(
      `INSERT INTO oauth_refresh_tokens (token_hash, family_id, client_id, user_id, scope, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sha256(token), familyId, grant.clientId, grant.userId, grant.scope, grant.resource, expiresAt],
    );
    return token;
  }

  const revokeFamily = (db: pg.Pool | pg.PoolClient, familyId: string) =>
    db.query('UPDATE oauth_refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [familyId]);

  return {
    issue: (grant, ttlSeconds) => insert(pool, grant, randomUUID(), new Date(Date.now() + ttlSeconds * 1000)),

    async rotate(token, clientId) {
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        // Row lock: two concurrent refreshes with the same token serialize here, and the second
        // one sees used_at set (and is treated as reuse).
        const { rows } = await db.query(
          `SELECT id, family_id, client_id, user_id, scope, resource, expires_at, used_at, revoked_at,
                  expires_at <= now() AS expired
             FROM oauth_refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
          [sha256(token)],
        );
        const row = rows[0];
        let result: RotateResult;
        if (!row) result = { ok: false, reason: 'unknown' };
        else if (row.client_id !== clientId) result = { ok: false, reason: 'wrong_client' };
        else if (row.revoked_at) result = { ok: false, reason: 'revoked' };
        else if (row.used_at) {
          await revokeFamily(db, row.family_id);
          result = { ok: false, reason: 'reused' };
        } else if (row.expired) result = { ok: false, reason: 'expired' };
        else {
          await db.query('UPDATE oauth_refresh_tokens SET used_at = now() WHERE id = $1', [row.id]);
          const grant: RefreshGrant = { clientId: row.client_id, userId: row.user_id, scope: row.scope, resource: row.resource };
          // Same family, same absolute expiry: rotation never extends how long a sign-in lasts.
          result = { ok: true, grant, refreshToken: await insert(db, grant, row.family_id, row.expires_at) };
        }
        await db.query('COMMIT');
        return result;
      } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        db.release();
      }
    },

    async revoke(token, clientId) {
      const { rows } = await pool.query('SELECT family_id, client_id FROM oauth_refresh_tokens WHERE token_hash = $1', [sha256(token)]);
      // A client may only revoke its own tokens; anything else is silently ignored (RFC 7009 §2.2).
      if (rows[0] && rows[0].client_id === clientId) await revokeFamily(pool, rows[0].family_id);
    },

    async revokeFamilyOf(token) {
      const { rows } = await pool.query('SELECT family_id FROM oauth_refresh_tokens WHERE token_hash = $1', [sha256(token)]);
      if (rows[0]) await revokeFamily(pool, rows[0].family_id);
    },
  };
}
