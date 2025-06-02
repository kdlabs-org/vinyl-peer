import express, { Request, Response, Router } from "express";
import {
  BasePlugin,
  PluginCapabilities,
  PluginContext,
  VinylPeerPlugin,
} from "vinyl-peer-protocol";

export class ReplicationPlugin extends BasePlugin implements VinylPeerPlugin {
  // We widen visibility to `protected` so that it matches BasePlugin
  protected context!: PluginContext;
  private enabled: boolean = true; // Auto‐replication (auto‐pin) is ON by default

  constructor() {
    super();
  }

  /**
   * Declare plugin identity, capabilities, and required permissions.
   * This plugin exposes HTTP routes for toggling replication.
   */
  getCapabilities(): PluginCapabilities {
    return {
      name: "vinyl-peer-replication-plugin",
      version: "1.0.0",
      protocols: [], // no custom libp2p protocols
      capabilities: ["replication"],
      fileTypes: [], // applies to any file type
      permissions: {
        accessFiles: true, // needed to call pinFile()
        useNetwork: false,
        modifyPeers: false,
        exposeHttp: true, // since we expose HTTP endpoints
      },
    };
  }

  /**
   * Standard initialize; store context and mark as initialized.
   * We rely on PluginContext to provide pinFile/unpinFile methods.
   */
  async initialize(context: PluginContext): Promise<boolean> {
    const ok = await super.initialize(context);
    if (!ok) return false;
    this.context = context;
    return true;
  }

  /**
   * No libp2p protocols to set up, so this is a no‐op.
   */
  setupProtocols(): void {
    // no‐op
  }

  /**
   * Required by BasePlugin/VinylPeerPlugin interface, but unused here.
   */
  async handleProtocol(protocol: string, stream: any, peerId: string): Promise<void> {
    // no‐op
  }

  /**
   * Called by PluginManager whenever any file is downloaded.
   * If auto‐replication is enabled, immediately pin the given CID.
   */
  onFileDownloaded?(cid: string): void {
    if (!this.enabled) {
      console.log(`ReplicationPlugin: auto‐replication is OFF, skipping pin for "${cid}".`);
      return;
    }

    // Attempt to pin via context.pinFile(...)
    this.context
      .pinFile(cid)
      .then(() => {
        console.log(`ReplicationPlugin: automatically pinned "${cid}".`);
      })
      .catch((err) => {
        console.error(`ReplicationPlugin: failed to pin "${cid}":`, err);
      });
  }

  /**
   * Declare the HTTP namespace under which this plugin will mount its routes.
   */
  getHttpNamespace(): string {
    return "/replication";
  }

  /**
   * Return an Express.Router containing three endpoints:
   *   • GET  /replication/status → { enabled: boolean }
   *   • POST /replication/on     → turn auto‐replication ON
   *   • POST /replication/off    → turn auto‐replication OFF
   */
  getHttpRouter(): Router {
    const router = express.Router();

    // GET /replication/status
    router.get("/status", (req: Request, res: Response) => {
      res.json({ enabled: this.enabled });
    });

    // POST /replication/on
    router.post("/on", (req: Request, res: Response) => {
      this.enabled = true;
      console.log("ReplicationPlugin: auto‐replication turned ON.");
      res.json({ enabled: true, message: "Auto‐replication is now ON." });
    });

    // POST /replication/off
    router.post("/off", (req: Request, res: Response) => {
      this.enabled = false;
      console.log("ReplicationPlugin: auto‐replication turned OFF.");
      res.json({ enabled: false, message: "Auto‐replication is now OFF." });
    });

    return router;
  }
}
