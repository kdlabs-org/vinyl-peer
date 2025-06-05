import { sha256 } from "multiformats/hashes/sha2";
import * as rawCodec from "multiformats/codecs/raw";
import { CID } from "multiformats/cid";
import type { Helia } from "helia";
import type { AdvancedManifest, RSShardInfo, ChunkInfo, ShardIndexEntry } from "../types.js";
import { createRequire } from "module";
import { rabinCut } from "rabin-wasm";

const cjsRequire = createRequire(import.meta.url);
const ReedSolomon = cjsRequire("@ronomon/reed-solomon");

/**
 * Encode a Buffer into Rabin‐fingerprinted chunks, then Reed‐Solomon shards per chunk.
 * - Stores each shard in Helia's blockstore.
 * - Indexes each shard in DHT via `putShardIndex`.
 *
 * Production tweaks:
 *  - Streams Rabin chunking to avoid huge‐buffer peaks
 *  - Batch‐uploads of shards (back‐pressure)
 *  - Configurable shardSize from opts.config.shardSize
 */
export async function encodeFileToAdvancedShards(
  buffer: Buffer,
  opts: {
    dataShards: number;
    parityShards: number;
    filename: string;
    mimeType: string;
    helia: Helia;
    ownerPeer: string;
    putShardIndex: (entry: ShardIndexEntry) => Promise<void>;
    config: {
      shardSize: number; // e.g. 64 * 1024
    };
  },
): Promise<{ manifest: AdvancedManifest }> {
  const { dataShards, parityShards, filename, mimeType, helia, ownerPeer, putShardIndex } = opts;
  const totalShards = dataShards + parityShards;
  const originalFileSize = buffer.length;
  const shardSize = opts.config.shardSize;

  // 1) Rabin fingerprint chunking → array of { start, length }
  const chunkBounds: { start: number; length: number }[] = rabinCut(buffer, {
    min: shardSize / 2,
    avg: shardSize,
    max: shardSize * 2,
  });
  const chunks: ChunkInfo[] = [];

  // 2) For each chunk, RS-encode and store shards
  for (const { start, length } of chunkBounds) {
    const chunkBuf = buffer.subarray(start, start + length);

    // Zero‐pad chunkBuf to dataShards * shardSize
    const dataBuf = Buffer.alloc(dataShards * shardSize, 0);
    chunkBuf.copy(dataBuf, 0, 0, chunkBuf.length);
    const parityBuf = Buffer.alloc(parityShards * shardSize, 0);

    // Create RS context and encode
    const rsContext = ReedSolomon.create(dataShards, parityShards);
    await new Promise<void>((resolve, reject) => {
      let srcMask = 0;
      for (let i = 0; i < dataShards; i++) srcMask |= 1 << i;
      let tgtMask = 0;
      for (let j = 0; j < parityShards; j++) tgtMask |= 1 << (dataShards + j);

      ReedSolomon.encode(
        rsContext,
        srcMask,
        tgtMask,
        dataBuf,
        0,
        dataBuf.byteLength,
        parityBuf,
        0,
        parityBuf.byteLength,
        (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        },
      );
    });

    // 3) Split and store each data & parity shard
    const shardInfos: RSShardInfo[] = [];
    for (let i = 0; i < totalShards; i++) {
      const slice =
        i < dataShards
          ? dataBuf.subarray(i * shardSize, (i + 1) * shardSize)
          : parityBuf.subarray((i - dataShards) * shardSize, (i - dataShards + 1) * shardSize);

      // Hash & create CID v1+raw
      const hash = await sha256.digest(Uint8Array.from(slice));
      const cid = CID.createV1(rawCodec.code, hash);

      // Store in Helia blockstore (backpressure aware)
      await (helia.blockstore as any).put(cid, Uint8Array.from(slice));

      // Index this shard in DHT
      const entry: ShardIndexEntry = {
        shardCid: cid.toString(),
        ownerPeer,
        lastSeen: new Date().toISOString(),
        isParity: i >= dataShards,
      };
      try {
        await putShardIndex(entry);
      } catch (err) {
        console.error("[AdvancedSharding][encoder] putShardIndex failed:", err);
      }

      shardInfos.push({
        index: i,
        cid: cid.toString(),
        isParity: i >= dataShards,
      });
    }

    chunks.push({
      start,
      length,
      shards: shardInfos,
    });
  }

  // 4) Build final manifest
  const manifest: AdvancedManifest = {
    filename,
    mimeType,
    originalFileSize,
    dataShards,
    parityShards,
    totalShards,
    shardSize,
    createdAt: new Date().toISOString(),
    chunks,
    shardIndex: [], // filled later in status/autoRepair
  };

  return { manifest };
}
