import { Router, Request, Response } from "express";
import type { PluginContext } from "vinyl-peer-protocol";
import type { AdvancedManifest, ShardIndexEntry } from "../types.js";
import type { Level } from "level";

interface StatusPayload {
  manifest: AdvancedManifest;
  shardIndex: ShardIndexEntry[];
}

/**
 * GET /api/adv-shard/status/:id
 *   Return the manifest + current replication counts (via DHT‐stored shardIndex).
 */
export default function statusRoute(
  context: PluginContext,
  advDb: Level<string, AdvancedManifest>,
): Router {
  const router = Router();

  router.get(
    "/status/:id",
    async (req: Request, res: Response<StatusPayload | { error: string }>) => {
      const id = req.params.id;
      let manifest: AdvancedManifest;
      try {
        manifest = await advDb.get(id);
      } catch {
        res.status(404).json({ error: `Manifest ${id} not found` });
        return;
      }

      // Return manifest & its DHT‐aggregated shardIndex
      res.json({
        manifest,
        shardIndex: manifest.shardIndex as ShardIndexEntry[],
      });
    },
  );

  return router;
}
