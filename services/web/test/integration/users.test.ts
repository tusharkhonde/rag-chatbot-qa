import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createUserStore, DuplicateEmailError, WeakPasswordError } from '../../server/src/users.js';

// Requires the compose Postgres with migrations applied (the API applies 004_web_users on start).
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgresql://rag:rag@localhost:5432/rag' });
const users = createUserStore(pool);
const email = `it-${Date.now()}@Example.com`;

afterAll(async () => {
  await pool.query('DELETE FROM web_users WHERE email = $1', [email.toLowerCase()]);
  await pool.end();
});

describe('user store (Postgres)', () => {
  it('stores an argon2id hash and a normalized email, and authenticates case-insensitively', async () => {
    const user = await users.create({ email, name: 'Test', password: 'a long enough password', role: 'user' });
    expect(user.email).toBe(email.toLowerCase());
    const { rows } = await pool.query('SELECT password_hash FROM web_users WHERE id = $1', [user.id]);
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(await users.authenticate(email.toUpperCase(), 'a long enough password')).toMatchObject({ id: user.id });
    expect(await users.authenticate(email, 'wrong password!!')).toBeNull();
  });

  it('rejects duplicate emails (even differing in case) and short passwords', async () => {
    await expect(users.create({ email: email.toUpperCase(), name: 'Dup', password: 'a long enough password', role: 'user' })).rejects.toBeInstanceOf(DuplicateEmailError);
    await expect(users.create({ email: 'x@example.com', name: 'X', password: 'short', role: 'user' })).rejects.toBeInstanceOf(WeakPasswordError);
  });

  it('refuses to authenticate a disabled account', async () => {
    const [user] = (await users.list()).filter((u) => u.email === email.toLowerCase());
    await users.setDisabled(user!.id, true);
    expect(await users.authenticate(email, 'a long enough password')).toBeNull();
  });

  it('setPassword replaces the hash under the same policy', async () => {
    const user = (await users.findByEmail(email))!;
    await users.setDisabled(user.id, false);
    await users.setPassword(user.id, 'a brand new passphrase');
    expect(await users.authenticate(email, 'a long enough password')).toBeNull();
    expect(await users.authenticate(email, 'a brand new passphrase')).toMatchObject({ id: user.id });
    await expect(users.setPassword(user.id, 'short')).rejects.toBeInstanceOf(WeakPasswordError);
  });
});

describe('tenant linking (authorization code flow)', () => {
  it('links new users to the tenant of the given API client, and backfills unlinked ones', async () => {
    const clientId = `it-web-${Date.now()}`;
    const { rows: [client] } = await pool.query(`INSERT INTO clients (client_id, secret_hash, name) VALUES ($1, 'x', 'web it') RETURNING id`, [clientId]);
    const linkedEmail = `linked-${Date.now()}@example.com`;
    const orphanEmail = `orphan-${Date.now()}@example.com`;
    try {
      const linked = await createUserStore(pool, { tenantClientId: clientId }).create({ email: linkedEmail, name: 'L', password: 'a long enough password', role: 'user' });
      const orphan = await users.create({ email: orphanEmail, name: 'O', password: 'a long enough password', role: 'user' });
      const tenantOf = async (id: string) => (await pool.query('SELECT tenant_id FROM web_users WHERE id = $1', [id])).rows[0].tenant_id;
      expect(await tenantOf(linked.id)).toBe(client.id);
      expect(await tenantOf(orphan.id)).toBeNull();

      expect(await users.linkTenant(clientId)).toBeGreaterThanOrEqual(1);
      expect(await tenantOf(orphan.id)).toBe(client.id);
      expect(await users.linkTenant('no-such-client')).toBe(0);
    } finally {
      await pool.query('DELETE FROM web_users WHERE email = ANY($1)', [[linkedEmail, orphanEmail]]);
      await pool.query('DELETE FROM clients WHERE id = $1', [client.id]);
    }
  });
});
