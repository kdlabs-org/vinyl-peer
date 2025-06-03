import express, { Router } from "express";
import { BasePlugin } from "vinyl-peer-protocol";

export class ReplicationPlugin extends BasePlugin {
  private enabled: boolean;
  private autoPinLocal: boolean;
  private autoPinRemote: boolean;
  private TOPIC: string;
  protected context!: any;

  constructor(
    opts: {
      autoPinLocal?: boolean;
      autoPinRemote?: boolean;
      topic?: string;
    } = {},
  ) {
    super();
    this.enabled = true;
    this.autoPinLocal = opts.autoPinLocal ?? true;
    this.autoPinRemote = opts.autoPinRemote ?? true;
    this.TOPIC = opts.topic ?? "vinyl:replicate";
  }

  getCapabilities() {
    return {
      name: "vinyl-peer-plugin-replication",
      version: "0.0.1",
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

  async initialize(context: any): Promise<boolean> {
    const ok = await super.initialize(context);
    if (!ok) return false;
    this.context = context;
    return true;
  }

  /**
   * Now that libp2p is started, we can safely subscribe to pubsub.
   */
  async start(): Promise<void> {
    await super.start();

    if (this.autoPinRemote) {
      try {
        // In recent libp2p, the pubsub service is under libp2p.services.pubsub
        const pubsub = this.context.libp2p.services.pubsub;
        if (!pubsub) {
          throw new Error("ReplicationPlugin: pubsub service is not available on libp2p");
        }

        // Subscribe to the replication topic
        await pubsub.subscribe(this.TOPIC);
        pubsub.addEventListener("message", (evt: any) => {
          if (evt.detail.topic !== this.TOPIC) return;

          try {
            const msg = JSON.parse(new TextDecoder().decode(evt.detail.data));
            if (msg.type === "replicate" && this.enabled) {
              const cid = msg.cid as string;
              // If we don’t already have this file locally, pin it
              if (!this.context.files.has(cid)) {
                this.context.pinFile(cid).catch((err: any) => {
                  console.error(`ReplicationPlugin: failed to pin ${cid}:`, err);
                });
              }
            }
          } catch {
            // Ignore invalid JSON
          }
        });
      } catch (err) {
        console.error("ReplicationPlugin: kon niet subscriben op replication topic:", err);
      }
    }
  }

  async stop(): Promise<void> {
    // (Optionally you could “unsubscribe,” but libp2p’s current pubsub API doesn’t expose an unsubscribe call.)
    this.enabled = false;
    await super.stop();
  }

  setupProtocols(): void {
    // no custom libp2p-protocols here
  }

  async handleProtocol(protocol: string, stream: any, peerId: string) {
    // no custom protocol handler
  }

  onFileDownloaded(cid: string): void {
    // 1) If autoPinLocal is on, pin locally
    if (this.autoPinLocal && this.enabled) {
      this.context
        .pinFile(cid)
        .then(() => console.log(`ReplicationPlugin: automatisch gepinned "${cid}".`))
        .catch((err: any) => console.error(`ReplicationPlugin: kon niet pinnen "${cid}":`, err));
    }

    // 2) If autoPinRemote is on, broadcast to peers so they can pin as well
    if (this.autoPinRemote && this.enabled) {
      const pubsub = this.context.libp2p.services.pubsub;
      if (!pubsub) {
        console.error("ReplicationPlugin: pubsub service unavailable when broadcasting");
        return;
      }

      const payload = JSON.stringify({ type: "replicate", cid });
      pubsub
        .publish(this.TOPIC, new TextEncoder().encode(payload))
        .catch((e: any) => console.error("ReplicationPlugin: pubsub error:", e));
    }
  }

  getHttpNamespace(): string {
    return "/api/replication";
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
