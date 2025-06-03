import { sha256 } from "multiformats/hashes/sha2";
import * as rawCodec from "multiformats/codecs/raw";
import { CID } from "multiformats/cid";
import type { Helia } from "helia";
import type { RSManifest, RSShardInfo } from "../types.js";
import { createRequire } from "module";

const cjsRequire = createRequire(import.meta.url);
const ReedSolomon = cjsRequire("@ronomon/reed-solomon");

/**
 * Split `buffer` into Reed-Solomon shards, store each shard in IPFS via helia.blockstore.put(),
 * and return a manifest that matches your RSManifest type exactly.
 */
export async function encodeFileToShards(
  buffer: Buffer,
  opts: {
    dataShards: number;
    parityShards: number;
    filename: string;
    mimeType: string;
    helia: Helia;
  },
): Promise<{ manifest: RSManifest }> {
  const { dataShards, parityShards, filename, mimeType, helia } = opts;
  const totalShards = dataShards + parityShards;

  // 1) Create a ReedSolomon context
  const rsContext = ReedSolomon.create(dataShards, parityShards);

  // 2) Choose a shardSize (multiple of 8). Here: 64 KiB.
  const shardSize = 64 * 1024;

  // 3) Allocate dataBuffer (zero-padded if needed)
  const originalFileSize = buffer.length;
  const dataBuffer = Buffer.alloc(shardSize * dataShards, 0);
  buffer.copy(
    /* target */ dataBuffer,
    /* targetOffset */ 0,
    /* sourceOffset */ 0,
    /* copyLength */ Math.min(buffer.length, dataBuffer.length),
  );

  // 4) Allocate an empty parityBuffer
  const parityBuffer = Buffer.alloc(shardSize * parityShards, 0);

  // 5) Build “sources” bitmask (first dataShards bits set)
  let sourcesBitmask = 0;
  for (let i = 0; i < dataShards; i++) {
    sourcesBitmask |= 1 << i;
  }

  // 6) Build “targets” bitmask (next parityShards bits)
  let targetsBitmask = 0;
  for (let j = 0; j < parityShards; j++) {
    targetsBitmask |= 1 << (dataShards + j);
  }

  // 7) Run ReedSolomon.encode (callback style)
  await new Promise<void>((resolve, reject) => {
    ReedSolomon.encode(
      rsContext,
      sourcesBitmask,
      targetsBitmask,
      dataBuffer,
      /* dataOffset */ 0,
      dataBuffer.byteLength,
      parityBuffer,
      /* parityOffset */ 0,
      parityBuffer.byteLength,
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });

  // 8) Now split dataBuffer into individual shards and store them via helia.blockstore.put
  /** @type {RSShardInfo[]} */
  const shards: RSShardInfo[] = [];

  for (let i = 0; i < dataShards; i++) {
    const slice = dataBuffer.slice(i * shardSize, (i + 1) * shardSize);

    // 8a) Hash with SHA-256
    const hash = await sha256.digest(Uint8Array.from(slice));

    // 8b) Wrap the digest into a CID (v1 + raw)
    const cid = CID.createV1(rawCodec.code, hash);

    // 8c) Store <CID, bytes> using helia.blockstore.put
    //      (cast to `any` so TS won't complain if blockstore has no overload signature)
    await (helia.blockstore as any).put(cid, Uint8Array.from(slice));

    shards.push({
      index: i,
      cid: cid.toString(), // the string form of the CID
      isParity: false, // these first `dataShards` are data shards
    });
  }

  // 9) Do the same for parity shards
  for (let j = 0; j < parityShards; j++) {
    const slice = parityBuffer.slice(j * shardSize, (j + 1) * shardSize);
    const hash = await sha256.digest(Uint8Array.from(slice));
    const cid = CID.createV1(rawCodec.code, hash);

    await (helia.blockstore as any).put(cid, Uint8Array.from(slice));

    shards.push({
      index: dataShards + j,
      cid: cid.toString(),
      isParity: true,
    });
  }

  // 10) Build and return the manifest, exactly matching your RSManifest interface
  const manifest: RSManifest = {
    filename,
    mimeType,
    originalFileSize,
    dataShards,
    parityShards,
    totalShards,
    shardSize,
    shards,
    createdAt: new Date().toISOString(),
  };

  return { manifest };
}
