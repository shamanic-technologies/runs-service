import type { Request } from "express";

export type Attribution = {
  goal: string | null;
  brandProfileId: string | null;
  audienceId: string | null;
  workflowContext: string | null;
};

export type AttributionInput = {
  goal?: string | null;
  brandProfileId?: string | null;
  audienceId?: string | null;
  /** @deprecated Legacy alias for audienceId. Accepted during rollout; resolves to audienceId. */
  customerProfileId?: string | null;
  workflowContext?: string | null;
};

export function requestAttribution(req: Request, body: AttributionInput = {}): Attribution {
  return {
    goal: req.headerGoal ?? body.goal ?? null,
    brandProfileId: req.headerBrandProfileId ?? body.brandProfileId ?? null,
    // Canonical x-audience-id / audienceId wins; legacy x-customer-profile-id /
    // customerProfileId is still honored until consumers migrate.
    audienceId:
      req.headerAudienceId ??
      body.audienceId ??
      req.headerCustomerProfileId ??
      body.customerProfileId ??
      null,
    workflowContext: req.headerWorkflowContext ?? body.workflowContext ?? null,
  };
}

export function inheritAttribution(current: Attribution, parent: AttributionInput): Attribution {
  return {
    goal: current.goal ?? parent.goal ?? null,
    brandProfileId: current.brandProfileId ?? parent.brandProfileId ?? null,
    audienceId: current.audienceId ?? parent.audienceId ?? parent.customerProfileId ?? null,
    workflowContext: current.workflowContext ?? parent.workflowContext ?? null,
  };
}

export function costAttribution(item: AttributionInput, req: Request, run: AttributionInput): Attribution {
  return {
    goal: item.goal ?? req.headerGoal ?? run.goal ?? null,
    brandProfileId: item.brandProfileId ?? req.headerBrandProfileId ?? run.brandProfileId ?? null,
    audienceId:
      item.audienceId ??
      item.customerProfileId ??
      req.headerAudienceId ??
      req.headerCustomerProfileId ??
      run.audienceId ??
      run.customerProfileId ??
      null,
    workflowContext: item.workflowContext ?? req.headerWorkflowContext ?? run.workflowContext ?? null,
  };
}

export function attributionConflicts(
  requested: Attribution,
  parent: AttributionInput,
): string[] {
  const conflicts: string[] = [];
  if (requested.goal && parent.goal && requested.goal !== parent.goal) {
    conflicts.push(`goal: request="${requested.goal}" vs parent="${parent.goal}"`);
  }
  if (requested.brandProfileId && parent.brandProfileId && requested.brandProfileId !== parent.brandProfileId) {
    conflicts.push(`brandProfileId: request="${requested.brandProfileId}" vs parent="${parent.brandProfileId}"`);
  }
  const parentAudienceId = parent.audienceId ?? parent.customerProfileId ?? null;
  if (requested.audienceId && parentAudienceId && requested.audienceId !== parentAudienceId) {
    conflicts.push(`audienceId: request="${requested.audienceId}" vs parent="${parentAudienceId}"`);
  }
  if (requested.workflowContext && parent.workflowContext && requested.workflowContext !== parent.workflowContext) {
    conflicts.push(`workflowContext: request="${requested.workflowContext}" vs parent="${parent.workflowContext}"`);
  }
  return conflicts;
}
