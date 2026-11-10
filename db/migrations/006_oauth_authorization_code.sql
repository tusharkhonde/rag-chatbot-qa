-- 006: OAuth 2.0 authorization code + PKCE, so a person (a web-app user) can grant an application
-- access on their behalf, plus rotating refresh tokens. See docs/adr/0010-authorization-code-pkce.md.

-- Client registration now distinguishes:
--  * confidential clients (have a secret; services; client_credentials) — every existing client
--  * public clients (no secret: CLIs, desktop and browser apps that can't keep one; PKCE instead)
ALTER TABLE clients
  ADD COLUMN client_type   text   NOT NULL DEFAULT 'confidential' CHECK (client_type IN ('confidential', 'public')),
  ADD COLUMN redirect_uris text[] NOT NULL DEFAULT '{}',
  ADD COLUMN grant_types   text[] NOT NULL DEFAULT '{client_credentials}'
    CHECK (grant_types <@ ARRAY['client_credentials', 'authorization_code', 'refresh_token']),
  ALTER COLUMN secret_hash DROP NOT NULL;

ALTER TABLE clients
  -- A public client has no secret, and a confidential one always has one.
  ADD CONSTRAINT clients_secret_matches_type CHECK ((client_type = 'public') = (secret_hash IS NULL)),
  -- client_credentials means "the client acts as itself", which needs a secret to prove it.
  ADD CONSTRAINT clients_public_no_client_credentials
    CHECK (client_type = 'confidential' OR NOT ('client_credentials' = ANY (grant_types))),
  -- The authorization code flow is useless (and unsafe) without exact, pre-registered redirect URIs.
  ADD CONSTRAINT clients_code_flow_needs_redirect
    CHECK (NOT ('authorization_code' = ANY (grant_types)) OR cardinality(redirect_uris) > 0);

-- Which tenant (organization) a person belongs to. Tokens issued on a user's behalf act on this
-- tenant's data, so row-level security and caching work unchanged. The web app links its users
-- to the tenant of its own API client.
ALTER TABLE web_users ADD COLUMN tenant_id uuid REFERENCES clients(id) ON DELETE SET NULL;

-- Refresh tokens are opaque random strings; only their SHA-256 is stored (like a password, but a
-- 256-bit random value needs no slow hash). Rotation: each use marks the token used and issues a
-- new one in the same family. Presenting a used token again means it was copied: the whole family
-- is revoked (RFC 9700 §4.14 refresh-token reuse detection).
CREATE TABLE oauth_refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL UNIQUE,
  family_id   uuid NOT NULL,
  client_id   uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES web_users(id) ON DELETE CASCADE,
  scope       text NOT NULL,
  resource    text,
  expires_at  timestamptz NOT NULL,  -- absolute: rotation never extends the family's lifetime
  used_at     timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_refresh_tokens_family_idx ON oauth_refresh_tokens (family_id);
