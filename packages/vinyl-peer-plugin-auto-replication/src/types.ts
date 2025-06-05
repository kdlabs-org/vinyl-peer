/**
 * Records download frequencies per shard‐CID (or manifest‐CID).
 */
export interface DemandRecord {
  cid: string;
  count: number;
  lastRequested: string; // ISO timestamp
}

/**
 * Override entry: force‐pin or remove pin on a given CID.
 */
export interface OverrideEntry {
  cid: string;
  action: "pin" | "unpin";
  timestamp: string;
}

/**
 * Status response: returns how many replicas exist for each hot CID,
 * and which peers have pinned them.
 */
export interface ReplicationStatus {
  cid: string;
  replicaCount: number;
  peers: string[];
}

/**
 * Optional region configuration: desired number of replicas per continent.
 */
export interface RegionConfig {
  [continent: string]: number;
}

/**
 * Options for AutoReplicationPlugin:
 */
export interface AutoReplicationOptions {
  hotThreshold?: number;
  geoAware?: boolean;
  defaultRegionConfig?: RegionConfig;
  defaultMinReplicas?: number;
}
