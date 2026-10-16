import { requireUser } from '@/server/http/auth';
import { json, route } from '@/server/http/api';
import { webDb } from '@/server/db';
import { getPerformanceWindows, getUserSeries, listAllocations } from '@/server/queries/user';

export const GET = route(async (req) => {
  const user = await requireUser();
  const days = Math.min(365, Math.max(1, Number(req.nextUrl.searchParams.get('days') ?? 90) || 90));
  const [windows, series, allocations] = await Promise.all([
    getPerformanceWindows(webDb(), user.id),
    getUserSeries(webDb(), user.id, days),
    listAllocations(webDb(), user.id),
  ]);
  return json({ windows, series, allocations, available: series.length > 0 });
});
