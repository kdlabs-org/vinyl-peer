/**
 * RSShardInfo: describes a single RS/erasure‐coded shard.
 */
export interface RSShardInfo {
  index: number; // 0 ≤ index < totalShards
  cid: string; // IPFS/Helia CID
  isParity: boolean; // true if parity shard
}

/**
 * ChunkInfo: describes a Rabin‐chunked block.
 */
export interface ChunkInfo {
  start: number; // byte offset in original file
  length: number; // length in bytes
  shards: RSShardInfo[]; // all RS shards covering this chunk
}

/**
 * ShardIndexEntry: for DHT indexing – maps shard‐CID → ownerPeer + timestamp.
 */
export interface ShardIndexEntry {
  shardCid: string;
  ownerPeer: string;
  lastSeen: string; // ISO timestamp
  isParity: boolean;
}

/**
 * Tunables (per‐file override):
 */
export interface ShardingConfig {
  dataShards: number;
  parityShards: number;
  minReplicas: number;
  autoRepairIntervalSeconds: number;
}

/**
 * Advanced manifest describing both chunk‐level layout + RS shards.
 */
export interface AdvancedManifest {
  filename: string;
  mimeType: string;
  originalFileSize: number;
  dataShards: number;
  parityShards: number;
  totalShards: number;
  shardSize: number;
  createdAt: string;
  chunks: ChunkInfo[]; // for partial fetch
  shardIndex: ShardIndexEntry[]; // DHT rep map
}
