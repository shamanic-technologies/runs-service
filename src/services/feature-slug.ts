// A lead is found by a SOURCING origin (features-service catalogue, every slug
// prefixed `sourcing-`: sourcing-apollo-cold-filters, sourcing-crm-contacts, ...)
// and later emailed by an OUTREACH feature (sales-cold-email-outreach). lead-service
// opens each lead-serve run under the outreach workflow run but labels it with the
// sourcing slug, so the whole serve subtree (enrichment, verification, judgments)
// is attributed to the origin that produced the lead.
//
// So a child may carry a sourcing slug while its parent carries a non-sourcing one.
// Every other mismatch (two outreach slugs, two different sourcing slugs, a
// non-sourcing child under a sourcing parent) stays a parent-child conflict.
const SOURCING_PREFIX = "sourcing-";

export function isSourcingFeatureSlug(slug: string): boolean {
  return slug.startsWith(SOURCING_PREFIX);
}

export function featureSlugConflicts(child: string, parent: string): boolean {
  if (child === parent) return false;
  if (isSourcingFeatureSlug(child) && !isSourcingFeatureSlug(parent)) return false;
  return true;
}

// SOURCE CAMPAIGNS (owner 2026-10-07): an offer's lead sources are campaigns of
// their own (campaign-service, keyed offer + origin slug + leg
// "start_to_lead_found"). The serve opened under an outreach workflow run is
// FILED under the source campaign that found the lead, so a sourcing child may
// carry its own campaignId under a non-sourcing parent, exactly like its slug.
// A parent with NO feature slug counts as non-sourcing, as in featureSlugConflicts:
// workflow-service opens many execute-workflow runs unlabelled, and requiring a
// parent slug 409'd every lead-serve under them (prod 2026-10-08, zero leads served).
// Its own descendants then inherit (or must equal) the source campaign. Any other
// campaign mismatch stays a parent-child conflict.
export function campaignIdConflicts(args: {
  childCampaignId: string;
  parentCampaignId: string;
  childFeatureSlug: string | null;
  parentFeatureSlug: string | null;
}): boolean {
  if (args.childCampaignId === args.parentCampaignId) return false;
  const sourcingUnderOutreach =
    !!args.childFeatureSlug &&
    isSourcingFeatureSlug(args.childFeatureSlug) &&
    !(args.parentFeatureSlug && isSourcingFeatureSlug(args.parentFeatureSlug));
  return !sourcingUnderOutreach;
}
