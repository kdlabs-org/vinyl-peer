import type { Helia } from "helia";
import { CID } from "multiformats/cid";
import type { AdvancedManifest } from "../types.js";
import { createRequire } from "module";

const cjsRequire = createRequire(import.meta.url);
const ReedSolomon = cjsRequire("@ronomon/reed-solomon");

/**
 * Decode an AdvancedManifest:
 * - For each chunk, attempt to fetch data‐shards from Helia. If any are missing:
 *     • fetch parity‐shards → run ReedSolomon.decode to reconstruct.
 * - Concatenate each chunk’s data in order → full Buffer.
 */
export async function decodeAdvancedShardsToFile(
  manifest: AdvancedManifest,
  helia: Helia,
): Promise<Buffer> {
  const { dataShards, parityShards, shardSize, originalFileSize, chunks } = manifest;
  const totalShards = dataShards + parityShards;
  const outputBuffers: Buffer[] = [];

  for (const chunk of chunks) {
    // 1) Build an array of length `totalShards`.
    //    Each index will hold either a Buffer (if that shard was fetched)
    //    or `undefined` if missing.
    const rawShards: Array<Buffer | undefined> = new Array(totalShards).fill(undefined);

    // 2) Try to load every shard that the manifest knows about.
    for (const shardInfo of chunk.shards) {
      try {
        const cidObj = CID.parse(shardInfo.cid);
        // helia.blockstore.get(...) returns a Uint8Array | null
        const u8: Uint8Array | null = await (helia.blockstore as any).get(cidObj);
        if (u8 != null) {
          rawShards[shardInfo.index] = Buffer.from(u8);
        }
      } catch {
        rawShards[shardInfo.index] = undefined;
      }
    }

    // 3) Count how many shards are missing
    const missingIndices = rawShards
      .map((b, i) => (b === undefined ? i : null))
      .filter((i) => i !== null);

    if (missingIndices.length === 0) {
      // All data‐shards are present. We can grab the first `dataShards` slices.
      const dataBuffers = rawShards.slice(0, dataShards) as Buffer[];
      // Concatenate and then truncate to the exact chunk.length to drop padding.
      const chunkBuf = Buffer.concat(dataBuffers).slice(0, chunk.length);
      outputBuffers.push(chunkBuf);
      continue;
    }

    // 4) Some data‐shards are missing. Attempt Reed-Solomon reconstruction.
    const recoveredAll: Buffer = await new Promise((resolve, reject) => {
      ReedSolomon.decode(
        rawShards,
        { dataShards, parityShards },
        (err: Error | null, recovered: Buffer | undefined) => {
          if (err) return reject(err);
          if (!recovered) return reject(new Error("RS decode did not return a buffer"));
          resolve(recovered);
        },
      );
    });

    // 5) The returned `recoveredAll` contains (dataShards + parityShards) * shardSize bytes.
    //    We only want the first dataShards * shardSize bytes, then we crop to chunk.length.
    const dataPortion = recoveredAll.slice(0, dataShards * shardSize);
    const chunkBuf = dataPortion.slice(0, chunk.length);
    outputBuffers.push(chunkBuf);
  }

  // 6) Stitch all the chunk buffers together, then trim to the originalFileSize.
  return Buffer.concat(outputBuffers).slice(0, originalFileSize);
}
