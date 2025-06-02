import express, { Router } from "express";
import {
  BasePlugin,
  PluginCapabilities,
  PluginContext,
  VinylPeerPlugin,
} from "vinyl-peer-protocol";

interface ReplicationOptions {
  autoPinLocal?: boolean; // pin when *this* node downloads
  autoPinRemote?: boolean; // pin when *other* nodes announce
  topic?: string; // pubsub topic (defaults to "vinyl:replicate")
}

export class ReplicationPlugin extends BasePlugin implements VinylPeerPlugin {
  protected context!: PluginContext;
  private enabled: boolean = true;
  private readonly TOPIC: string;
  private autoPinLocal: boolean;
  private autoPinRemote: boolean;

  constructor(opts: ReplicationOptions = {}) {
    super();
    this.autoPinLocal = opts.autoPinLocal ?? true;
    this.autoPinRemote = opts.autoPinRemote ?? true;
    this.TOPIC = opts.topic ?? "vinyl:replicate";
  }

  getCapabilities(): PluginCapabilities {
    return {
      name: "vinyl-peer-replication-plugin",
      version: "1.0.0",
      protocols: [],
      capabilities: ["replication"],
      fileTypes: [],
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

    // Only subscribe to remote‐replicate messages if configured:
    if (this.autoPinRemote) {
      try {
        await this.context.libp2p.pubsub.subscribe(this.TOPIC);
        this.context.libp2p.pubsub.addEventListener("message", (evt: any) => {
          if (evt.detail.topic !== this.TOPIC) return;
          try {
            const msg = JSON.parse(new TextDecoder().decode(evt.detail.data));
            if (msg.type === "replicate" && this.enabled) {
              const cid = msg.cid as string;
              // If we already have it, skip:
              if (!this.context.files.has(cid)) {
                this.context.pinFile(cid).catch((err) => {
                  console.error(`ReplicationPlugin: failed to pin ${cid}:`, err);
                });
              }
            }
          } catch {
            /* ignore invalid JSON */
          }
        });
      } catch (err: any) {
        console.error("ReplicationPlugin: could not subscribe to replication topic:", err);
      }
    }

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

  onFileDownloaded?(cid: string): void {
    // Only auto‐pin locally if configured:
    if (this.autoPinLocal && this.enabled) {
      this.context
        .pinFile(cid)
        .then(() => {
          console.log(`ReplicationPlugin: automatically pinned "${cid}".`);
        })
        .catch((err) => {
          console.error(`ReplicationPlugin: failed to pin "${cid}":`, err);
        });
    }

    // Only broadcast to remote peers if configured:
    if (this.autoPinRemote && this.enabled) {
      const payload = JSON.stringify({ type: "replicate", cid });
      this.context.libp2p.pubsub
        .publish(this.TOPIC, new TextEncoder().encode(payload))
        .catch((e: any) => console.error("ReplicationPlugin: pubsub error:", e));
    }
  }

  getHttpNamespace(): string {
    return "/replication";
  }

  getHttpRouter(): Router {
    const router = express.Router();

    router.get("/status", (_req, res) => {
      res.json({
        enabled: this.enabled,
        autoPinLocal: this.autoPinLocal,
        autoPinRemote: this.autoPinRemote,
      });
    });

    router.post("/on", (_req, res) => {
      this.enabled = true;
      res.json({ enabled: true, message: "Auto-replication is now ON." });
    });

    router.post("/off", (_req, res) => {
      this.enabled = false;
      res.json({ enabled: false, message: "Auto-replication is now OFF." });
    });

    return router;
  }
}
