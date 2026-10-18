-- =============================================================================
-- Out-of-band alerts for high and critical risk events.
--
-- The worker pushes each such event to an operations channel (Telegram) and
-- stamps alerted_at once the channel has accepted it. Delivery is at least
-- once: a crash between sending and stamping repeats the alert, never drops it.
--
-- Only the worker may stamp alerted_at. The web role keeps the columns it needs
-- to resolve events, so a compromised web server cannot silence alerts.
-- =============================================================================

alter table public.risk_events add column alerted_at timestamptz;

-- Events already on record are not alerted retroactively when this ships.
update public.risk_events set alerted_at = created_at;

create index risk_events_unalerted_idx on public.risk_events (created_at)
  where alerted_at is null and severity in ('high', 'critical');

revoke update on public.risk_events from app_web;
grant update (status, resolution_note, resolved_by, resolved_at) on public.risk_events to app_web;
