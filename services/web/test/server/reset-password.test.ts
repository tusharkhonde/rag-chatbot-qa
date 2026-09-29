import { describe, expect, it } from 'vitest';
import { resetPassword } from '../../server/src/cli/reset-password.js';
import { createSessionStore, memoryKV } from '../../server/src/sessions.js';
import { fakeUsers } from './helpers.js';

describe('reset-password (break-glass CLI)', () => {
  it('sets a new generated password and signs the user out everywhere', async () => {
    const users = fakeUsers();
    const sessions = createSessionStore(memoryKV(), { idleSeconds: 60, absoluteSeconds: 600 });
    const admin = users.all[0]!;
    const { sid } = await sessions.create(admin.id, 'admin');

    const result = await resetPassword(users, sessions, { email: 'ADMIN@example.com' });

    expect(result.generated).toBe(true);
    expect(result.password).toMatch(/^[\w-]{24}$/);
    expect(await users.authenticate('admin@example.com', 'correct horse battery')).toBeNull(); // old password
    expect(await users.authenticate('admin@example.com', result.password)).not.toBeNull();
    expect(await sessions.get(sid)).toBeNull(); // existing session revoked
  });

  it('can re-enable a disabled account and use a chosen password', async () => {
    const users = fakeUsers();
    const sessions = createSessionStore(memoryKV(), { idleSeconds: 60, absoluteSeconds: 600 });
    await users.setDisabled(users.all[1]!.id, true);
    const result = await resetPassword(users, sessions, { email: 'user@example.com', password: 'my new long password', enable: true });
    expect(result.generated).toBe(false);
    expect(await users.authenticate('user@example.com', 'my new long password')).not.toBeNull();
  });

  it('fails clearly for an unknown email', async () => {
    const sessions = createSessionStore(memoryKV(), { idleSeconds: 60, absoluteSeconds: 600 });
    await expect(resetPassword(fakeUsers(), sessions, { email: 'ghost@example.com' })).rejects.toThrow('No user with email ghost@example.com');
  });
});
