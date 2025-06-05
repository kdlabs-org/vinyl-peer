import type { PluginContext } from "vinyl-peer-protocol";
import geoip from "geoip-lite";

/**
 * ReplicationBalancer:
 * - Chooses which peer to pin a “hot” CID to.
 * - Keeps track (in‐memory) of which peers have pinned which CIDs.
 *
 * Production tweaks:
 *  - Concurrency‐safe (operations atomic on in‐memory Set)
 *  - Configurable defaultMinReplicas and per‐region targets
 */
export class ReplicationBalancer {
  private pinnedMap: Map<string, Set<string>> = new Map(); // cid → set(peerIds)
  private defaultMinReplicas: number;

  constructor(
    private context: PluginContext,
    defaultMinReplicas: number = 3,
  ) {
    this.defaultMinReplicas = defaultMinReplicas;
  }

  /**
   * Default “maybePin” logic (non‐geo‐aware):
   * - If fewer than `defaultMinReplicas` total replicas exist, pick a random peer to pin.
   */
  async maybePin(cid: string) {
    const activePeers = Array.from(this.context.peers.keys());
    if (activePeers.length === 0) return;

    const current = this.pinnedMap.get(cid) || new Set<string>();
    if (current.size < this.defaultMinReplicas) {
      const candidates = activePeers.filter((p) => !current.has(p));
      if (candidates.length > 0) {
        const peerId = candidates[Math.floor(Math.random() * candidates.length)];
        // Use this.emit() so that source is set to this plugin’s name
        this.emit("replicate:pinRequest", { cid, targetPeer: peerId });
        current.add(peerId);
        this.pinnedMap.set(cid, current);
      }
    }
  }

  /**
   * Geo‐aware “maybePinInRegion”:
   * - Ensures that each region has at least regionConfig[region] replicas.
   * - If this region is under‐replicated, pick a peer from that region.
   */
  async maybePinInRegion(
    cid: string,
    region: string,
    regionConfig: { [continent: string]: number },
  ) {
    const desired = regionConfig[region] ?? this.defaultMinReplicas;
    const current = this.pinnedMap.get(cid) || new Set<string>();

    // Count how many peers in this region already pinned
    let countInRegion = 0;
    for (const peerId of current) {
      const peerInfo = this.context.peers.get(peerId);
      if (!peerInfo) continue;
      const peerRegion = this.lookupContinent(peerInfo.address);
      if (peerRegion === region) {
        countInRegion++;
      }
    }

    if (countInRegion < desired) {
      // Find candidates in this region that haven’t pinned
      const candidates = Array.from(this.context.peers.entries())
        .filter(([peerId, peerInfo]) => {
          const peerRegion = this.lookupContinent(peerInfo.address);
          return peerRegion === region && !current.has(peerId);
        })
        .map(([peerId]) => peerId);

      if (candidates.length > 0) {
        const peerId = candidates[Math.floor(Math.random() * candidates.length)];
        this.emit("replicate:pinRequest", { cid, targetPeer: peerId });
        current.add(peerId);
        this.pinnedMap.set(cid, current);
      }
    }
  }

  /**
   * Force‐pin or unpin (override) a given CID on this node.
   */
  async override(cid: string, action: "pin" | "unpin") {
    if (!this.pinnedMap.has(cid)) {
      this.pinnedMap.set(cid, new Set<string>());
    }
    const current = this.pinnedMap.get(cid)!;
    if (action === "pin") {
      await this.context.pinFile(cid);
      current.add(this.context.nodeId);
    } else {
      await this.context.unpinFile(cid);
      current.delete(this.context.nodeId);
    }
    this.pinnedMap.set(cid, current);
  }

  /**
   * Return status: how many replicas exist per CID and which peers have pinned them.
   */
  getStatus(): { [cid: string]: { replicaCount: number; peers: string[] } } {
    const result: Record<string, { replicaCount: number; peers: string[] }> = {};
    for (const [cid, peerSet] of this.pinnedMap.entries()) {
      result[cid] = { replicaCount: peerSet.size, peers: Array.from(peerSet) };
    }
    return result;
  }

  /**
   * Count how many replicas of a CID exist in a given region (based on pinnedMap).
   */
  countLocalReplicas(cid: string, region: string): number {
    const current = this.pinnedMap.get(cid) || new Set<string>();
    let count = 0;
    for (const peerId of current) {
      const peerInfo = this.context.peers.get(peerId);
      if (!peerInfo) continue;
      const peerRegion = this.lookupContinent(peerInfo.address);
      if (peerRegion === region) {
        count++;
      }
    }
    return count;
  }

  /**
   * Helper: given an IP address string, return a continent code like "NA", "EU", etc.
   * Maps lookup(country) → continent by using a small mapping table.
   * Defaults to "NA" if unknown.
   */
  private lookupContinent(ip: string): string {
    const geo = geoip.lookup(ip);
    if (!geo?.country) {
      return "NA";
    }
    const countryCode = geo.country; // e.g., "US", "FR", "CN"
    const countryToContinent: Record<string, string> = {
      US: "NA",
      CA: "NA",
      MX: "NA",
      BR: "SA",
      AR: "SA",
      GB: "EU",
      FR: "EU",
      DE: "EU",
      CN: "AS",
      JP: "AS",
      IN: "AS",
      AU: "OC",
      ZA: "AF",
      EG: "AF",
      // add more mappings as needed
    };
    return countryToContinent[countryCode] ?? "NA";
  }

  /**
   * Emit a replication event. Wraps context.emit to set source automatically.
   */
  private emit(event: string, payload: any) {
    // Use BasePlugin.emit signature: { source: <pluginName>, payload }
    // But since ReplicationBalancer is not itself a plugin, include a generic source
    this.context.emit(event, { source: "auto-replication", payload });
  }
}
