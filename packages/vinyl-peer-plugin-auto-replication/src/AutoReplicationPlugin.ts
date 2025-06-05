import {
  BasePlugin,
  PluginCapabilities,
  PluginContext,
  VinylPeerPlugin,
} from "vinyl-peer-protocol";
import { Level } from "level";
import path from "path";
import express from "express";
import geoip from "geoip-lite";
import type { DemandRecord, RegionConfig, AutoReplicationOptions } from "./types.js";
import { DemandMonitor } from "./utils/monitor.js";
import { ReplicationBalancer } from "./utils/balancer.js";
import statusRoute from "./routes/status.js";
import overrideRoute from "./routes/override.js";

/**
 * AutoReplicationPlugin:
 * - Watches “fileDownloaded” events → increments demand.
 * - When “hot,” auto-pins to peers, optionally geo‐aware.
 * - Emits “archiveRequested” for downstream bridge plugins.
 * - Exposes HTTP endpoints for status, override, geo toggles, region config.
 */
export class AutoReplicationPlugin extends BasePlugin implements VinylPeerPlugin {
  protected context!: PluginContext;

  private demandDb!: Level<string, DemandRecord>;
  private monitor!: DemandMonitor;
  private balancer!: ReplicationBalancer;

  private geoAware: boolean;
  private regionConfig: RegionConfig;
  private localRegion: string;
  private hotThreshold: number;
  private defaultMinReplicas: number;

  constructor(opts: AutoReplicationOptions = {}) {
    super();
    this.geoAware = opts.geoAware ?? false;
    this.regionConfig = opts.defaultRegionConfig ?? {
      NA: 3,
      EU: 2,
      AS: 1,
      AF: 1,
      SA: 1,
      OC: 1,
      AN: 1,
    };
    this.hotThreshold = opts.hotThreshold ?? 10;
    this.defaultMinReplicas = opts.defaultMinReplicas ?? 3;
    this.localRegion = "NA"; // will be updated in initialize()
  }

  getCapabilities(): PluginCapabilities {
    return {
      name: "vinyl-peer-plugin-auto-replication",
      version: "0.1.0",
      protocols: [],
      capabilities: ["storage"],
      permissions: {
        accessFiles: true,
        useNetwork: true,
        modifyPeers: false,
        exposeHttp: true,
      },
    };
  }

  async initialize(context: PluginContext): Promise<boolean> {
    const ok = await super.initialize(context);
    if (!ok) return false;
    this.context = context;

    // 1) Determine this node’s region via GeoIP
    this.localRegion = this.determineLocalRegion();

    // 2) LevelDB for demand counts (optional persistence)
    const folder = path.join(process.cwd(), "demand-records");
    this.demandDb = new Level<string, DemandRecord>(folder, { valueEncoding: "json" });

    // 3) Create DemandMonitor & ReplicationBalancer
    this.monitor = new DemandMonitor(this.hotThreshold);
    this.balancer = new ReplicationBalancer(this.context, this.defaultMinReplicas);

    // 4) When a "hot" event fires, decide how to pin and then emit archive request
    this.monitor.onHot(async (cid: string) => {
      try {
        if (this.geoAware) {
          const desired = this.regionConfig[this.localRegion] ?? this.defaultMinReplicas;
          const currentCount = this.balancer.countLocalReplicas(cid, this.localRegion);
          if (currentCount < desired) {
            await this.balancer.maybePinInRegion(cid, this.localRegion, this.regionConfig);
          }
        } else {
          await this.balancer.maybePin(cid);
        }
      } catch (err) {
        console.error("[AutoReplication] pin attempt failed:", err);
      }

      // 5) Emit an archiveRequested event (bridges pick this up)
      this.context.emit("archiveRequested", {
        source: "auto-replication",
        payload: { cid },
      });
    });

    // 6) Listen to core's fileDownloaded events to track demand
    this.context.onEvent((evt, envelope) => {
      if (evt === "fileDownloaded") {
        const cid = envelope.payload as string;
        this.monitor.recordDownload(cid);
      }
    });

    return true;
  }

  async start(): Promise<void> {
    await super.start();
    // No extra work needed
  }

  async stop(): Promise<void> {
    await this.demandDb.close();
    await super.stop();
  }

  setupProtocols(): void {
    // No libp2p protocols
  }

  async handleProtocol(_protocol: string, _stream: any, _peerId: string): Promise<void> {
    // Not used
  }

  getHttpNamespace(): string {
    return "/api/replicate";
  }

  getHttpRouter(): express.Router {
    const router = express.Router();

    // GET /api/replicate/status
    router.get("/status", statusRoute(this.balancer));

    // POST /api/replicate/override
    router.post("/override", overrideRoute(this.balancer));

    // Geo‐aware toggles and region config
    router.get("/geo/status", (_req, res) => {
      res.json({
        geoAware: this.geoAware,
        localRegion: this.localRegion,
        regionConfig: this.regionConfig,
        hotThreshold: this.hotThreshold,
        defaultMinReplicas: this.defaultMinReplicas,
      });
    });

    router.post("/geo/on", (_req, res) => {
      this.geoAware = true;
      res.json({ geoAware: true, message: "Geo‐aware replication is ON" });
    });
    router.post("/geo/off", (_req, res) => {
      this.geoAware = false;
      res.json({ geoAware: false, message: "Geo‐aware replication is OFF" });
    });

    // GET /api/replicate/regions → return regionConfig
    router.get("/regions", (_req, res) => {
      res.json({ regionConfig: this.regionConfig });
    });

    // POST /api/replicate/regions → update regionConfig
    router.post("/regions", (req, res) => {
      const newConfig: RegionConfig = req.body.regionConfig;
      if (typeof newConfig !== "object" || Array.isArray(newConfig)) {
        res.status(400).json({ error: "Invalid regionConfig format" });
        return;
      }
      this.regionConfig = { ...this.regionConfig, ...newConfig };
      res.json({ regionConfig: this.regionConfig, message: "Region configuration updated." });
    });

    return router;
  }

  /**
   * Determine this node's region code by using geoip-lite's lookup.
   * We use the two‐letter country code (e.g. "US") and map to a continent key
   * if available; otherwise default to "NA".
   */
  private determineLocalRegion(): string {
    try {
      const addrs = this.context.libp2p.getMultiaddrs?.() || [];
      for (const ma of addrs) {
        // Example multiaddr: "/ip4/203.0.113.5/tcp/4001"
        const str = ma.toString();
        const parts = str.split("/");
        const idx = parts.findIndex((p: string) => p === "ip4" || p === "ip6");
        if (idx !== -1 && parts.length > idx + 1) {
          const ip = parts[idx + 1];
          const geo = geoip.lookup(ip);
          if (geo?.country) {
            const countryCode = geo.country; // e.g. "US", "FR", "CN"
            // Map a few common country→continent codes:
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
            };
            return countryToContinent[countryCode] ?? "NA";
          }
        }
      }
    } catch {
      // ignore lookup errors
    }
    return "NA";
  }
}
