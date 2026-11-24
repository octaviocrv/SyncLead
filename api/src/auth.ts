import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { Pool } from 'pg';

export type UserRole = 'admin' | 'gestor';

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: UserRole;
}

export const sessionCookieName = 'sl_session';
export const sessionMaxAgeSeconds = 12 * 60 * 60;
const sessionIdleMinutes = 120;
const failureWindowMinutes = 15;
const maxFailuresPerEmail = 5;
const maxFailuresPerAddress = 20;

const scryptParams = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, scryptParams);
  return `scrypt$${scryptParams.N}$${scryptParams.r}$${scryptParams.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: scryptParams.maxmem,
  });
  return timingSafeEqual(key, expected);
}

// Usado quando o e-mail não existe, para o tempo de resposta não revelar quais contas existem.
let dummyHash: Promise<string> | undefined;

export function generatePassword(): string {
  return randomBytes(15).toString('base64url');
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const normalizeEmail = (email: string) => email.trim().toLowerCase();
const normalizeLogin = normalizeEmail;

export const minPasswordLength = 10;
const usernamePattern = /^[a-z0-9._-]{3,40}$/;

export function validateUsername(raw: string): string {
  const username = raw.trim().toLowerCase();
  if (!usernamePattern.test(username)) throw new Error('Usuário deve ter 3 a 40 caracteres: letras, números, ponto, hífen ou _.');
  return username;
}

export function validatePassword(password: string): void {
  if (password.length < minPasswordLength || password.length > 200) {
    throw new Error(`A senha deve ter entre ${minPasswordLength} e 200 caracteres.`);
  }
}

export type LoginResult =
  | { ok: true; token: string; user: SessionUser }
  | { ok: false; reason: 'invalid' | 'locked' };

export async function login(
  pool: Pool,
  rawLogin: string,
  password: string,
  context: { remoteAddr: string | null; userAgent: string | null },
): Promise<LoginResult> {
  // Aceita e-mail ou nome de usuário; o identificador digitado vai para auth_log.email.
  const email = normalizeLogin(rawLogin).slice(0, 254);
  const failures = await pool.query<{ by_email: string; by_addr: string }>(
    `SELECT COUNT(*) FILTER (WHERE email = $1) AS by_email,
            COUNT(*) FILTER (WHERE remote_addr = $2) AS by_addr
     FROM auth_log
     WHERE event = 'login_failed' AND created_at > NOW() - make_interval(mins => $3)`,
    [email, context.remoteAddr, failureWindowMinutes],
  );
  const log = (event: string, userId: number | null) => pool.query(
    `INSERT INTO auth_log (user_id, email, event, remote_addr, user_agent) VALUES ($1, $2, $3, $4, $5)`,
    [userId, email, event, context.remoteAddr, context.userAgent?.slice(0, 300) ?? null],
  );

  if (Number(failures.rows[0].by_email) >= maxFailuresPerEmail || Number(failures.rows[0].by_addr) >= maxFailuresPerAddress) {
    await log('login_locked', null);
    return { ok: false, reason: 'locked' };
  }

  const result = await pool.query<SessionUser & { password_hash: string }>(
    `SELECT id::int, email, name, role, password_hash FROM app_users WHERE (email = $1 OR username = $1) AND active`,
    [email],
  );
  const row = result.rows[0];
  dummyHash ??= hashPassword(generatePassword());
  const valid = await verifyPassword(password, row?.password_hash ?? (await dummyHash));
  if (!row || !valid) {
    await log('login_failed', row?.id ?? null);
    return { ok: false, reason: 'invalid' };
  }

  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, expires_at, remote_addr, user_agent)
     VALUES ($1, $2, NOW() + make_interval(secs => $3), $4, $5)`,
    [hashToken(token), row.id, sessionMaxAgeSeconds, context.remoteAddr, context.userAgent?.slice(0, 300) ?? null],
  );
  await pool.query(`UPDATE app_users SET last_login_at = NOW() WHERE id = $1`, [row.id]);
  await log('login_ok', row.id);
  return { ok: true, token, user: { id: row.id, email: row.email, name: row.name, role: row.role } };
}

export async function authenticate(pool: Pool, token: string | undefined): Promise<SessionUser | undefined> {
  if (!token || token.length > 100) return undefined;
  const result = await pool.query<SessionUser>(
    `UPDATE user_sessions s SET last_seen_at = NOW()
     FROM app_users u
     WHERE s.token_hash = $1 AND u.id = s.user_id AND u.active
       AND s.expires_at > NOW() AND s.last_seen_at > NOW() - make_interval(mins => $2)
     RETURNING u.id::int, u.email, u.name, u.role`,
    [hashToken(token), sessionIdleMinutes],
  );
  return result.rows[0];
}

export async function logout(pool: Pool, token: string | undefined, remoteAddr: string | null): Promise<void> {
  if (!token) return;
  const result = await pool.query<{ user_id: number; email: string }>(
    `DELETE FROM user_sessions s USING app_users u
     WHERE s.token_hash = $1 AND u.id = s.user_id RETURNING s.user_id::int, u.email`,
    [hashToken(token)],
  );
  const row = result.rows[0];
  if (row) {
    await pool.query(
      `INSERT INTO auth_log (user_id, email, event, remote_addr) VALUES ($1, $2, 'logout', $3)`,
      [row.user_id, row.email, remoteAddr],
    );
  }
}

export function readSessionCookie(header: string | undefined): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const [name, ...value] = part.trim().split('=');
    if (name === sessionCookieName) return value.join('=');
  }
  return undefined;
}

export function sessionCookie(token: string, maxAgeSeconds = sessionMaxAgeSeconds): string {
  return `${sessionCookieName}=${token}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export async function createUser(
  pool: Pool,
  input: { email: string; name: string; role: UserRole; password: string; username?: string },
) {
  validatePassword(input.password);
  await pool.query(
    `INSERT INTO app_users (email, name, role, password_hash, username) VALUES ($1, $2, $3, $4, $5)`,
    [
      normalizeEmail(input.email),
      input.name.trim(),
      input.role,
      await hashPassword(input.password),
      input.username ? validateUsername(input.username) : null,
    ],
  );
}

export async function setUsername(pool: Pool, login: string, username: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE app_users SET username = $2, updated_at = NOW() WHERE email = $1 OR username = $1 RETURNING id`,
    [normalizeLogin(login), validateUsername(username)],
  );
  return Boolean(result.rows[0]);
}

// Trocar senha ou desativar encerra todas as sessões do usuário. `login` = e-mail ou usuário.
// `allowWeak` só é usado pela CLI quando o dono pede explicitamente uma senha curta.
export async function setPassword(pool: Pool, login: string, password: string, allowWeak = false): Promise<boolean> {
  if (!allowWeak) validatePassword(password);
  else if (!password || password.length > 200) throw new Error('Senha vazia ou longa demais.');
  const result = await pool.query<{ id: number }>(
    `UPDATE app_users SET password_hash = $2, updated_at = NOW() WHERE email = $1 OR username = $1 RETURNING id`,
    [normalizeLogin(login), await hashPassword(password)],
  );
  if (result.rows[0]) await pool.query(`DELETE FROM user_sessions WHERE user_id = $1`, [result.rows[0].id]);
  return Boolean(result.rows[0]);
}

export async function setActive(pool: Pool, login: string, active: boolean): Promise<boolean> {
  const result = await pool.query<{ id: number }>(
    `UPDATE app_users SET active = $2, updated_at = NOW() WHERE email = $1 OR username = $1 RETURNING id`,
    [normalizeLogin(login), active],
  );
  if (result.rows[0] && !active) await pool.query(`DELETE FROM user_sessions WHERE user_id = $1`, [result.rows[0].id]);
  return Boolean(result.rows[0]);
}

export async function purgeAuthData(pool: Pool, logMonths: number) {
  const sessions = await pool.query(`DELETE FROM user_sessions WHERE expires_at < NOW()`);
  const log = await pool.query(`DELETE FROM auth_log WHERE created_at < NOW() - make_interval(months => $1)`, [logMonths]);
  return { sessions: sessions.rowCount ?? 0, authLog: log.rowCount ?? 0 };
}
