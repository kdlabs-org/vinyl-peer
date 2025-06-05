import { Router, Request, Response } from "express";
import multer from "multer";
import {
  BasePlugin,
  PluginCapabilities,
  PluginContext,
  VinylPeerPlugin,
} from "vinyl-peer-protocol";
import { Level } from "level";
import path from "path";
import type { AdvancedManifest, ShardIndexEntry } from "./types.js";
import { encodeFileToAdvancedShards } from "./utils/encoder.js";
import { decodeAdvancedShardsToFile } from "./utils/decoder.js";
import { startAutoRepair } from "./utils/autoRepair.js";
import configRoute from "./routes/config.js";
import statusRoute from "./routes/status.js";

// Create a multer instance for handling `multipart/form-data` uploads
const upload = multer({ storage: multer.memoryStorage() });

export class AdvancedShardingPlugin extends BasePlugin implements VinylPeerPlugin {
  protected context!: PluginContext;
  private advDb!: Level<string, AdvancedManifest>;

  // Use ReturnType<typeof setInterval> so TypeScript understands it matches NodeJS.Timeout
  private autoRepairTimer!: ReturnType<typeof setInterval>;

  getCapabilities(): PluginCapabilities {
    return {
      name: "vinyl-peer-plugin-advanced-sharding",
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

    // 1) Create a LevelDB under ./adv-shard-manifests
    const folder = path.join(process.cwd(), "adv-shard-manifests");
    this.advDb = new Level<string, AdvancedManifest>(folder, { valueEncoding: "json" });

    return true;
  }

  async start(): Promise<void> {
    await super.start();

    // 2) Begin auto‐repair loop every 300s by default
    const defaultInterval = 300; // seconds

    this.autoRepairTimer = global.setInterval(() => {
      startAutoRepair(
        this.context.helia,
        this.advDb,
        async (entry: ShardIndexEntry) => {
          // Append to matching manifest’s index
          for await (const [id, manifest] of this.advDb.iterator()) {
            if (manifest.chunks.some((c) => c.shards.find((s) => s.cid === entry.shardCid))) {
              manifest.shardIndex.push(entry);
              try {
                await this.advDb.put(id, manifest);
              } catch (err) {
                console.error("[AdvancedSharding] failed to update shardIndex in DB:", err);
              }
              break;
            }
          }
        },
        // Provide per-manifest override settings; must return all required fields
        async (_manifestId: string) => {
          return {
            dataShards: 0,
            parityShards: 0,
            minReplicas: 0,
            autoRepairIntervalSeconds: defaultInterval,
          };
        },
        defaultInterval,
      );
    }, defaultInterval * 1000);
  }

  async stop(): Promise<void> {
    clearInterval(this.autoRepairTimer);
    await this.advDb.close();
    await super.stop();
  }

  setupProtocols(): void {
    // No libp2p protocols needed
  }

  async handleProtocol(_p: string, _s: any, _peerId: string): Promise<void> {
    // No custom protocol handling
  }

  getHttpNamespace(): string {
    return "/api/adv-shard";
  }

  getHttpRouter(): Router {
    const router = Router();

    // POST /api/adv-shard/upload
    router.post("/upload", upload.single("file"), async (req: Request, res: Response) => {
      const file = (req as any).file as Express.Multer.File;
      if (!file || !file.buffer) {
        res.status(400).json({ error: "Missing file" });
        return;
      }
      const dataShards = parseInt(req.body.dataShards) || 6;
      const parityShards = parseInt(req.body.parityShards) || 3;
      const shardSize = parseInt(req.body.shardSize) || 64 * 1024;

      try {
        const { manifest } = await encodeFileToAdvancedShards(file.buffer, {
          dataShards,
          parityShards,
          filename: file.originalname,
          mimeType: file.mimetype || "application/octet-stream",
          helia: this.context.helia,
          ownerPeer: (this.context.helia as any).libp2p.peerId.toString(),
          putShardIndex: async (entry) => {
            // Immediately update each matching manifest’s index
            await manifestShardIndex(this.advDb, entry);
          },
          config: { shardSize },
        });

        const manifestId = `${this.context.nodeId}-${Date.now()}`;
        await this.advDb.put(manifestId, manifest);
        res.json({ id: manifestId, chunks: manifest.chunks });
      } catch (err) {
        console.error("[adv-shard] upload error:", err);
        res.status(500).json({ error: "Upload/encoding failed" });
      }
    });

    // GET /api/adv-shard/recover/:id
    router.get("/recover/:id", async (req: Request, res: Response) => {
      const id = req.params.id;
      let manifest: AdvancedManifest;
      try {
        manifest = await this.advDb.get(id);
      } catch {
        res.status(404).json({ error: `Manifest ${id} not found` });
        return;
      }

      try {
        const fileBuf = await decodeAdvancedShardsToFile(manifest, this.context.helia);
        res.setHeader("Content-Type", manifest.mimeType);
        res.setHeader("Content-Disposition", `attachment; filename="${manifest.filename}"`);
        res.send(fileBuf);
      } catch (err) {
        console.error("[adv-shard] recover error:", err);
        res.status(500).json({ error: "Recovery failed" });
      }
    });

    // Mount config & status routes
    router.use(configRoute(this.context));
    router.get("/status/:id", statusRoute(this.context, this.advDb));

    return router;
  }
}

/**
 * Helper: when a new ShardIndexEntry arrives, append it to the matching manifest’s index.
 */
async function manifestShardIndex(advDb: Level<string, AdvancedManifest>, entry: ShardIndexEntry) {
  for await (const [id, manifest] of advDb.iterator()) {
    if (manifest.chunks.some((c) => c.shards.find((s) => s.cid === entry.shardCid))) {
      manifest.shardIndex.push(entry);
      try {
        await advDb.put(id, manifest);
      } catch (err) {
        console.error("[AdvancedSharding] manifestShardIndex put failed:", err);
      }
      break;
    }
  }
}
