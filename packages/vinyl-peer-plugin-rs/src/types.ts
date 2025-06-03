/**
 * RSManifest: metadata needed to reassemble the original file.
 */
export interface RSShardInfo {
  index: number; // 0 .. (dataShards + parityShards - 1)
  cid: string; // IPFS/Helia CID for this single shard
  isParity: boolean; // true if this is one of the parity shards
}

export interface RSManifest {
  filename: string; // original filename (e.g. "track.mp3")
  mimeType: string; // original MIME (e.g. "audio/mpeg")
  originalFileSize: number; // exact byte length of the original file
  dataShards: number; // e.g. 6
  parityShards: number; // e.g. 3
  totalShards: number; // dataShards + parityShards
  shardSize: number; // size in bytes of each shard (all shards are equal length except the last data shard which may be padded)
  shards: RSShardInfo[]; // array of length `totalShards`
  createdAt: string; // timestamp when this manifest was created
}
