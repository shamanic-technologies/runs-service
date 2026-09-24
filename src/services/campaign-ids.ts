// `campaignIds` — a comma-separated list of stored campaign ids answered in one
// request. A campaign as the customer knows it is a FAMILY of stored rows
// (campaign-service keeps every superseded row; one real campaign has 47), and
// every read that took one `campaignId` otherwise cost its consumer one call per
// row. Shared by GET /v1/runs and the stats reads so they validate identically.

export const MAX_CAMPAIGN_IDS = 500;

/**
 * Parse the raw query value. Absent → `{ ids: undefined }`. Blank and duplicate
 * ids are dropped; an empty list or more than MAX_CAMPAIGN_IDS ids is an error
 * (the caller answers 400).
 */
export function parseCampaignIds(raw: unknown): { ids?: string[]; error?: string } {
  if (raw === undefined) return {};
  const ids = [...new Set(String(raw).split(",").map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return { error: "campaignIds must list at least one campaign id" };
  if (ids.length > MAX_CAMPAIGN_IDS) return { error: `campaignIds accepts at most ${MAX_CAMPAIGN_IDS} ids` };
  return { ids };
}
