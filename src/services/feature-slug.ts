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
