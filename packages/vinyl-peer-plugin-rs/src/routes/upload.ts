import { Request, Response } from "express";
import type { PluginContext } from "vinyl-peer-protocol";
import type { Level } from "level";
import { encodeFileToShards } from "../utils/encoder.js";
import type { RSManifest } from "../types.js";

/**
 * Returns an Express handler that:
 * - Expects `req.file.buffer` (via multer) containing the raw file
 * - Reads optional `dataShards` and `parityShards` from req.body
 * - Calls encodeFileToShards → writes the manifest into rsDb
 * - Responds with { id, shards: [ { index, cid, isParity } ] }
 */
export default function uploadRoute(context: PluginContext, rsDb: Level<string, RSManifest>) {
  return async (req: Request, res: Response) => {
    // 1) Multer has populated `req.file`
    const file = req.file;
    if (!file || !file.buffer) {
      res.status(400).json({ error: "Missing file (field name must be 'file')" });
      return;
    }

    // 2) Read optional shard counts from the form
    const dataShards = parseInt(req.body.dataShards, 10) || 6;
    const parityShards = parseInt(req.body.parityShards, 10) || 3;

    try {
      // 3) Encode into shards (this pins each shard into Helia internally)
      const { manifest } = await encodeFileToShards(file.buffer, {
        dataShards,
        parityShards,
        filename: file.originalname,
        mimeType: file.mimetype || "application/octet-stream",
        helia: context.helia,
      });

      // 4) Create a manifest ID and store it in LevelDB
      const manifestId = `${context.nodeId}-${Date.now()}`;
      await rsDb.put(manifestId, manifest);

      // 5) Return ID + list of shards
      res.json({
        id: manifestId,
        shards: manifest.shards,
      });
    } catch (err) {
      console.error("[vinyl-rs] upload error:", err);
      res.status(500).json({ error: "Upload/encoding failed" });
    }
  };
}
