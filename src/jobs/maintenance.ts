import { query } from "../db/pool.js";

// Daily data-handling job.
export async function runMaintenance(): Promise<{ deleted: number; placesCleared: number }> {
  // Archived leads with no engagement are deleted after 12 months. The
  // suppression list is kept permanently (it has no foreign key to leads).
  const deleted = await query<{ id: number }>(
    `DELETE FROM leads l
     WHERE l.archived_at IS NOT NULL AND l.archived_at < now() - interval '12 months'
       AND l.stage IN ('new', 'qualified', 'lost')
       AND NOT EXISTS (SELECT 1 FROM events e WHERE e.lead_id = l.id
                       AND e.type IN ('reply', 'call_booked', 'proposal_sent', 'signed', 'paid'))
     RETURNING id`,
  );
  // Places content is kept only while it's useful; the place ID stays as the
  // durable key and details are refreshed when the lead is worked.
  const cleared = await query<{ id: number }>(
    `UPDATE leads SET places_json = NULL, places_fetched_at = NULL
     WHERE places_fetched_at < now() - interval '30 days' RETURNING id`,
  );
  await query(
    `UPDATE checks SET rating = NULL, review_count = NULL
     WHERE ran_at < now() - interval '30 days' AND (rating IS NOT NULL OR review_count IS NOT NULL)`,
  );
  return { deleted: deleted.length, placesCleared: cleared.length };
}
