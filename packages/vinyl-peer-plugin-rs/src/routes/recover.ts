import { Request, Response } from "express";
import type { PluginContext } from "vinyl-peer-protocol";
import type { Level } from "level";
import type { RSManifest } from "../types.js";
import { decodeShardsToFile } from "../utils/decoder.js";

/**
 * Returns an Express handler that:
 * - Expects `:id` to be the manifest ID in rsDb
 * - Fetches that manifest, runs RS decode, and returns the exact original bytes
 */
export default function recoverRoute(context: PluginContext, rsDb: Level<string, RSManifest>) {
  return async (req: Request, res: Response) => {
    const manifestId = req.params.id;

    let manifest: RSManifest;
    try {
      manifest = await rsDb.get(manifestId);
    } catch {
      res.status(404).json({ error: `Manifest "${manifestId}" not found` });
      return;
    }

    try {
      // decodeShardsToFile will fetch each shard from Helia, reconstruct, and return a Buffer
      const fileBuffer = await decodeShardsToFile(manifest, context.helia);

      // Set headers so browser/download clients know how to handle it
      res.setHeader("Content-Type", manifest.mimeType);
      res.setHeader("Content-Disposition", `attachment; filename="${manifest.filename}"`);
      res.send(fileBuffer);
    } catch (err) {
      console.error("[vinyl-rs] recover error:", err);
      res.status(500).json({ error: "Recovery/decode failed" });
    }
  };
}
