import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type pg from 'pg';
import type { Principal, Scope } from './tokens.js';

// OWASP-recommended argon2id floor: 19 MiB memory, 2 iterations. Memory-hard hashing makes
// offline brute force of a leaked secret_hash column expensive on GPUs/ASICs.
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export type GrantType = 'client_credentials' | 'authorization_code' | 'refresh_token';

/** A client's registration, as the authorization endpoint needs it. */
export interface ClientRegistration {
  id: string; // internal id (clients.id)
  clientId: string; // public client_id
  name: string;
  type: 'confidential' | 'public';
  redirectUris: string[];
  grantTypes: GrantType[];
  scopes: Scope[];
}

export interface CreateClientOptions {
  /** public = no secret (CLIs, desktop and browser apps); authenticates with PKCE instead. */
  type?: 'confidential' | 'public';
  redirectUris?: string[];
  grantTypes?: GrantType[];
}

export interface ClientStore {
  /** clientSecret is null for public clients. */
  create(name: string, scopes: Scope[], opts?: CreateClientOptions): Promise<{ clientId: string; clientSecret: string | null }>;
  /** client_credentials authentication: confidential clients allowed that grant only. */
  authenticate(clientId: string, clientSecret: string): Promise<Principal | null>;
  /** Verify a confidential client's secret for any grant; returns its registration. */
  authenticateRegistration(clientId: string, clientSecret: string): Promise<ClientRegistration | null>;
  get(clientId: string): Promise<ClientRegistration | null>;
}

const REGISTRATION = `id, client_id AS "clientId", name, client_type AS type, redirect_uris AS "redirectUris",
                      grant_types AS "grantTypes", scopes`;

// Note: runs as the connecting (owner) role, not under tenant RLS: authentication happens
// before we know the tenant, and rag_app deliberately has no access to this table.
export function createClientStore(pool: pg.Pool): ClientStore {
  // Verified against when the client_id doesn't exist, so "unknown client" and "wrong secret"
  // take the same time. Otherwise response timing reveals which client_ids are real.
  const dummyHash = hash(randomBytes(32).toString('base64url'), ARGON2);

  async function authenticateRegistration(clientId: string, clientSecret: string) {
    const { rows } = await pool.query<ClientRegistration & { secret_hash: string | null }>(
      `SELECT ${REGISTRATION}, secret_hash FROM clients WHERE client_id = $1`,
      [clientId],
    );
    const row = rows[0];
    // Public clients have no secret: verifying against the dummy hash fails them in the same time.
    // argon2 verify is constant-time in the comparison itself.
    const ok = await verify(row?.secret_hash ?? (await dummyHash), clientSecret);
    if (!row || !ok || row.type !== 'confidential') return null;
    const { secret_hash: _h, ...registration } = row;
    return registration;
  }

  return {
    async create(name, scopes, opts = {}) {
      const type = opts.type ?? 'confidential';
      const clientId = `rag_${randomBytes(9).toString('base64url')}`;
      const clientSecret = type === 'confidential' ? randomBytes(32).toString('base64url') : null; // 256 bits
      await pool.query(
        `INSERT INTO clients (client_id, secret_hash, name, scopes, client_type, redirect_uris, grant_types)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          clientId,
          clientSecret ? await hash(clientSecret, ARGON2) : null,
          name,
          scopes,
          type,
          opts.redirectUris ?? [],
          opts.grantTypes ?? (type === 'public' ? ['authorization_code', 'refresh_token'] : ['client_credentials']),
        ],
      );
      return { clientId, clientSecret }; // the secret is shown once and never stored in plaintext
    },

    async authenticate(clientId, clientSecret) {
      const row = await authenticateRegistration(clientId, clientSecret);
      if (!row || !row.grantTypes.includes('client_credentials')) return null;
      // The client acts as itself: it is the tenant.
      return { clientId: row.id, publicClientId: clientId, scopes: row.scopes };
    },

    authenticateRegistration,

    async get(clientId) {
      const { rows } = await pool.query<ClientRegistration>(`SELECT ${REGISTRATION} FROM clients WHERE client_id = $1`, [clientId]);
      return rows[0] ?? null;
    },
  };
}
