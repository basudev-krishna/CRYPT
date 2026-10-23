/**
 * LOCAL DEMO SEED - `npm run seed:demo`
 *
 * Creates demo accounts on the local Supabase stack and sends a SIMULATED test
 * token deposit, so the full pipeline (detection -> confirmation -> checks ->
 * credit -> NAV strike) can be watched with the worker running.
 *
 *   demo.investor@example.test   customer, KYC approved, disclosure accepted, 250 tUSDT simulated deposit
 *   demo.admin@example.test      staff: admin
 *   demo.compliance@example.test staff: compliance
 *
 * Safety: refuses to run unless every database URL points at localhost, the
 * Supabase URL is local, APP_ENV is not production and real funds are off. It
 * never touches the ledger directly - crediting happens only through the
 * worker's normal deposit pipeline. Re-running is idempotent.
 */
import { config } from 'dotenv';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { configurePgTypes, maybeOne, one } from '../src/server/db-core';
import { assertRealFundsDisabled } from '../src/server/phase-guard';
import { getDepositInstructions } from '../src/server/deposits/service';
import { SimulatedCustodyProvider } from '../src/server/custody/simulated';
import { getDepositToken, getNetwork } from '../src/server/chains/registry';
import { insertSimTransfer } from '../src/server/chains/simulated';
import { parseUnits } from '../src/lib/money';
import { RISK_DISCLOSURE_VERSION } from '../src/lib/disclosures';

config({ path: ['.env.local', '.env'], quiet: true });
configurePgTypes();

const PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo-Password-2026';
const USERS = [
  { email: 'demo.investor@example.test', role: null, deposit: '250' },
  { email: 'demo.admin@example.test', role: 'admin', deposit: null },
  { email: 'demo.compliance@example.test', role: 'compliance', deposit: null },
] as const;

function requireLocal(name: string): string {
  const url = process.env[name];
  if (!url) throw new Error(`${name} is not set (copy .env.example to .env.local; see README)`);
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error(`Refusing to seed: ${name} points at non-local host ${host}`);
  return url;
}

async function main() {
  assertRealFundsDisabled();
  if (process.env.APP_ENV === 'production') throw new Error('Refusing to seed demo data with APP_ENV=production');
  const supabaseUrl = requireLocal('NEXT_PUBLIC_SUPABASE_URL');
  const admin = new pg.Pool({ connectionString: requireLocal('DATABASE_URL_ADMIN'), max: 2 });
  const worker = new pg.Pool({ connectionString: requireLocal('DATABASE_URL_WORKER'), max: 2 });
  const supabase = createClient(supabaseUrl, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const actor = { type: 'system' as const, id: 'seed-demo' };

  try {
    const network = await getNetwork(worker, 'sim-evm');
    const token = await getDepositToken(worker, network.id);
    if (!token?.contractAddress) throw new Error('Simulated token missing - run `npm run db:reset` first');

    for (const u of USERS) {
      let user = await maybeOne<{ id: string }>(admin, 'select id from auth.users where email = $1', [u.email]);
      if (!user) {
        const { data, error } = await supabase.auth.signUp({ email: u.email, password: PASSWORD });
        if (error || !data.user) throw new Error(`Could not create ${u.email}: ${error?.message}`);
        user = { id: data.user.id };
        console.log(`created ${u.email}`);
      } else {
        console.log(`exists  ${u.email}`);
      }
      await admin.query('update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = $1', [user.id]);
      // Demo accounts skip the admin approval queue.
      await admin.query("update public.user_profiles set account_status = 'active', reviewed_at = coalesce(reviewed_at, now()) where user_id = $1 and account_status = 'pending_approval'", [user.id]);
      await admin.query(
        `insert into public.kyc_records (user_id, status, full_name, country_code, document_type, document_last4, submitted_at, review_notes)
         select $1, 'approved', 'Demo User', 'GB', 'passport', 'DEMO', now(), 'Seeded for local demo'
          where not exists (select 1 from public.kyc_records where user_id = $1)`,
        [user.id],
      );
      await admin.query('update public.user_profiles set risk_disclosure_version = $2, risk_disclosure_accepted_at = coalesce(risk_disclosure_accepted_at, now()) where user_id = $1', [
        user.id,
        RISK_DISCLOSURE_VERSION,
      ]);
      if (u.role) {
        await admin.query('insert into public.staff_roles (user_id, role, granted_by) values ($1, $2, null) on conflict do nothing', [user.id, u.role]);
      }
      if (u.deposit) {
        const ins = await getDepositInstructions(worker, new SimulatedCustodyProvider(worker), user.id, network.id, actor);
        const existing = await one<{ n: number }>(admin, 'select count(*)::int as n from public.sim_chain_transfers where to_address = $1', [ins.address]);
        if (existing.n === 0) {
          const tx = await insertSimTransfer(admin, {
            networkId: network.id,
            tokenContract: token.contractAddress,
            from: '0x5151515151515151515151515151515151515151',
            to: ins.address,
            amount: parseUnits(u.deposit, token.decimals),
            delayBlocks: -network.requiredConfirmations, // already past the confirmation depth
          });
          console.log(`  simulated deposit of ${u.deposit} ${token.symbol} -> ${ins.address} (${tx.txHash})`);
        }
      }
    }

    console.log(`
Demo accounts ready (local only). Password for all: ${process.env.DEMO_PASSWORD ? '$DEMO_PASSWORD' : PASSWORD}
Next steps:
  1. npm run worker   - detects, confirms and credits the simulated deposit, then strikes NAV
  2. npm run dev      - sign in at http://127.0.0.1:3000
  Staff accounts must enrol TOTP at /settings/security before the admin console opens (AAL2 required).`);
  } finally {
    await Promise.all([admin.end(), worker.end()]);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
