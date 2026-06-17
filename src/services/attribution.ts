import type { Request } from "express";

export type Attribution = {
  goal: string | null;
  brandProfileId: string | null;
  customerProfileId: string | null;
  workflowContext: string | null;
};

export type AttributionInput = {
  goal?: string | null;
  brandProfileId?: string | null;
  customerProfileId?: string | null;
  workflowContext?: string | null;
};

export function requestAttribution(req: Request, body: AttributionInput = {}): Attribution {
  return {
    goal: req.headerGoal ?? body.goal ?? null,
    brandProfileId: req.headerBrandProfileId ?? body.brandProfileId ?? null,
    customerProfileId: req.headerCustomerProfileId ?? body.customerProfileId ?? null,
    workflowContext: req.headerWorkflowContext ?? body.workflowContext ?? null,
  };
}

export function inheritAttribution(current: Attribution, parent: AttributionInput): Attribution {
  return {
    goal: current.goal ?? parent.goal ?? null,
    brandProfileId: current.brandProfileId ?? parent.brandProfileId ?? null,
    customerProfileId: current.customerProfileId ?? parent.customerProfileId ?? null,
    workflowContext: current.workflowContext ?? parent.workflowContext ?? null,
  };
}

export function costAttribution(item: AttributionInput, req: Request, run: AttributionInput): Attribution {
  return {
    goal: item.goal ?? req.headerGoal ?? run.goal ?? null,
    brandProfileId: item.brandProfileId ?? req.headerBrandProfileId ?? run.brandProfileId ?? null,
    customerProfileId: item.customerProfileId ?? req.headerCustomerProfileId ?? run.customerProfileId ?? null,
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
  if (requested.customerProfileId && parent.customerProfileId && requested.customerProfileId !== parent.customerProfileId) {
    conflicts.push(`customerProfileId: request="${requested.customerProfileId}" vs parent="${parent.customerProfileId}"`);
  }
  if (requested.workflowContext && parent.workflowContext && requested.workflowContext !== parent.workflowContext) {
    conflicts.push(`workflowContext: request="${requested.workflowContext}" vs parent="${parent.workflowContext}"`);
  }
  return conflicts;
}
