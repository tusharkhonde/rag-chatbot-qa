-- 004: human users of the web app (owned by the web BFF, services/web).
-- Machine clients (API consumers) stay in `clients`; people log in to the web app and the BFF
-- calls the API on their behalf with its own client credentials, down-scoped by role.
-- The RLS role rag_app gets no privileges here, so tenant-scoped code can't read password hashes.
CREATE TABLE web_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),  -- normalized: no case-variant duplicates
  name          text NOT NULL,
  password_hash text NOT NULL,                                      -- argon2id
  role          text NOT NULL CHECK (role IN ('admin', 'user')),
  disabled      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
