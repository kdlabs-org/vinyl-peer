import type { Request, Response, Router } from "express";
import {
  BasePlugin,
  PluginCapabilities,
  PluginContext,
  VinylPeerPlugin,
} from "vinyl-peer-protocol";
import { Level } from "level";
import express from "express";

/**
 * Vinyl Peer Name Service (VPNS) Plugin
 *
 * - Provides a decentralized mapping from human‐readable names → Peer IDs
 * - Registers and resolves names via HTTP endpoints
 * - Propagates name registrations over PubSub so peers keep their local DB in sync
 * - Supports listing all known name records
 */

export interface NameRecord {
  name: string; // e.g. "alice.vinyl"
  peerId: string; // libp2p PeerId string
  owner: string; // PeerId of the registrar
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
}

export interface NameEvent {
  type: "register" | "update" | "delete";
  record: NameRecord;
}

export class NameServicePlugin extends BasePlugin implements VinylPeerPlugin {
  protected context!: PluginContext;
  private nameDb!: Level<string, NameRecord>;
  private readonly PUBSUB_TOPIC = "/vns/registry/1.0.0";

  getCapabilities(): PluginCapabilities {
    return {
      name: "vinyl-peer-plugin-nameservice",
      version: "0.0.1",
      protocols: [],
      capabilities: ["nameservice"],
      permissions: {
        accessFiles: false,
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

    // Create a LevelDB under ./vns-records
    this.nameDb = new Level<string, NameRecord>("vns-records", { valueEncoding: "json" });

    return true;
  }

  async start(): Promise<void> {
    await super.start();

    // Subscribe to PubSub for name events
    const ps = (this.context.libp2p as any).pubsub ?? (this.context.libp2p as any).services?.pubsub;
    if (!ps) {
      throw new Error("VinylPeerNameServicePlugin: PubSub service not available");
    }

    await ps.subscribe(this.PUBSUB_TOPIC);
    ps.addEventListener("message", async (evt: any) => {
      const msg = new TextDecoder().decode(evt.detail.data);
      try {
        const event: NameEvent = JSON.parse(msg);
        const key = event.record.name;
        if (event.type === "register" || event.type === "update") {
          await this.nameDb.put(key, event.record);
        } else if (event.type === "delete") {
          await this.nameDb.del(key).catch(() => {});
        }
      } catch {
        // ignore malformed messages
      }
    });
  }

  async stop(): Promise<void> {
    await this.nameDb.close();
    await super.stop();
  }

  setupProtocols(): void {
    // No custom libp2p protocols needed (we use PubSub)
  }

  async handleProtocol(_protocol: string, _stream: any, _peerId: string): Promise<void> {
    // No custom protocol handlers
  }

  getHttpNamespace(): string {
    return "/api/vns";
  }

  getHttpRouter(): Router {
    const router = express.Router();
    router.use(express.json());

    // Register or update a name
    // POST /api/vns/register
    // Body: { name: string, peerId: string }
    router.post("/register", async (req: Request, res: Response) => {
      try {
        const { name, peerId } = req.body as { name: string; peerId: string };
        if (typeof name !== "string" || typeof peerId !== "string") {
          res.status(400).json({ error: "Invalid payload: name and peerId are required" });
          return;
        }

        // Check if name is already taken by a different owner
        const existing = await this.nameDb.get(name).catch(() => null);
        const now = new Date().toISOString();
        let record: NameRecord;

        if (!existing) {
          // New registration
          record = {
            name,
            peerId,
            owner: peerId,
            createdAt: now,
            updatedAt: now,
          };
        } else {
          // Only owner can update
          if (existing.owner !== peerId) {
            res.status(403).json({ error: "Name already registered by another peer" });
            return;
          }
          record = {
            ...existing,
            peerId,
            updatedAt: now,
          };
        }

        await this.nameDb.put(name, record);

        // Broadcast registration/update event
        const event: NameEvent = { type: existing ? "update" : "register", record };
        const ps =
          (this.context.libp2p as any).pubsub ?? (this.context.libp2p as any).services?.pubsub;
        await ps.publish(this.PUBSUB_TOPIC, new TextEncoder().encode(JSON.stringify(event)));

        res.json({ success: true, record });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // Resolve a name to a PeerId
    // GET /api/vns/resolve/:name
    router.get("/resolve/:name", async (req: Request, res: Response) => {
      try {
        const name = req.params.name;
        const record = await this.nameDb.get(name).catch(() => null);
        if (!record) {
          res.status(404).json({ error: "Name not found" });
          return;
        }
        res.json({ peerId: record.peerId, record });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // Delete a name (only owner allowed)
    // DELETE /api/vns/delete/:name
    // Body: { owner: string }
    router.delete("/delete/:name", async (req: Request, res: Response) => {
      try {
        const name = req.params.name;
        const { owner } = req.body as { owner: string };
        if (typeof owner !== "string") {
          res.status(400).json({ error: "Invalid payload: owner is required" });
          return;
        }
        const existing = await this.nameDb.get(name).catch(() => null);
        if (!existing) {
          res.status(404).json({ error: "Name not found" });
          return;
        }
        if (existing.owner !== owner) {
          res.status(403).json({ error: "Only the owner may delete this name" });
          return;
        }
        await this.nameDb.del(name);

        // Broadcast delete event
        const event: NameEvent = { type: "delete", record: existing };
        const ps =
          (this.context.libp2p as any).pubsub ?? (this.context.libp2p as any).services?.pubsub;
        await ps.publish(this.PUBSUB_TOPIC, new TextEncoder().encode(JSON.stringify(event)));

        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // List all name records
    // GET /api/vns/list
    router.get("/list", async (_req: Request, res: Response) => {
      try {
        const records: NameRecord[] = [];
        for await (const [, rec] of this.nameDb.iterator()) {
          records.push(rec);
        }
        res.json({ records });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    return router;
  }
}
