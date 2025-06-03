import type { Helia } from "helia";
import { CID } from "multiformats/cid";
import type { RSManifest } from "../types.js";
import { createRequire } from "module";

const cjsRequire = createRequire(import.meta.url);
const ReedSolomon = cjsRequire("@ronomon/reed-solomon");

/**
 * Given an RSManifest, this function:
 *  1) Fetches each shard from IPFS via helia.blockstore.get()
 *  2) If any shards are missing, uses ReedSolomon.decode to reconstruct them
 *  3) Concatenates the first `dataShards` shards in index order to recover the original file
 */
export async function decodeShardsToFile(manifest: RSManifest, helia: Helia): Promise<Buffer> {
  const {
    dataShards,
    parityShards,
    totalShards,
    shardSize,
    originalFileSize,
    shards: shardInfos,
  } = manifest;

  // 1) Fetch each shard’s bytes (or leave undefined if missing)
  /** @type {Array<Buffer | undefined>} */
  const rawShards = new Array(totalShards).fill(undefined);

  for (let idx = 0; idx < totalShards; idx++) {
    // Find the shard record whose index === idx
    const record = shardInfos.find((s) => s.index === idx);
    if (!record) {
      rawShards[idx] = undefined;
      continue;
    }

    let cidObj;
    try {
      cidObj = CID.parse(record.cid);
    } catch {
      rawShards[idx] = undefined;
      continue;
    }

    try {
      // helia.blockstore.get returns a Uint8Array or null
      const chunkU8 = await (helia.blockstore as any).get(cidObj);
      if (chunkU8) {
        rawShards[idx] = Buffer.from(chunkU8);
      } else {
        rawShards[idx] = undefined;
      }
    } catch {
      rawShards[idx] = undefined;
    }
  }

  // 2) Determine missing shards
  const missing = rawShards.map((buf, i) => (buf == null ? i : null)).filter((i) => i !== null);

  if (missing.length === 0) {
    // No missing shards → just concatenate first dataShards
    const dataBufs = rawShards.slice(0, dataShards) as Buffer[];
    const full = Buffer.concat(dataBufs);
    // Trim to originalFileSize just in case of zero-padding
    return full.slice(0, originalFileSize);
  }

  // 3) Some shards missing → run ReedSolomon.decode
  const recoveredAll = await new Promise<Buffer>((resolve, reject) => {
    ReedSolomon.decode(
      rawShards,
      { dataShards, parityShards },
      (err: Error | null, recoveredBuffer: Buffer | undefined) => {
        if (err) return reject(err);
        if (!recoveredBuffer) {
          return reject(new Error("ReedSolomon.decode did not return a buffer"));
        }
        return resolve(recoveredBuffer);
      },
    );
  });

  // 4) recoveredAll is a Buffer of length totalShards * shardSize
  //    Slice out the first dataShards * shardSize bytes → the “data” portion
  const dataPortion = recoveredAll.slice(0, dataShards * shardSize);

  /** @type {Buffer[]} */
  const outputPieces = [];
  for (let i = 0; i < dataShards; i++) {
    const start = i * shardSize;
    const end = start + shardSize;
    outputPieces.push(dataPortion.slice(start, end));
  }

  // 5) Concatenate those pieces, then trim zero-padding to originalFileSize
  const combined = Buffer.concat(outputPieces);
  return combined.slice(0, originalFileSize);
}
