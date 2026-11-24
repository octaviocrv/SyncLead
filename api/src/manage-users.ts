// Gestão de usuários do painel (na VPS). <login> = e-mail ou nome de usuário.
//   docker compose exec api node dist/manage-users.js add <email> <admin|gestor> <nome...> [--user <usuario>]
//   docker compose exec api node dist/manage-users.js set-username <login> <usuario>
//   docker compose exec api node dist/manage-users.js reset-password <login>      (gera senha aleatória)
//   docker compose exec -T api node dist/manage-users.js set-password <login>    (lê a senha da entrada padrão; --allow-weak aceita < 10 caracteres)
//   docker compose exec api node dist/manage-users.js disable|enable <login>
//   docker compose exec api node dist/manage-users.js list
// Senhas geradas são exibidas uma única vez. Mínimo de 10 caracteres para senha escolhida.
import { config } from './config.js';
import { createUser, generatePassword, setActive, setPassword, setUsername, type UserRole } from './auth.js';
import { createPool, initializeDatabase } from './database.js';

const args = process.argv.slice(2);
const userFlag = args.indexOf('--user');
const username = userFlag >= 0 ? args.splice(userFlag, 2)[1] : undefined;
const weakFlag = args.indexOf('--allow-weak');
const allowWeak = weakFlag >= 0 && Boolean(args.splice(weakFlag, 1));
const [command, login, ...rest] = args;
const pool = createPool(config.databaseUrl);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

try {
  await initializeDatabase(pool);
  switch (command) {
    case 'add': {
      const [role, ...nameParts] = rest;
      if (!login?.includes('@') || (role !== 'admin' && role !== 'gestor') || nameParts.length === 0) {
        fail('Uso: add <email> <admin|gestor> <nome> [--user <usuario>]');
      }
      const password = generatePassword();
      await createUser(pool, { email: login, role: role as UserRole, name: nameParts.join(' '), password, username });
      console.log(`Usuário ${login}${username ? ` / ${username}` : ''} (${role}) criado. Senha inicial (exibida só agora): ${password}`);
      break;
    }
    case 'set-username':
      if (!login || !rest[0] || !(await setUsername(pool, login, rest[0]))) fail('Uso: set-username <login> <usuario> (usuário existente).');
      console.log(`Usuário ${login} agora também entra como "${rest[0].trim().toLowerCase()}".`);
      break;
    case 'reset-password': {
      const password = generatePassword();
      if (!login || !(await setPassword(pool, login, password))) fail('Usuário não encontrado.');
      console.log(`Nova senha de ${login} (exibida só agora; sessões encerradas): ${password}`);
      break;
    }
    case 'set-password': {
      if (!login) fail('Uso: echo -n "senha" | set-password <login>');
      if (!(await setPassword(pool, login, await readStdin(), allowWeak))) fail('Usuário não encontrado.');
      console.log(`Senha de ${login} alterada (sessões encerradas).${allowWeak ? ' ATENÇÃO: senha fraca permitida por --allow-weak.' : ''}`);
      break;
    }
    case 'disable':
    case 'enable':
      if (!login || !(await setActive(pool, login, command === 'enable'))) fail('Usuário não encontrado.');
      console.log(`Usuário ${login} ${command === 'enable' ? 'reativado' : 'desativado (sessões encerradas)'}.`);
      break;
    case 'list': {
      const users = await pool.query(
        `SELECT email, username, name, role, active, created_at, last_login_at FROM app_users ORDER BY id`,
      );
      console.table(users.rows);
      break;
    }
    default:
      fail('Comandos: add, set-username, reset-password, set-password, disable, enable, list');
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await pool.end();
}
