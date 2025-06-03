import express, { Router } from "express";
import multer from "multer";
import {
  BasePlugin,
  PluginCapabilities,
  PluginContext,
  VinylPeerPlugin,
} from "vinyl-peer-protocol";
import { Level } from "level";
import path from "path";

import uploadRoute from "./routes/upload.js";
import recoverRoute from "./routes/recover.js";
import type { RSManifest } from "./types.js";

export class ReedSolomonPlugin extends BasePlugin implements VinylPeerPlugin {
  protected context!: PluginContext;
  private rsDb!: Level<string, RSManifest>;
  private upload: multer.Multer;

  constructor() {
    super();
    // Use in-memory storage for shards upload
    this.upload = multer({ storage: multer.memoryStorage() });
  }

  getCapabilities(): PluginCapabilities {
    return {
      name: "vinyl-peer-plugin-rs",
      version: "0.0.1",
      protocols: [], // no custom libp2p protocols
      capabilities: ["storage"],
      permissions: {
        accessFiles: true, // may read core fileDb if needed
        useNetwork: true, // needs Helia/IPFS access
        modifyPeers: false,
        exposeHttp: true, // will expose HTTP under /api/rs
      },
    };
  }

  async initialize(context: PluginContext): Promise<boolean> {
    const ok = await super.initialize(context);
    if (!ok) return false;

    this.context = context;
    // Create a LevelDB directory under ./rs-manifests (relative to CWD)
    const rsFolder = path.join(process.cwd(), "rs-manifests");
    this.rsDb = new Level<string, RSManifest>(rsFolder, { valueEncoding: "json" });
    return true;
  }

  async start(): Promise<void> {
    await super.start();
    // No additional libp2p logic on start
  }

  async stop(): Promise<void> {
    await this.rsDb.close();
    await super.stop();
  }

  setupProtocols(): void {
    // No custom libp2p protocols
  }

  async handleProtocol(_protocol: string, _stream: any, _peerId: string): Promise<void> {
    // Not used
  }

  getHttpNamespace(): string {
    return "/api/rs";
  }

  /**
   * Mount two routes:
   *   - POST /api/rs/upload  → multer, then uploadRoute
   *   - GET  /api/rs/recover/:id → recoverRoute
   */
  getHttpRouter(): Router {
    const router = Router();

    // 1) Upload
    router.post(
      "/upload",
      this.upload.single("file"), // multer middleware to populate req.file
      uploadRoute(this.context, this.rsDb),
    );

    // 2) Recover
    router.get("/recover/:id", recoverRoute(this.context, this.rsDb));

    return router;
  }

  /**
   * Programmatic “store” method for other plugins (if needed):
   * - Accepts a Buffer, encodes into shards, writes manifest to rsDb
   */
  async store(
    buffer: Buffer,
    opts: { filename: string; mimeType: string; dataShards?: number; parityShards?: number },
  ): Promise<{ manifestId: string }> {
    const dataShards = opts.dataShards ?? 6;
    const parityShards = opts.parityShards ?? 3;

    // Dynamically import encoder helper
    const { encodeFileToShards } = await import("./utils/encoder.js");
    const { manifest } = await encodeFileToShards(buffer, {
      dataShards,
      parityShards,
      filename: opts.filename,
      mimeType: opts.mimeType,
      helia: this.context.helia,
    });

    const manifestId = `${this.context.nodeId}-${Date.now()}`;
    await this.rsDb.put(manifestId, manifest);
    return { manifestId };
  }

  /**
   * Programmatic “retrieve” method for other plugins:
   * - Reads manifest, decodes all shards (via decoder helper), returns Buffer
   */
  async retrieve(manifestId: string): Promise<Buffer> {
    const { decodeShardsToFile } = await import("./utils/decoder.js");
    const manifest = await this.rsDb.get(manifestId);
    return decodeShardsToFile(manifest, this.context.helia);
  }
}
