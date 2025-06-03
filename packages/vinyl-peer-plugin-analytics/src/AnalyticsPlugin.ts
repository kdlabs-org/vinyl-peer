import express, { Request, Response, Router } from "express";
import {
  BasePlugin,
  PluginCapabilities,
  PluginContext,
  VinylPeerPlugin,
} from "vinyl-peer-protocol";
import { FileInfo } from "vinyl-peer-protocol";
import { AnalyticsSnapshot } from "./types.js";

export class AnalyticsPlugin extends BasePlugin implements VinylPeerPlugin {
  protected context!: PluginContext;
  private snapshotIntervalMs: number = 60000; // 1 minute
  private intervalHandle: NodeJS.Timeout | null = null;
  private lastSnapshot: AnalyticsSnapshot | null = null;

  constructor(snapshotIntervalMs?: number) {
    super();
    if (snapshotIntervalMs) {
      this.snapshotIntervalMs = snapshotIntervalMs;
    }
  }

  /** Identify plugin; no libp2p protocols needed here. */
  getCapabilities(): PluginCapabilities {
    return {
      name: "vinyl-peer-plugin-analytics",
      version: "0.0.1",
      protocols: [], // No custom libp2p protocols
      capabilities: ["analytics"],
      fileTypes: [],
      permissions: {
        accessFiles: true,
        useNetwork: false,
        modifyPeers: false,
        exposeHttp: true,
      },
    };
  }

  /** Standard initialize; store context. */
  async initialize(context: PluginContext): Promise<boolean> {
    const ok = await super.initialize(context);
    if (!ok) return false;
    this.context = context;
    return true;
  }

  /** Start periodic snapshotting. */
  async start(): Promise<void> {
    if (!this.context) {
      throw new Error("AnalyticsPlugin: missing context");
    }
    // Immediately take one snapshot
    this.takeSnapshot();
    // Then schedule periodic snapshots
    this.intervalHandle = setInterval(() => {
      this.takeSnapshot();
    }, this.snapshotIntervalMs);
    this.isStarted = true;
  }

  /** Stop the interval. */
  async stop(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.isStarted = false;
    await super.stop();
  }

  /** No libp2p protocols to register. */
  setupProtocols(): void {
    // no-op
  }

  /** No incoming protocol streams to handle. */
  async handleProtocol(protocol: string, stream: any, peerId: string): Promise<void> {
    // no-op
  }

  /**
   * Periodically create an AnalyticsSnapshot and emit it.
   */
  private takeSnapshot(): void {
    if (!this.context) return;
    const totalPeers = this.context.peers.size;
    const totalConnectedPeers = Array.from(this.context.peers.values()).filter(
      (p) => p.status === "connected",
    ).length;
    const totalFiles = this.context.files.size;
    const musicFiles = Array.from(this.context.files.values()).filter((f: FileInfo) =>
      f.type.startsWith("audio/"),
    ).length;
    const totalPinCount = Array.from(this.context.files.values()).filter(
      (f) => f.pinned === true,
    ).length;

    const snapshot: AnalyticsSnapshot = {
      timestamp: new Date().toISOString(),
      totalPeers,
      totalConnectedPeers,
      totalFiles,
      totalMusicFiles: musicFiles,
      totalPinCount,
    };

    this.lastSnapshot = snapshot;
    this.emit("analyticsSnapshot", snapshot);
  }

  /**
   * Return the HTTP namespace for analytics routes.
   */
  getHttpNamespace(): string {
    return "/api/analytics";
  }

  /**
   * Return an Express.Router exposing analytics endpoints:
   *  - GET /api/analytics/snapshot
   *  - GET /api/analytics/top-file-types
   */
  getHttpRouter(): Router {
    const router = express.Router();

    // GET /api/analytics/snapshot → returns last snapshot
    router.get("/snapshot", (req: Request, res: Response) => {
      try {
        if (!this.lastSnapshot) {
          res.status(404).json({ error: "No snapshot available yet" });
          return;
        }
        res.json({ snapshot: this.lastSnapshot });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // GET /api/analytics/top-file-types → returns top 10 file types by count
    router.get("/top-file-types", (req: Request, res: Response) => {
      try {
        if (!this.context) {
          res.status(500).json({ error: "AnalyticsPlugin: context not available" });
          return;
        }
        const typeCounts: Map<string, number> = new Map();
        for (const file of Array.from(this.context.files.values())) {
          const t = file.type;
          typeCounts.set(t, (typeCounts.get(t) || 0) + 1);
        }
        const sorted = Array.from(typeCounts.entries())
          .map(([type, count]) => ({ type, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10);
        res.json({ topFileTypes: sorted });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    return router;
  }
}
