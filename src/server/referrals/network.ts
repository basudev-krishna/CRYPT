/**
 * Administrator control of the referral network: sponsor corrections and
 * left/right team positions, plus the team tree read model.
 *
 * Positions are an organisational record the administrator maintains. Nothing
 * here computes or pays anything from team volume; any reward is a separate,
 * explicit bonus the administrator awards from the operator-funded referral
 * fund (see adjustments/manual.ts).
 *
 * The database refuses loops and taken positions; every change keeps the old
 * and new value, the reason and who made it (sponsor_changes,
 * placement_history, audit log).
 */
import { many, maybeOne, one, type Db } from '../db-core';
import { recordAudit, raiseRiskEvent, type Actor } from '../ops';

export class NetworkError extends Error {
  override name = 'NetworkError';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export type Side = 'left' | 'right';
const MIN_REASON = 10;

const requireReason = (reason: string) => {
  if (reason.trim().length < MIN_REASON) throw new NetworkError(`A reason of at least ${MIN_REASON} characters is required`, 'reason_required');
  return reason.trim();
};

async function memberByCode(db: Db, code: string): Promise<{ user_id: string; member_code: string }> {
  const m = await maybeOne<{ user_id: string; member_code: string }>(db, 'select user_id, member_code from public.user_profiles where member_code = $1', [
    code.trim().toUpperCase(),
  ]);
  if (!m) throw new NetworkError(`No member has the id ${code.trim().toUpperCase()}`, 'member_not_found');
  return m;
}

/** Map database rule violations (P0005) to a readable domain error. */
function rethrow(err: unknown): never {
  const e = err as { code?: string; message?: string; constraint?: string };
  if (e.code === 'P0005') throw new NetworkError(e.message ?? 'Not allowed', 'not_allowed');
  if (e.code === '23505' && e.constraint === 'one_child_per_side') throw new NetworkError('That side is already taken under this member', 'position_taken');
  throw err;
}

/** Change who referred a member (or clear it with null). Audited with old and new value. */
export async function correctSponsor(
  db: Db,
  args: { userId: string; sponsorMemberCode: string | null; reason: string; staffUserId: string; actor: Actor },
): Promise<void> {
  const reason = requireReason(args.reason);
  const before = await one<{ code: string | null }>(
    db,
    'select s.member_code as code from public.user_profiles p left join public.user_profiles s on s.user_id = p.sponsor_user_id where p.user_id = $1',
    [args.userId],
  );
  const sponsor = args.sponsorMemberCode ? await memberByCode(db, args.sponsorMemberCode) : null;
  try {
    await db.query('select private.admin_set_sponsor($1, $2, $3, $4)', [args.userId, sponsor?.user_id ?? null, reason, args.staffUserId]);
  } catch (err) {
    rethrow(err);
  }
  const details = { previousSponsor: before.code, newSponsor: sponsor?.member_code ?? null, reason };
  await recordAudit(db, args.actor, 'referral.sponsor_corrected', { type: 'user', id: args.userId }, details);
  // Referral rewards follow the sponsor link, so a change is worth an alert.
  await raiseRiskEvent(db, { userId: args.userId, kind: 'admin_sponsor_correction', severity: 'medium', subjectType: 'user', subjectId: args.userId, details });
}

/** Whether `userId` sits somewhere in `rootId`'s team (or is `rootId`). */
async function inTeamOf(db: Db, userId: string, rootId: string): Promise<boolean> {
  let cursor: string | null = userId;
  for (let steps = 0; cursor && steps < 10_000; steps++) {
    if (cursor === rootId) return true;
    const up: { parent_user_id: string } | null = await maybeOne<{ parent_user_id: string }>(db, 'select parent_user_id from public.binary_placements where user_id = $1', [cursor]);
    cursor = up?.parent_user_id ?? null;
  }
  return false;
}

/** The last member down `side`'s outer edge from `rootId` (the root itself if that side is free). */
async function outerEdge(db: Db, rootId: string, side: Side): Promise<string> {
  let cursor = rootId;
  for (let steps = 0; steps < 10_000; steps++) {
    const child = await maybeOne<{ user_id: string }>(db, 'select user_id from public.binary_placements where parent_user_id = $1 and side = $2', [cursor, side]);
    if (!child) return cursor;
    cursor = child.user_id;
  }
  throw new NetworkError('Team tree too deep', 'not_allowed');
}

/**
 * Place a member (or move them, with their whole team) to the left or right of
 * any parent. If that spot is taken, the member there moves down (with their
 * team) to the end of the same side under the newly placed member, so the
 * administrator can put anyone anywhere. Both moves are recorded.
 */
export async function setPlacement(
  db: Db,
  args: { userId: string; parentMemberCode: string; side: Side; reason: string; staffUserId: string; actor: Actor },
): Promise<void> {
  const reason = requireReason(args.reason);
  const parent = await memberByCode(db, args.parentMemberCode);
  if (parent.user_id === args.userId) throw new NetworkError('A member cannot be placed under themselves', 'not_allowed');
  // One tree edit at a time: moves read and rewrite several positions.
  await db.query("select pg_advisory_xact_lock(hashtext('binary_tree'))");
  const before = await maybeOne<{ parent_user_id: string; side: Side }>(db, 'select parent_user_id, side from public.binary_placements where user_id = $1 for update', [
    args.userId,
  ]);
  if (before && before.parent_user_id === parent.user_id && before.side === args.side) return;
  if (await inTeamOf(db, parent.user_id, args.userId)) throw new NetworkError('A member cannot be placed inside their own team', 'not_allowed');

  const occupant = await maybeOne<{ user_id: string; member_code: string }>(
    db,
    `select b.user_id, p.member_code from public.binary_placements b join public.user_profiles p on p.user_id = b.user_id
      where b.parent_user_id = $1 and b.side = $2 for update of b`,
    [parent.user_id, args.side],
  );
  let displaced: { userId: string; memberCode: string; newParentId: string } | null = null;
  try {
    if (occupant) {
      if (await inTeamOf(db, args.userId, occupant.user_id)) {
        throw new NetworkError(`This member is inside ${occupant.member_code}'s team, who holds that spot. Move ${occupant.member_code} first.`, 'not_allowed');
      }
      // Free the spot first: the occupant goes to the end of the same side under the member being placed.
      const edge = await outerEdge(db, args.userId, args.side);
      await db.query('update public.binary_placements set parent_user_id = $2, side = $3, placed_by = $4, placed_at = now() where user_id = $1', [
        occupant.user_id,
        edge,
        args.side,
        args.staffUserId,
      ]);
      displaced = { userId: occupant.user_id, memberCode: occupant.member_code, newParentId: edge };
    }
    if (before) {
      await db.query('update public.binary_placements set parent_user_id = $2, side = $3, placed_by = $4, placed_at = now() where user_id = $1', [
        args.userId,
        parent.user_id,
        args.side,
        args.staffUserId,
      ]);
    } else {
      await db.query('insert into public.binary_placements (user_id, parent_user_id, side, placed_by) values ($1, $2, $3, $4)', [
        args.userId,
        parent.user_id,
        args.side,
        args.staffUserId,
      ]);
    }
  } catch (err) {
    rethrow(err);
  }
  const history = `insert into public.placement_history (user_id, old_parent_id, old_side, new_parent_id, new_side, reason, changed_by)
     values ($1, $2, $3, $4, $5, $6, $7)`;
  if (displaced) {
    await db.query(history, [displaced.userId, parent.user_id, args.side, displaced.newParentId, args.side, `Moved down to make room: ${reason}`, args.staffUserId]);
  }
  await db.query(history, [args.userId, before?.parent_user_id ?? null, before?.side ?? null, parent.user_id, args.side, reason, args.staffUserId]);
  await recordAudit(db, args.actor, before ? 'network.member_moved' : 'network.member_placed', { type: 'user', id: args.userId }, {
    previous: before ? { parentUserId: before.parent_user_id, side: before.side } : null,
    next: { parent: parent.member_code, side: args.side },
    displaced: displaced ? { member: displaced.memberCode, newParentUserId: displaced.newParentId, side: args.side } : null,
    reason,
  });
}

/** Take a member out of the tree. Their own team stays attached to them. */
export async function removePlacement(db: Db, args: { userId: string; reason: string; staffUserId: string; actor: Actor }): Promise<void> {
  const reason = requireReason(args.reason);
  const before = await maybeOne<{ parent_user_id: string; side: Side }>(db, 'delete from public.binary_placements where user_id = $1 returning parent_user_id, side', [
    args.userId,
  ]);
  if (!before) throw new NetworkError('This member has no position', 'not_placed');
  await db.query(
    `insert into public.placement_history (user_id, old_parent_id, old_side, new_parent_id, new_side, reason, changed_by)
     values ($1, $2, $3, null, null, $4, $5)`,
    [args.userId, before.parent_user_id, before.side, reason, args.staffUserId],
  );
  await recordAudit(db, args.actor, 'network.member_removed', { type: 'user', id: args.userId }, { previous: before, reason });
}

// -----------------------------------------------------------------------------
// Read models
// -----------------------------------------------------------------------------
export interface TreeNode {
  userId: string;
  memberCode: string;
  side: Side | null;
  left: TreeNode | null;
  right: TreeNode | null;
  /** Members in each side's whole team (not just direct children). */
  leftCount: number;
  rightCount: number;
  /** True when the tree goes deeper than was loaded. */
  truncated: boolean;
}

interface Row {
  user_id: string;
  parent_user_id: string | null;
  side: Side | null;
  member_code: string;
  depth: number;
}

/** Build a nested tree from flat rows (root first). Pure, so it is unit tested. */
export function buildTree(rows: Row[], maxDepth: number, counts: Map<string, number>): TreeNode | null {
  const root = rows.find((r) => r.depth === 0);
  if (!root) return null;
  const byParent = new Map<string, Row[]>();
  for (const r of rows) if (r.parent_user_id && r.depth > 0) byParent.set(r.parent_user_id, [...(byParent.get(r.parent_user_id) ?? []), r]);
  const make = (r: Row): TreeNode => {
    const kids = byParent.get(r.user_id) ?? [];
    const left = kids.find((k) => k.side === 'left');
    const right = kids.find((k) => k.side === 'right');
    const size = (k: Row | undefined) => (k ? 1 + (counts.get(k.user_id) ?? 0) : 0);
    return {
      userId: r.user_id,
      memberCode: r.member_code,
      side: r.depth === 0 ? null : r.side,
      left: left ? make(left) : null,
      right: right ? make(right) : null,
      leftCount: size(left),
      rightCount: size(right),
      truncated: r.depth >= maxDepth && (counts.get(r.user_id) ?? 0) > 0,
    };
  };
  return make(root);
}

/** The team under `rootUserId`, `maxDepth` levels deep, with whole-team counts per side. Member ids only. */
export async function teamTree(db: Db, rootUserId: string, maxDepth = 5): Promise<TreeNode | null> {
  const rows = await many<Row>(
    db,
    `with recursive t as (
       select p.user_id, null::uuid as parent_user_id, null::text as side, p.member_code, 0 as depth
         from public.user_profiles p where p.user_id = $1
       union all
       select b.user_id, b.parent_user_id, b.side, p.member_code, t.depth + 1
         from t join public.binary_placements b on b.parent_user_id = t.user_id
         join public.user_profiles p on p.user_id = b.user_id
        where t.depth < $2
     ) select * from t`,
    [rootUserId, maxDepth],
  );
  // Whole-team size below each loaded node (descendant count), regardless of depth limit.
  const counts = await many<{ user_id: string; n: number }>(
    db,
    `with recursive d as (
       select b.user_id as anc, b.user_id as node from public.binary_placements b
        where b.user_id = any($1::uuid[])
       union all
       select d.anc, c.user_id from d join public.binary_placements c on c.parent_user_id = d.node
     ) select anc as user_id, (count(*) - 1)::int as n from d group by anc`,
    [rows.map((r) => r.user_id)],
  );
  const map = new Map(counts.map((c) => [c.user_id, Number(c.n)]));
  // The root may be unplaced itself; count its team directly.
  if (!map.has(rootUserId)) {
    const n = await one<{ n: number }>(
      db,
      `with recursive d as (select user_id from public.binary_placements where parent_user_id = $1
         union all select c.user_id from d join public.binary_placements c on c.parent_user_id = d.user_id)
       select count(*)::int as n from d`,
      [rootUserId],
    );
    map.set(rootUserId, Number(n.n));
  }
  return buildTree(rows, maxDepth, map);
}

export async function placementOf(db: Db, userId: string) {
  return maybeOne<{ parent_code: string; side: Side; placed_at: Date }>(
    db,
    `select p.member_code as parent_code, b.side, b.placed_at
       from public.binary_placements b join public.user_profiles p on p.user_id = b.parent_user_id where b.user_id = $1`,
    [userId],
  );
}

export async function networkHistory(db: Db, userId: string) {
  return many<{ kind: 'sponsor' | 'placement'; at: Date; detail: string; reason: string }>(
    db,
    `select 'sponsor' as kind, c.changed_at as at,
            coalesce(o.member_code, 'none') || ' → ' || coalesce(n.member_code, 'none') as detail, c.reason
       from public.sponsor_changes c
       left join public.user_profiles o on o.user_id = c.old_sponsor_id
       left join public.user_profiles n on n.user_id = c.new_sponsor_id
      where c.user_id = $1
     union all
     select 'placement', h.changed_at,
            coalesce(o.member_code || ' ' || h.old_side, 'none') || ' → ' || coalesce(n.member_code || ' ' || h.new_side, 'removed'), h.reason
       from public.placement_history h
       left join public.user_profiles o on o.user_id = h.old_parent_id
       left join public.user_profiles n on n.user_id = h.new_parent_id
      where h.user_id = $1
     order by at desc limit 50`,
    [userId],
  );
}
