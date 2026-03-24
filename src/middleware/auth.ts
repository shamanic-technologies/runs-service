import { Request, Response, NextFunction } from "express";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

declare global {
  namespace Express {
    interface Request {
      orgId: string;
      userId?: string;
      runId?: string;
      platformServiceName?: string;
      headerBrandId?: string;
      headerCampaignId?: string;
      headerWorkflowName?: string;
      headerFeatureSlug?: string;
    }
  }
}

function extractWorkflowHeaders(req: Request) {
  const brandId = req.headers["x-brand-id"] as string | undefined;
  if (brandId) req.headerBrandId = brandId;

  const campaignId = req.headers["x-campaign-id"] as string | undefined;
  if (campaignId) req.headerCampaignId = campaignId;

  const workflowName = req.headers["x-workflow-name"] as string | undefined;
  if (workflowName) req.headerWorkflowName = workflowName;

  const featureSlug = req.headers["x-feature-slug"] as string | undefined;
  if (featureSlug) req.headerFeatureSlug = featureSlug;
}

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers["x-api-key"] as string;
  if (!apiKey || apiKey !== process.env.RUNS_SERVICE_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Extract identity headers
  const orgId = req.headers["x-org-id"] as string | undefined;
  if (!orgId || !UUID_RE.test(orgId)) {
    res.status(400).json({ error: "x-org-id header is required and must be a valid UUID" });
    return;
  }
  req.orgId = orgId;

  const userId = req.headers["x-user-id"] as string | undefined;
  if (userId) {
    if (!UUID_RE.test(userId)) {
      res.status(400).json({ error: "x-user-id header must be a valid UUID" });
      return;
    }
    req.userId = userId;
  }

  const runId = req.headers["x-run-id"] as string | undefined;
  if (runId) {
    if (!UUID_RE.test(runId)) {
      res.status(400).json({ error: "x-run-id header must be a valid UUID" });
      return;
    }
    req.runId = runId;
  }

  extractWorkflowHeaders(req);

  next();
}

export function requirePlatformAuth(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers["x-api-key"] as string;
  if (!apiKey || apiKey !== process.env.RUNS_SERVICE_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const serviceName = req.headers["x-service-name"] as string | undefined;
  if (!serviceName || serviceName.trim().length === 0) {
    res.status(400).json({ error: "x-service-name header is required" });
    return;
  }
  req.platformServiceName = serviceName;

  extractWorkflowHeaders(req);

  next();
}
