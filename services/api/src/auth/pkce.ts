import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * PKCE (RFC 7636). The client invents a random `code_verifier`, sends only its hash
 * (`code_challenge`) with the authorization request, and reveals the verifier when it redeems the
 * code. Someone who intercepts the code (a malicious app registered for the same redirect scheme,
 * a proxy log, browser history) can't redeem it without the verifier, which never left the client.
 *
 * Only S256 is accepted: with `plain`, the challenge IS the verifier, so it protects nothing
 * against anyone who can see the authorization request.
 */

// RFC 7636 §4.1: 43–128 characters from the unreserved set.
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
// base64url(SHA-256) is always 43 characters without padding.
const CHALLENGE = /^[A-Za-z0-9\-_]{43}$/;

export const isValidChallenge = (challenge: string) => CHALLENGE.test(challenge);

export const s256 = (verifier: string) => createHash('sha256').update(verifier, 'ascii').digest('base64url');

export function verifyPkce(verifier: string | undefined, challenge: string): boolean {
  if (!verifier || !VERIFIER.test(verifier)) return false;
  const expected = Buffer.from(challenge);
  const actual = Buffer.from(s256(verifier));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
