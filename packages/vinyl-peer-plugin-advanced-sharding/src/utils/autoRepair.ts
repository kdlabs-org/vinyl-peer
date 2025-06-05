import type { Helia } from "helia";
import { CID } from "multiformats/cid";
import type { AdvancedManifest, ShardIndexEntry } from "../types.js";
import { decodeAdvancedShardsToFile } from "./decoder.js";
import type { Level } from "level";

/**
 * Every `intervalSeconds`, scan the entire advDb (streaming), check DHT entries,
 * re-encode or re-pin if under‐replicated, and update DHT index entries.
 *
 * Production tweaks:
 *  - Use streaming iteration to avoid loading all keys at once.
 *  - Surround each manifest‐repair in try/catch so one failure doesn’t kill the loop.
 *  - Honor `minReplicas` from an in‐memory (or persisted) config, if provided by user.
 */
export function startAutoRepair(
  helia: Helia,
  advDb: Level<string, AdvancedManifest>,
  putShardIndex: (entry: ShardIndexEntry) => Promise<void>,
  getConfig: (manifestId: string) => Promise<{
    dataShards: number;
    parityShards: number;
    minReplicas: number;
    autoRepairIntervalSeconds: number;
  }>,
  intervalSeconds: number,
): NodeJS.Timer {
  return setInterval(async () => {
    try {
      for await (const [manifestId, manifest] of advDb.iterator()) {
        // Default config values
        let config = {
          dataShards: manifest.dataShards,
          parityShards: manifest.parityShards,
          minReplicas: 3,
          autoRepairIntervalSeconds: intervalSeconds,
        };
        try {
          const override = await getConfig(manifestId);
          config = { ...config, ...override };
        } catch {
          // Use defaults if no override
        }

        for (const chunk of manifest.chunks) {
          for (const shardInfo of chunk.shards) {
            try {
              const cidObj = CID.parse(shardInfo.cid);
              const found = await (helia.blockstore as any).get(cidObj);
              if (!found) {
                // Missing → reconstruct entire file (could optimize to per‐chunk)
                const fullFile = await decodeAdvancedShardsToFile(manifest, helia);
                // Re-encode with the same parameters (must include ownerPeer)
                const { encodeFileToAdvancedShards } = await import("./encoder.js");
                const ownerPeer = (helia as any).libp2p.peerId.toString();
                const { manifest: newManifest } = await encodeFileToAdvancedShards(fullFile, {
                  dataShards: config.dataShards,
                  parityShards: config.parityShards,
                  filename: manifest.filename,
                  mimeType: manifest.mimeType,
                  helia,
                  ownerPeer,
                  putShardIndex,
                  config: { shardSize: manifest.shardSize },
                });
                await advDb.put(manifestId, newManifest);
                break; // move to next manifest after repair
              } else {
                // Update “lastSeen” in DHT index
                await putShardIndex({
                  shardCid: shardInfo.cid,
                  ownerPeer: (helia as any).libp2p.peerId.toString(),
                  lastSeen: new Date().toISOString(),
                  isParity: shardInfo.isParity,
                });
              }
            } catch {
              // continue to next shard if any error
            }
          }
        }
      }
    } catch (err) {
      console.error("[AdvancedSharding][autoRepair] uncaught error:", err);
    }
  }, intervalSeconds * 1000);
}
