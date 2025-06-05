import { Router, Request, Response } from "express";
import type { PluginContext } from "vinyl-peer-protocol";
import type { ShardingConfig } from "../types.js";

/**
 * GET /api/adv-shard/config/:id
 *   Return current per‐manifest sharding config (in-memory override).
 * POST /api/adv-shard/config/:id
 *   Accept JSON { dataShards?, parityShards?, minReplicas?, autoRepairIntervalSeconds? }
 *   and update the in‐memory config.  (User responsible for re‐encode if K/M changed.)
 */
export default function configRoute(context: PluginContext): Router {
  // In‐memory override store: manifestId → ShardingConfig
  const inMemoryConfig: Record<string, Partial<ShardingConfig>> = {};

  const router: Router = Router();

  router.get(
    "/config/:id",
    (req: Request, res: Response<Partial<ShardingConfig> | { error: string }>) => {
      const id = req.params.id;
      res.json(inMemoryConfig[id] || {});
    },
  );

  router.post(
    "/config/:id",
    (
      req: Request,
      res: Response<{ success: true; config: Partial<ShardingConfig> } | { error: string }>,
    ) => {
      const id = req.params.id;
      const updates = req.body as Partial<ShardingConfig>;
      if (typeof updates !== "object" || Array.isArray(updates)) {
        res.status(400).json({ error: "Invalid config format" });
        return;
      }
      inMemoryConfig[id] = { ...(inMemoryConfig[id] || {}), ...updates };
      res.json({ success: true, config: inMemoryConfig[id] });
    },
  );

  return router;
}
