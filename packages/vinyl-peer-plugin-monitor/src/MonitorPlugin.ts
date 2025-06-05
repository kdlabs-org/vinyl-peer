import {
  BasePlugin,
  PluginCapabilities,
  PluginContext,
  VinylPeerPlugin,
  FileInfo,
} from "vinyl-peer-protocol";
import { Router, Request, Response } from "express";
import client from "prom-client";

export class MonitorPlugin extends BasePlugin implements VinylPeerPlugin {
  protected context!: PluginContext;

  // Prometheus registry & metrics
  private register!: client.Registry;
  private gaugePeersConnected!: client.Gauge<string>;
  private gaugeTotalPeers!: client.Gauge<string>;
  private gaugeFileCount!: client.Gauge<string>;
  private gaugePinnedFiles!: client.Gauge<string>;
  private counterUploadsTotal!: client.Counter<string>;
  private counterDownloadsTotal!: client.Counter<string>;
  private counterErrorsTotal!: client.Counter<string>;

  // Gauges for whether certain plugins are installed (1 = yes, 0 = no)
  private pluginGauges: Record<string, client.Gauge<string>> = {};

  // ← CHANGED: use NodeJS.Timeout so clearInterval() accepts it
  private updateInterval?: NodeJS.Timeout;

  getCapabilities(): PluginCapabilities {
    return {
      name: "vinyl-peer-plugin-monitor",
      version: "0.2.0",
      protocols: [],
      capabilities: ["monitoring"],
      permissions: {
        accessFiles: true, // iterate fileDb
        useNetwork: true, // read peer list
        modifyPeers: false,
        exposeHttp: true, // expose /metrics
      },
    };
  }

  async initialize(context: PluginContext): Promise<boolean> {
    const ok = await super.initialize(context);
    if (!ok) return false;
    this.context = context;

    // 1) Create a new Prometheus registry
    this.register = new client.Registry();
    client.collectDefaultMetrics({ register: this.register });

    // 2) Define Gauges and Counters
    this.gaugePeersConnected = new client.Gauge({
      name: "vinyl_peers_connected",
      help: "Number of currently connected peers",
      registers: [this.register],
    });
    this.gaugeTotalPeers = new client.Gauge({
      name: "vinyl_total_peers",
      help: "Total number of known peers",
      registers: [this.register],
    });
    this.gaugeFileCount = new client.Gauge({
      name: "vinyl_file_count",
      help: "Number of files indexed in LevelDB",
      registers: [this.register],
    });
    this.gaugePinnedFiles = new client.Gauge({
      name: "vinyl_pinned_files",
      help: "Number of files currently pinned",
      registers: [this.register],
    });

    this.counterUploadsTotal = new client.Counter({
      name: "vinyl_uploaded_files_total",
      help: "Total number of files uploaded",
      registers: [this.register],
    });
    this.counterDownloadsTotal = new client.Counter({
      name: "vinyl_downloaded_files_total",
      help: "Total number of files downloaded",
      registers: [this.register],
    });
    this.counterErrorsTotal = new client.Counter({
      name: "vinyl_errors_total",
      help: "Total number of error events we choose to count",
      registers: [this.register],
    });

    // 3) Hook into core‐provided upload/download callbacks instead of context.on(…)
    // Whenever PluginManager notifies of a file upload/download, these methods run:
    // → increment counters in onFileUploaded() / onFileDownloaded() below.

    // 4) Create “plugin installed” gauges based on whoever is already registered
    const installed = this.context.pluginManager.getAllPlugins();
    for (const p of installed) {
      const caps = p.getCapabilities();
      const name = caps.name;
      const g = new client.Gauge({
        name: `vinyl_plugin_installed_${sanitizeMetricName(name)}`,
        help: `1 if plugin "${name}" is installed, 0 otherwise`,
        registers: [this.register],
      });
      // Set to 1 at startup for each plugin that’s already there
      g.set(1);
      this.pluginGauges[name] = g;
    }

    // —— Removed any dynamic "pluginRegister" subscription, because PluginManager
    //     does NOT expose an event emitter. If you need runtime updates, you'd have
    //     to modify Vinyl/pluginManager to explicitly broadcast a "pluginRegister" event,
    //     but out of the box there is no getContextEmitter().

    return true;
  }

  async start(): Promise<void> {
    await super.start();

    // 5) Every 10s, refresh “connected peers,” “total peers,” “file count,” “pinned count”
    this.updateInterval = setInterval(async () => {
      try {
        // ● Peers
        const peersArray = Array.from(this.context.peers.values());
        const connectedPeers = peersArray.filter((p) => p.status === "connected");
        this.gaugePeersConnected.set(connectedPeers.length);
        this.gaugeTotalPeers.set(peersArray.length);

        // ● Files + pinned
        let fileCount = 0;
        let pinnedCount = 0;
        for await (const [, info] of this.context.fileDb.iterator()) {
          fileCount++;
          if ((info as any).pinned) pinnedCount++;
        }
        this.gaugeFileCount.set(fileCount);
        this.gaugePinnedFiles.set(pinnedCount);

        // ● Ensure “plugin installed” gauges stay at 1 for any plugin that exists today (no dynamic changes)
        const nowInstalled = this.context.pluginManager
          .getAllPlugins()
          .map((p) => p.getCapabilities().name);
        for (const name of Object.keys(this.pluginGauges)) {
          this.pluginGauges[name].set(nowInstalled.includes(name) ? 1 : 0);
        }
      } catch (err) {
        console.error("[MonitorPlugin] error updating gauges:", err);
        // If you’d like to count runtime errors, uncomment the next line:
        // this.counterErrorsTotal.inc();
      }
    }, 10_000);
  }

  async stop(): Promise<void> {
    if (this.updateInterval) {
      // clearInterval now accepts a NodeJS.Timeout
      clearInterval(this.updateInterval);
    }
    await super.stop();
  }

  setupProtocols(): void {
    // No custom libp2p protocols here
  }

  async handleProtocol(_p: string, _s: any, _peerId: string): Promise<void> {
    // Not used
  }

  /**
   * Called by PluginManager when a file upload completes.
   */
  onFileUploaded(_cid: string, _fileInfo: FileInfo): void {
    this.counterUploadsTotal.inc();
  }

  /**
   * Called by PluginManager when a file download completes.
   */
  onFileDownloaded(_cid: string): void {
    this.counterDownloadsTotal.inc();
  }

  getHttpNamespace(): string {
    return "/api/monitor";
  }

  getHttpRouter(): Router {
    const router = Router();

    // GET /api/monitor/metrics → expose Prometheus metrics
    router.get("/metrics", async (_req: Request, res: Response) => {
      try {
        res.setHeader("Content-Type", this.register.contentType);
        const metrics = await this.register.metrics();
        res.send(metrics);
      } catch (err: any) {
        console.error("[MonitorPlugin] /metrics error:", err);
        this.counterErrorsTotal.inc();
        res.status(500).send(err.message);
      }
    });

    return router;
  }
}

/**
 * Replace any invalid characters so that Prometheus‐style metric names stay valid.
 * E.g. "vinyl-peer-plugin-foo" → "vinyl_peer_plugin_foo"
 */
function sanitizeMetricName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}
