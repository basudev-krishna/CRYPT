/**
 * STAGING SETUP - run by the operator, never by CI.
 *
 *   npx tsx scripts/setup-staging.ts init [--env-file .env.local]
 *                                                         # role passwords + reference data; with --env-file the new
 *                                                         # DATABASE_URL_WEB/WORKER are written there instead of printed
 *   npx tsx scripts/setup-staging.ts grant-admin <email>  # after that admin has signed up at /register
 *   npx tsx scripts/setup-staging.ts group-mode <network-code> <group-wallet> [<token-contract> <decimals> <symbol>]
 *                                                         # private group: one watched wallet, no investment pool
 *
 * Reads the superuser connection from STAGING_DB_URL (set it on the command
 * line, not in a file). Secrets it generates are printed to this terminal
 * only; copy them into the host's environment settings and .env.local.
 *
 * Reference data comes from supabase/seed.sql (simulated network active, every
 * mainnet disabled). The only mainnet that can be activated is bsc-mainnet, by
 * `group-mode bsc-mainnet <group-wallet>` (mainnet_allowlist constraint).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { MAINNET_LIMITS, MAINNET_TOKEN_MINIMUMS, scaledLimits, tokenMinimums } from '../src/server/group-limits';
import { REAL_FUNDS_NETWORKS } from '../src/server/phase-guard';

async function main() {
  const url = process.env.STAGING_DB_URL;
  if (!url) throw new Error('Set STAGING_DB_URL to the project superuser connection string');
  const parsed = parseDbUrl(url);
  const host = parsed.hostname;
  if (['127.0.0.1', 'localhost'].includes(host)) throw new Error('STAGING_DB_URL points at localhost; use `npm run db:reset` for local dev');
  const [cmd, arg] = process.argv.slice(2);
  const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    if (!(await db.query("select to_regclass('public.member_invitations') as t")).rows[0].t) {
      throw new Error('Migrations are not applied yet. Run `npx supabase db push --db-url ...` first.');
    }
    if (cmd === 'init') await init(db, parsed, arg === '--env-file' ? process.argv[4] : undefined);
    else if (cmd === 'grant-admin' && arg) await grantAdmin(db, arg);
    else if (cmd === 'group-mode' && arg) await groupMode(db, arg, process.argv.slice(4));
    else throw new Error('Usage: setup-staging.ts init | grant-admin <email> | group-mode <network-code> <group-wallet> [<token-contract> <decimals> <symbol>]');
  } finally {
    await db.end();
  }
}

/** Sets KEY=value lines in an env file, replacing existing ones, without echoing values. */
function writeEnvVars(path: string, vars: Record<string, string>) {
  let text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  for (const [key, value] of Object.entries(vars)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, () => line) : `${text.replace(/\n?$/, '\n')}${line}\n`;
  }
  writeFileSync(path, text);
}

async function init(db: pg.Client, admin: URL, envFile?: string) {
  const host = admin.hostname;
  const webPw = randomBytes(24).toString('hex');
  const workerPw = randomBytes(24).toString('hex');
  await db.query('begin');
  try {
    // Role passwords are hex, so they are safe to interpolate.
    await db.query(`alter role app_web login password '${webPw}'`);
    await db.query(`alter role app_worker login password '${workerPw}'`);
    const seeded = (await db.query('select count(*)::int as n from public.supported_networks')).rows[0].n > 0;
    if (!seeded) {
      // Same reference data as local dev, minus the local role passwords.
      const sql = readFileSync('supabase/seed.sql', 'utf8').replace(/^alter role .*$/gm, '');
      await db.query(sql);
    }
    await db.query('commit');
    console.log(seeded ? 'Reference data already present; left unchanged.' : 'Reference data loaded (testnet only).');
  } catch (err) {
    await db.query('rollback');
    throw err;
  }
  // Session pooler users are "<role>.<project-ref>"; the direct host is "db.<project-ref>.supabase.co".
  const pooled = decodeURIComponent(admin.username).includes('.');
  const ref = pooled ? decodeURIComponent(admin.username).split('.').slice(1).join('.') : (host.split('.')[1] ?? '<project-ref>');
  const user = (role: string) => (pooled ? `${role}.${ref}` : role);
  const port = admin.port || '5432';
  const vars = {
    DATABASE_URL_WEB: `postgresql://${user('app_web')}:${webPw}@${host}:${port}/postgres`,
    DATABASE_URL_WORKER: `postgresql://${user('app_worker')}:${workerPw}@${host}:${port}/postgres`,
  };
  if (envFile) {
    writeEnvVars(envFile, vars);
    console.log(`
Role passwords rotated. DATABASE_URL_WEB and DATABASE_URL_WORKER were written to ${envFile} (${pooled ? 'session pooler' : 'direct'} host ${host}).
Copy the same two lines into your host's environment settings if the app runs elsewhere. Restart the app and worker.`);
    return;
  }
  console.log(`
Role passwords rotated. Put these in .env.local and in your host's environment settings.
Direct connection (works from this PC):
  DATABASE_URL_WEB=postgresql://app_web:${webPw}@${host}:5432/postgres
  DATABASE_URL_WORKER=postgresql://app_worker:${workerPw}@${host}:5432/postgres
For hosted deployments use the Session pooler host from Supabase (Connect button), with users
  app_web.${ref} and app_worker.${ref} and the same passwords.
These passwords are not stored anywhere else. Re-running "init" rotates them.`);
}


async function grantAdmin(db: pg.Client, email: string) {
  const r = await db.query('select id, email_confirmed_at from auth.users where lower(email) = $1', [email.trim().toLowerCase()]);
  const u = r.rows[0];
  if (!u) throw new Error('No account with that email. Sign up at /register first.');
  if (!u.email_confirmed_at) throw new Error('Verify the email address first (open the link in the confirmation email).');
  await db.query("insert into public.staff_roles (user_id, role) values ($1, 'admin') on conflict do nothing", [u.id]);
  // The first admin has nobody to approve them, so the sign-up is approved here.
  await db.query(
    "update public.user_profiles set account_status = 'active', restriction_reason = null, reviewed_at = now() where user_id = $1 and account_status in ('pending_approval', 'rejected')",
    [u.id],
  );
  await db.query(
    `insert into public.audit_events (actor_type, actor_id, action, subject_type, subject_id, details)
     values ('system', 'setup-staging', 'staff.role_granted', 'user', $1, '{"role":"admin"}'::jsonb)`,
    [u.id],
  );
  console.log('Granted admin. Sign in, enrol MFA under Security (staff pages require it), then approve new sign-ups under Admin → Sign-up approvals.');
}

/** Parses STAGING_DB_URL, explaining a malformed one without ever printing the password. */
function parseDbUrl(url: string): URL {
  const trimmed = url.trim();
  try {
    if (!/^postgres(ql)?:\/\//.test(trimmed)) throw new Error('scheme');
    return new URL(trimmed);
  } catch {
    // Mask everything between "user:" and the last "@" before the host.
    const masked = trimmed.replace(/^(postgres(?:ql)?:\/\/[^:/@]*:)(.*)@([^@]*)$/, (_m, head: string, pw: string, rest: string) => `${head}${'*'.repeat(pw.length)}@${rest}`);
    const at = trimmed.lastIndexOf('@');
    const pw = at > 0 ? trimmed.slice(trimmed.indexOf(':', trimmed.indexOf('//') + 2) + 1, at) : '';
    const bad = [...new Set(pw.match(/[^A-Za-z0-9._~%-]/g) ?? [])];
    const hints = [
      !/^postgres(ql)?:\/\//.test(trimmed) ? 'it must start with postgresql://' : '',
      at < 0 ? 'there is no "@" before the host' : '',
      /[[\]]/.test(trimmed) ? 'remove the [ ] brackets around the password' : '',
      bad.length ? `the password contains ${bad.map((c) => JSON.stringify(c)).join(' ')}, which must be URL-encoded (or use a letters-and-numbers password)` : '',
    ].filter(Boolean);
    throw new Error(`STAGING_DB_URL is not a valid URL: ${masked}${hints.length ? `
  Problem: ${hints.join('; ')}` : ''}`);
  }
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Private-group setup: members deposit into one group wallet the app only
 * watches, the administrator signs payouts (CUSTODY_PROVIDER=manual), and there
 * is no investment pool. Policies change by inserting new versions.
 * On bsc-mainnet the token is the verified contract from the migration; a
 * contract cannot be passed on the command line.
 */
async function groupMode(db: pg.Client, networkCode: string, rest: string[]) {
  const [wallet, contract, decimalsArg, symbol] = rest;
  if (!wallet || !EVM_ADDRESS.test(wallet)) throw new Error('Give the group wallet address (0x + 40 hex characters)');
  const net = (await db.query('select id, code, is_testnet, family::text, chain_id::text from public.supported_networks where code = $1', [networkCode])).rows[0];
  if (!net) throw new Error(`Unknown network ${networkCode}`);
  const mainnet = !net.is_testnet;
  if (mainnet && REAL_FUNDS_NETWORKS[net.code] !== net.chain_id) throw new Error(`${networkCode} is not a supported real-funds network`);
  if (mainnet && contract) throw new Error('On mainnet the token comes from the verified migration; do not pass a contract');

  await db.query('begin');
  try {
    if (contract) {
      const decimals = Number(decimalsArg);
      if (!EVM_ADDRESS.test(contract) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36 || !symbol) {
        throw new Error('Token arguments: <token-contract> <decimals> <symbol>');
      }
      // Minimums: 10 and 1 whole tokens.
      await db.query(
        `insert into public.supported_tokens (network_id, symbol, name, contract_address, decimals, is_native, is_test_token, status, min_deposit_base, min_withdrawal_base)
         select $1, $2, $3, $4, $5::int, false, true, 'active', 10 * power(10::numeric, $5::int), power(10::numeric, $5::int)
          where not exists (select 1 from public.supported_tokens where network_id = $1 and contract_address = $4)`,
        [net.id, symbol, `${symbol} (testnet, no value)`, contract.toLowerCase(), decimals],
      );
    }
    if (mainnet) {
      // USDT on BSC has 18 decimals (checked again on chain by the adapter).
      const mins = tokenMinimums(18);
      const r = await db.query(
        `update public.supported_tokens set status = 'active', min_deposit_base = $2, min_withdrawal_base = $3
          where network_id = $1 and not is_native and not is_test_token and decimals = 18
            and contract_address = '0x55d398326f99059ff775485246999027b3197955'`,
        [net.id, mins.deposit, mins.withdrawal],
      );
      if (r.rowCount !== 1) throw new Error('Verified BSC USDT token missing; apply migration 20261024000300 (and seed reference data) first');
    }
    const token = (await db.query("select id, decimals from public.supported_tokens where network_id = $1 and not is_native and status = 'active' order by id limit 1", [net.id])).rows[0];
    if (!token) throw new Error(`No active token on ${networkCode}; pass <token-contract> <decimals> <symbol>`);

    await db.query("update public.supported_networks set status = 'active' where id = $1", [net.id]);
    // Real-funds limits are in this token's decimals, so no other network may stay open beside it.
    if (mainnet) await db.query("update public.supported_networks set status = 'disabled' where id <> $1 and status <> 'disabled'", [net.id]);
    // One group wallet per network: it is the hot wallet payouts are sent from and verified against.
    await db.query("update public.treasury_wallets set is_active = false where network_id = $1 and kind = 'hot' and address <> $2", [net.id, wallet.toLowerCase()]);
    await db.query(
      `insert into public.treasury_wallets (network_id, kind, address, label, custody_provider, receives_deposits)
       values ($1, 'hot', $2, 'Group wallet', 'manual', true)
       on conflict (network_id, address) do update set receives_deposits = true, is_active = true, custody_provider = 'manual'`,
      [net.id, wallet.toLowerCase()],
    );

    const changes: Record<string, Record<string, unknown>> = {
      deposit: { auto_subscribe: false, require_kyc_approved: false },
      withdrawal: { require_kyc_approved: false, ...(mainnet ? { require_mfa: true } : {}) },
    };
    for (const [kind, patch] of Object.entries(changes)) {
      const cur = (await db.query('select version, params from public.current_policy($1::public.policy_kind)', [kind])).rows[0];
      if (!cur?.version) throw new Error(`No ${kind} policy yet; run "init" first`);
      const amounts = mainnet ? scaledLimits(kind, cur.params, Number(token.decimals)) : {};
      const note = mainnet
        ? `Private group mode on ${net.code} (real funds): no investment pool, sign-up approval instead of KYC, limits for ${token.decimals}-decimal USDT`
        : 'Private group mode: no investment pool; members are vetted by sign-up approval instead of KYC';
      await db.query(
        `insert into public.policy_versions (kind, version, params, change_note, created_by, approved_by)
         values ($1::public.policy_kind, $2, $3::jsonb, $4, 'setup-staging', 'setup-staging')`,
        [kind, cur.version + 1, JSON.stringify({ ...cur.params, ...patch, ...amounts }), note],
      );
    }
    await db.query("update public.investment_pools set status = 'paused' where status = 'active'");
    await db.query(
      `insert into public.audit_events (actor_type, actor_id, action, subject_type, subject_id, details)
       values ('system', 'setup-staging', 'ops.group_mode_configured', 'network', $1, $2::jsonb)`,
      [net.code, JSON.stringify({ wallet: wallet.toLowerCase(), realFunds: mainnet })],
    );
    await db.query('commit');
  } catch (err) {
    await db.query('rollback');
    throw err;
  }
  if (mainnet) {
    console.log(`Group mode configured on ${networkCode} with REAL FUNDS. Minimums (USDT): ${JSON.stringify(MAINNET_TOKEN_MINIMUMS)}. Withdrawal limits (USDT): ${JSON.stringify(MAINNET_LIMITS.withdrawal)}.
Set in the host's environment settings, then restart the app and worker:
  APP_ENV=production
  REAL_FUNDS_ENABLED=true
  GROUP_MODE=true
  CUSTODY_PROVIDER=manual
  DEMO_MODE=false
  RPC_URL_BSC_MAINNET=<a BSC mainnet RPC endpoint, ideally a paid provider>
  TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (required in production)`);
    return;
  }
  console.log(`Group mode configured on ${networkCode}. Set in .env.local (and the host's settings), then restart the app and worker:
  GROUP_MODE=true
  CUSTODY_PROVIDER=manual${net.family === 'evm' ? `
  RPC_URL_${networkCode.toUpperCase().replace(/-/g, '_')}=<an RPC endpoint for ${networkCode}>` : ''}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
