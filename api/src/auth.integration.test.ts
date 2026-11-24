import assert from 'node:assert/strict';
import { Pool } from 'pg';
import test from 'node:test';
import { authenticate, createUser, login, logout, setActive, setPassword, setUsername } from './auth.js';
import { initializeDatabase } from './database.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test('panel login: hashed password, session lifecycle, lockout and revocation', {
  skip: testDatabaseUrl ? false : 'Set TEST_DATABASE_URL to an isolated PostgreSQL test database.',
}, async () => {
  if (!testDatabaseUrl || !decodeURIComponent(new URL(testDatabaseUrl).pathname).toLowerCase().includes('test')) return;
  const db = new Pool({ connectionString: testDatabaseUrl });
  const context = { remoteAddr: '198.51.100.9', userAgent: 'test' };
  try {
    await initializeDatabase(db);
    await db.query(`DELETE FROM app_users WHERE email LIKE '%@auth.test'`);
    await db.query(`DELETE FROM auth_log WHERE email LIKE '%@auth.test' OR remote_addr = $1`, [context.remoteAddr]);
    await createUser(db, { email: 'Gestor@Auth.test', name: 'Gestor', role: 'gestor', password: 'senha-forte-1' });

    const stored = await db.query<{ password_hash: string }>(`SELECT password_hash FROM app_users WHERE email = 'gestor@auth.test'`);
    assert.match(stored.rows[0].password_hash, /^scrypt\$/);
    assert.equal(stored.rows[0].password_hash.includes('senha-forte-1'), false);

    const ok = await login(db, ' GESTOR@auth.test ', 'senha-forte-1', context);
    assert.equal(ok.ok, true);
    if (!ok.ok) return;
    assert.equal(ok.user.role, 'gestor');
    const sessionRow = await db.query(`SELECT 1 FROM user_sessions WHERE token_hash = $1`, [ok.token]);
    assert.equal(sessionRow.rowCount, 0, 'only the token hash is stored');
    assert.equal((await authenticate(db, ok.token))?.email, 'gestor@auth.test');

    await logout(db, ok.token, context.remoteAddr);
    assert.equal(await authenticate(db, ok.token), undefined);

    for (let i = 0; i < 5; i += 1) {
      assert.deepEqual(await login(db, 'gestor@auth.test', 'errada', context), { ok: false, reason: 'invalid' });
    }
    assert.deepEqual(await login(db, 'gestor@auth.test', 'senha-forte-1', context), { ok: false, reason: 'locked' });

    await db.query(`DELETE FROM auth_log WHERE email = 'gestor@auth.test'`);
    const again = await login(db, 'gestor@auth.test', 'senha-forte-1', context);
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(await setPassword(db, 'gestor@auth.test', 'nova-senha-2'), true);
    assert.equal(await authenticate(db, again.token), undefined, 'password reset revokes sessions');

    const third = await login(db, 'gestor@auth.test', 'nova-senha-2', context);
    assert.equal(third.ok, true);
    await setActive(db, 'gestor@auth.test', false);
    if (third.ok) assert.equal(await authenticate(db, third.token), undefined, 'disabling revokes sessions');
    assert.deepEqual(await login(db, 'gestor@auth.test', 'nova-senha-2', context), { ok: false, reason: 'invalid' });

    const events = await db.query<{ event: string }>(`SELECT event FROM auth_log WHERE email = 'gestor@auth.test' ORDER BY id`);
    assert.deepEqual(events.rows.map((r) => r.event), ['login_ok', 'login_ok', 'login_failed']);
  } finally {
    await db.query(`DELETE FROM app_users WHERE email LIKE '%@auth.test'`).catch(() => {});
    await db.end();
  }
});

test('panel login accepts username or e-mail and rejects short passwords', {
  skip: testDatabaseUrl ? false : 'Set TEST_DATABASE_URL to an isolated PostgreSQL test database.',
}, async () => {
  if (!testDatabaseUrl || !decodeURIComponent(new URL(testDatabaseUrl).pathname).toLowerCase().includes('test')) return;
  const db = new Pool({ connectionString: testDatabaseUrl });
  const context = { remoteAddr: '198.51.100.10', userAgent: 'test' };
  try {
    await initializeDatabase(db);
    await db.query(`DELETE FROM app_users WHERE email LIKE '%@user.test'`);
    await db.query(`DELETE FROM auth_log WHERE remote_addr = $1`, [context.remoteAddr]);
    await assert.rejects(createUser(db, { email: 'curta@user.test', name: 'X', role: 'admin', password: 'adm' }), /10/);
    await createUser(db, { email: 'adm@user.test', name: 'Adm', role: 'admin', password: 'senha-forte-1', username: 'Adm.Test' });

    const byUser = await login(db, ' ADM.test ', 'senha-forte-1', context);
    assert.equal(byUser.ok && byUser.user.email, 'adm@user.test');
    assert.equal((await login(db, 'adm@user.test', 'senha-forte-1', context)).ok, true);
    assert.deepEqual(await login(db, 'adm.test', 'errada', context), { ok: false, reason: 'invalid' });

    assert.equal(await setPassword(db, 'adm.test', 'outra-senha-3'), true);
    assert.equal((await login(db, 'adm.test', 'outra-senha-3', context)).ok, true);
    assert.equal(await setUsername(db, 'adm@user.test', 'adm2.test'), true);
    assert.equal((await login(db, 'adm2.test', 'outra-senha-3', context)).ok, true);
    await assert.rejects(setUsername(db, 'adm@user.test', 'a@b'), /Usuário/);
  } finally {
    await db.query(`DELETE FROM app_users WHERE email LIKE '%@user.test'`).catch(() => {});
    await db.end();
  }
});
