import { createLibp2p } from "libp2p";
import { webSockets } from "@libp2p/websockets";
import { webRTC } from "@libp2p/webrtc";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { kadDHT } from "@libp2p/kad-dht";
import { ping } from "@libp2p/ping";
import { bootstrap } from "@libp2p/bootstrap";
import { createHelia } from "helia";
import { unixfs } from "@helia/unixfs";

import { LevelBlockstore } from "blockstore-level";
import { Level } from "level";

import { v4 as uuidv4 } from "uuid";
import { PluginManager } from "./PluginManager.js";
import { PluginContext, VinylPeerPlugin } from "./PluginInterface.js";
import { PluginPermissions } from "./types.js";
import {
  PeerInfo,
  FileInfo,
  NetworkFileInfo,
  NodeStats,
  StorageMode,
  UploadFile,
} from "./types.js";

import crypto from "crypto";
import fs from "fs";
import path from "path";
import http from "http";

import express, { Express, Request, Response } from "express";
import multer from "multer";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import mime from "mime-types";

import { fileURLToPath } from "url";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Schema for event‐envelope validation ----------
const BaseEnvelopeSchema = z.object({
  source: z.string(),
  payload: z.any(),
});

function validateEventEnvelope(envelope: any): boolean {
  try {
    BaseEnvelopeSchema.parse(envelope);
    return true;
  } catch {
    return false;
  }
}

export class Vinyl {
  // --- Core libp2p & IPFS/Helia instances ---
  private libp2p: any = null;
  private helia: any = null;
  private fs: any = null;
  private nodeStarted: boolean = false;

  // Unique node identifier
  private nodeId: string;

  // In‐memory maps of peers, streaming blobs, and network‐advertised files
  private peers: Map<string, PeerInfo> = new Map();
  private streamingFiles: Map<string, Uint8Array> = new Map();
  private networkFiles: Map<string, NetworkFileInfo> = new Map();

  // Persisted file index (metadata CIDs → FileInfo) on LevelDB
  private fileDb!: Level<string, FileInfo>;

  // Set of CIDs that have been pinned locally
  private pinnedFiles: Set<string> = new Set();

  // Allowed origins for CORS (default: allow all)
  private origin: string[] = [];

  /**
   * PLUGIN + NODE EVENT BUS:
   * An array of callbacks (eventName, { source, payload }).
   */
  private listeners: ((event: string, envelope: { source: string; payload: any }) => void)[] = [];

  // AES‐GCM CryptoKey versions map
  private cryptoKeys: Map<number, CryptoKey> = new Map();
  private currentKeyVersion: number = 0;

  // HMAC key for audit logging
  private auditKey: Buffer = crypto.randomBytes(32);
  private auditLogPath: string = path.join(__dirname, "vinyl-audit.log");

  // “Current” encryption key
  private encryptionKey: CryptoKey | null = null;

  // Whether local IPFS storage is enabled (Helia)
  private localStorageEnabled: boolean = true;

  // Plugin framework
  private pluginManager: PluginManager;
  private pluginInstances: VinylPeerPlugin[];
  private nodePermissions: PluginPermissions;

  // ─── HTTP server for core + plugins ───
  private httpApp: Express;
  private httpServer: http.Server | null = null;
  private upload: multer.Multer;
  private recentEvents: { event: string; data: any; timestamp: number }[] = [];

  constructor(plugins: VinylPeerPlugin[] = [], globalPermissions?: PluginPermissions) {
    // Generate a UUID to identify this node (if libp2p fails, fallback to this)
    this.nodeId = uuidv4();

    // Default global permissions: full trust
    this.nodePermissions = globalPermissions || {
      accessFiles: true,
      useNetwork: true,
      modifyPeers: true,
      exposeHttp: true,
    };

    this.pluginManager = new PluginManager();
    this.pluginInstances = plugins;

    // ─────────── Initialize Express & Multer ───────────
    this.httpApp = express();
    this.upload = multer({ storage: multer.memoryStorage() });
    this.setupMiddleware();
    this.setupCoreRoutes();
    this.setupEventSSE();
  }

  /**
   * Helper to detect if running in a browser (window+document exist).
   */
  private isBrowser(): boolean {
    return typeof window !== "undefined" && typeof window.document !== "undefined";
  }

  /**
   * Return a static list of libp2p bootstrap node multiaddresses.
   */
  private getBootstrapNodes(): string[] {
    return [
      "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
      "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
      "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zp9qUGqUvs9TGjLiw4Xs9q3t4F4bVR",
      "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
    ];
  }

  /**
   * Build transports and listen addresses based on environment:
   *  - Browser: WebRTC, WebSockets, circuit relay.
   *  - Node.js: TCP, WebSockets, circuit relay.
   */
  private async getTransportsAndAddresses(): Promise<{
    transports: any[];
    addresses: { listen: string[] };
  }> {
    if (this.isBrowser()) {
      return {
        addresses: { listen: ["/webrtc"] },
        transports: [webSockets(), webRTC(), circuitRelayTransport()],
      };
    } else {
      const { tcp } = await import("@libp2p/tcp");
      return {
        addresses: {
          listen: ["/ip4/0.0.0.0/tcp/0", "/ip4/0.0.0.0/tcp/0/ws"],
        },
        transports: [tcp(), webSockets(), circuitRelayTransport()],
      };
    }
  }

  /**
   * Build peer discovery services (bootstrap + optionally mDNS in Node).
   */
  private async getPeerDiscoveryServices(): Promise<Record<string, any>> {
    const services: Record<string, any> = {};

    // Bootstrap service
    try {
      services.bootstrap = bootstrap({ list: this.getBootstrapNodes() });
    } catch (err) {
      console.warn("Vinyl: bootstrap not available:", err);
    }

    // mDNS (Node.js only)
    if (!this.isBrowser()) {
      try {
        const { mdns } = await import("@libp2p/mdns");
        services.mdns = mdns({ interval: 1000 });
      } catch (err) {
        console.warn("Vinyl: mDNS not available:", err);
      }
    }

    return services;
  }

  private setupMiddleware(): void {
    this.httpApp.use(cors());
    this.httpApp.use(express.json());
    this.httpApp.use(express.static("public"));
  }

  /**
   * Register core HTTP routes for status, peers, files, upload/download, etc.
   */
  private setupCoreRoutes(): void {
    // ─── Node status ───
    this.httpApp.get("/api/status", (req: Request, res: Response) => {
      try {
        const stats = this.getNodeStats();
        res.json({
          status: "ok",
          nodeId: stats.id,
          isRunning: this.nodeStarted === true, // this.libp2p?.isStarted === true,
          stats,
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.httpApp.get("/api/plugins", (req: Request, res: Response) => {
      try {
        const allPlugins = this.pluginManager.getAllPlugins();
        const info = allPlugins.map((p: VinylPeerPlugin) => {
          const caps = p.getCapabilities();
          return {
            name: caps.name,
            version: caps.version,
            protocols: caps.protocols,
            capabilities: caps.capabilities,
          };
        });
        res.json(info);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // ─── Peer list ───
    this.httpApp.get("/api/peers", (req: Request, res: Response) => {
      try {
        res.json(this.getPeers());
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // ─── File list ─── (reads from LevelDB)
    this.httpApp.get("/api/files", async (req: Request, res: Response) => {
      try {
        const files: FileInfo[] = [];
        // LevelDB supports async iteration
        for await (const [cid, info] of this.fileDb.iterator()) {
          files.push(info);
        }
        res.json(files);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // ─── Upload ───
    this.httpApp.post(
      "/api/upload",
      this.upload.single("file"),
      async (req: Request, res: Response) => {
        try {
          if (!req.file) {
            res.status(400).json({ error: "No file uploaded" });
            return;
          }

          const storageMode = (req.body.storageMode as StorageMode) || "ipfs";
          const metadata = req.body.metadata ? JSON.parse(req.body.metadata as string) : undefined;

          const buffer = req.file.buffer;
          const originalName = req.file.originalname;
          const mimeType =
            req.file.mimetype ||
            (mime.lookup(originalName) as string) ||
            "application/octet-stream";

          // Adapt Buffer → UploadFile
          const nodeFile: UploadFile = {
            name: originalName,
            size: buffer.length,
            type: mimeType,
            arrayBuffer: async () => {
              const ab = new ArrayBuffer(buffer.byteLength);
              new Uint8Array(ab).set(buffer);
              return ab;
            },
          };

          const cid = await this.uploadFile(nodeFile, storageMode, metadata);
          res.json({ success: true, cid });
        } catch (err: any) {
          console.error("Vinyl (HTTP): upload error:", err);
          res.status(500).json({ error: err.message });
        }
      },
    );

    // ─── Download ───
    this.httpApp.get("/api/download/:cid", async (req: Request, res: Response) => {
      try {
        const cid = req.params.cid;
        const data = await this.downloadFile(cid);
        if (!data) {
          res.status(404).json({ error: "File not found" });
          return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", `attachment; filename="${cid}"`);
        res.send(Buffer.from(data));
      } catch (err: any) {
        console.error("Vinyl (HTTP): download error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // ─── Search ───
    this.httpApp.get("/api/search", async (req: Request, res: Response) => {
      try {
        const query = req.query.q as string;
        if (!query) {
          res.status(400).json({ error: "Query parameter 'q' is required" });
          return;
        }
        const results = await this.searchFiles(query);
        res.json(results);
      } catch (err: any) {
        console.error("Vinyl (HTTP): search error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // ─── Pin / Unpin ───
    this.httpApp.post("/api/pin/:cid", async (req: Request, res: Response) => {
      try {
        const cid = req.params.cid;
        await this.pinFile(cid);
        res.json({ success: true, message: "File pinned successfully" });
      } catch (err: any) {
        console.error("Vinyl (HTTP): pin error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    this.httpApp.delete("/api/pin/:cid", async (req: Request, res: Response) => {
      try {
        const cid = req.params.cid;
        await this.unpinFile(cid);
        res.json({ success: true, message: "File unpinned successfully" });
      } catch (err: any) {
        console.error("Vinyl (HTTP): unpin error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // ─── Health check ───
    this.httpApp.get("/health", (req: Request, res: Response) => {
      res.json({ status: "healthy", timestamp: new Date().toISOString() });
    });
  }

  /**
   * Enable Server‐Sent Events (SSE) at `/api/events` for recent events replay.
   */
  private setupEventSSE(): void {
    this.onEvent((evt, data) => {
      this.recentEvents.push({ event: evt, data, timestamp: Date.now() });
      if (this.recentEvents.length > 500) this.recentEvents.shift();
    });

    this.httpApp.get("/api/events", (req: Request, res: Response) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(":\n\n"); // initial SSE comment

      const sendEvent = (name: string, payload: any) => {
        res.write(`event: ${name}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      // Replay last 20 events
      const replayCount = Math.min(20, this.recentEvents.length);
      for (let i = this.recentEvents.length - replayCount; i < this.recentEvents.length; i++) {
        const e = this.recentEvents[i];
        sendEvent(e.event, e.data);
      }

      // Subscribe to new events
      const listener = (evtName: string, envelope: any) => {
        sendEvent(evtName, envelope.payload);
      };
      this.onEvent(listener);

      req.on("close", () => {
        // optionally remove listener, if implemented
      });
    });
  }

  /**
   * Initialize the node:
   * 1) Create/use a LevelDB for `fileDb`.
   * 2) Build libp2p with transports, DHT, Gossipsub, etc.
   * 3) Generate encryption key.
   * 4) Spin up Helia with LevelBlockstore (persisted under "./helia-repo").
   * 5) Build PluginContext and register plugins.
   * 6) Start libp2p and plugins.
   */
  async initialize(enableLocalStorage: boolean = true, origin?: string[]): Promise<boolean> {
    try {
      console.log("Vinyl: Initializing LevelDB for file metadata…");

      this.fileDb = new Level<string, FileInfo>(path.join(__dirname, "vinyl-filedb"), {
        valueEncoding: "json",
      });

      console.log("Vinyl: Initializing libp2p node…");
      this.localStorageEnabled = enableLocalStorage;
      this.origin = origin || ["*"];

      const { addresses, transports } = await this.getTransportsAndAddresses();

      const peerDiscoveryServices = await this.getPeerDiscoveryServices();

      this.libp2p = await createLibp2p({
        addresses,
        transports,
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        peerDiscovery: Object.values(peerDiscoveryServices),
        services: {
          identify: identify(),
          dht: kadDHT({ clientMode: this.isBrowser() }),
          ping: ping(),
          pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
          ...peerDiscoveryServices,
        },
      });

      await this.rotateEncryptionKey();

      // If localStorage enabled, initialize Helia (IPFS) & UnixFS with LevelBlockstore
      if (this.localStorageEnabled) {
        console.log("Vinyl: Initializing Helia (IPFS) node with LevelBlockstore…");
        this.helia = await createHelia({
          libp2p: this.libp2p,
          blockstore: new LevelBlockstore(path.join(__dirname, "helia-repo")),
        });
        this.fs = unixfs(this.helia);
      } else {
        console.log("Vinyl: Local storage disabled → relay-only mode");
      }

      const pluginContext: PluginContext = {
        nodeId: this.libp2p.peerId.toString(),
        libp2p: this.libp2p,
        files: this.filesView(),
        peers: this.peers,
        networkFiles: this.networkFiles,
        emit: (event, envelope) => {
          if (!validateEventEnvelope(envelope)) {
            console.warn("Vinyl: invalid event envelope, dropping:", envelope);
            return;
          }
          for (const listener of this.listeners) {
            try {
              listener(event, envelope);
            } catch {
              // ignore
            }
          }
        },
        pinFile: this.pinFile.bind(this),
        unpinFile: this.unpinFile.bind(this),
        getPermissions: () => this.nodePermissions,
        helia: this.helia!,
        fileDb: this.fileDb!,
        pluginManager: this.pluginManager,
        httpApp: this.httpApp,
        onEvent: this.onEvent.bind(this),
      };
      this.pluginManager.setContext(pluginContext);

      for (const plugin of this.pluginInstances) {
        const caps = plugin.getCapabilities();
        console.log(`Vinyl: registering plugin "${caps.name}" v${caps.version}…`);
        const success = await this.pluginManager.registerPlugin(plugin);
        if (success) {
          await this.signAndAppend({
            timestamp: new Date().toISOString(),
            event: "pluginRegister",
            plugin: caps.name,
            details: { version: caps.version, protocols: caps.protocols },
          });
        } else {
          console.warn(`Vinyl: plugin "${caps.name}" failed to register`);
        }
      }

      this.setupEventListeners();
      await this.libp2p.start();
      this.nodeStarted = true;

      await this.pluginManager.startAllPlugins();

      console.log(`Vinyl: Node started with ID: ${this.libp2p.peerId.toString()}`);
      console.log(`Vinyl: Local storage: ${this.localStorageEnabled ? "Enabled" : "Disabled"}`);
      console.log(`Vinyl: Registered plugins: ${this.pluginInstances.length}`);
      this.emit("nodeStarted", {
        source: "vinyl",
        payload: { nodeId: this.libp2p.peerId.toString() },
      });

      setInterval(
        () => {
          this.rotateEncryptionKey().catch((err) => {
            console.error("Vinyl: key rotation failed:", err);
          });
        },

        24 * 60 * 60 * 1000,
      );

      return true;
    } catch (error: any) {
      console.error("Vinyl: Failed to initialize node:", error);
      this.emit("error", { source: "vinyl", payload: { error: error.message } });
      return false;
    }
  }

  /**
   * Convert our LevelDB `fileDb` into an object that mimics a Map interface
   * (so plugins that do `context.files.values()` still work). We return an
   * async‐iterator of all values in LevelDB.
   */
  private filesView(): Map<string, FileInfo> {
    const pseudoMap = new Map<string, FileInfo>();
    (async () => {
      for await (const [cid, info] of this.fileDb.iterator()) {
        pseudoMap.set(cid, info);
      }
    })();
    return pseudoMap;
  }

  /**
   * Mount each plugin’s HTTP router onto our Express app under its namespace.
   * Must be called after initialize() so plugins have been registered.
   */
  private mountPluginRouters(): void {
    const allPlugins = this.pluginManager.getAllPlugins();
    for (const plugin of allPlugins) {
      if (
        typeof (plugin as any).getHttpNamespace === "function" &&
        typeof (plugin as any).getHttpRouter === "function"
      ) {
        let namespace: string = (plugin as any).getHttpNamespace();
        const router = (plugin as any).getHttpRouter();

        // Normalize namespace: must start with "/" and have no trailing slash
        if (!namespace.startsWith("/")) {
          namespace = "/" + namespace;
        }
        if (namespace.endsWith("/") && namespace.length > 1) {
          namespace = namespace.slice(0, -1);
        }

        const limiter = rateLimit({
          windowMs: 15 * 60 * 1000,
          max: 100,
          standardHeaders: true,
          legacyHeaders: false,
          message: { error: "Too many requests – try again later." },
        });

        this.httpApp.use(
          namespace,
          cors({
            origin: this.origin,
            methods: ["GET", "POST", "PUT", "DELETE"],
            credentials: true,
          }),
          helmet(),
          limiter as any,
          router as any,
        );
        console.log(`Vinyl (HTTP): mounted plugin routes at "${namespace}"`);
      }
    }
  }

  /**
   * Start the Express HTTP server (mount core + plugin routes).
   */
  startHttp(port: number = 3001): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        this.mountPluginRouters();
        this.httpServer = this.httpApp.listen(port, () => {
          console.log(`Vinyl (HTTP): listening on http://localhost:${port}`);
          resolve();
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Stop the Express HTTP server gracefully.
   */
  stopHttp(): Promise<void> {
    return new Promise((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => {
          console.log("Vinyl (HTTP): stopped");
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Rotate AES‐GCM key: generate a new CryptoKey, increment version, prune old keys, log event.
   */
  private async rotateEncryptionKey(): Promise<void> {
    this.currentKeyVersion++;
    let newKey: CryptoKey;

    if (this.isBrowser() && window.crypto && window.crypto.subtle) {
      newKey = await window.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
        "encrypt",
        "decrypt",
      ]);
    } else if (crypto.webcrypto && crypto.webcrypto.subtle) {
      newKey = await crypto.webcrypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
        "encrypt",
        "decrypt",
      ]);
    } else {
      throw new Error("Web Crypto AES‐GCM not available");
    }

    this.cryptoKeys.set(this.currentKeyVersion, newKey);

    // Keep only the last 3 key versions // TO-DO recovery after key rotation, since we can’t decrypt old files
    if (this.cryptoKeys.size > 3) {
      const oldest = Math.min(...Array.from(this.cryptoKeys.keys()));
      this.cryptoKeys.delete(oldest);
    }

    await this.signAndAppend({
      timestamp: new Date().toISOString(),
      event: "keyRotation",
      plugin: "core",
      details: { version: this.currentKeyVersion },
    });

    this.encryptionKey = newKey;
  }

  /**
   * Append a signed audit entry to disk. Each entry = JSON line with HMAC‐SHA256 signature.
   */
  private async signAndAppend(entry: {
    timestamp: string;
    event: string;
    plugin: string;
    details: Record<string, any>;
  }): Promise<void> {
    const payload = JSON.stringify(entry);
    const hmac = crypto.createHmac("sha256", this.auditKey);
    hmac.update(payload);
    const signature = hmac.digest("hex");
    const line = JSON.stringify({ ...entry, signature }) + "\n";
    fs.appendFileSync(this.auditLogPath, line);
  }

  /**
   * Search across:
   * 1) Local files (metadata in LevelDB) by matching name only
   * 2) Known networkFiles by matching name only
   * 3) Delegate to each plugin.searchFiles(...)
   */
  async searchFiles(query: string): Promise<NetworkFileInfo[]> {
    const results: NetworkFileInfo[] = [];
    const searchTerm = query.toLowerCase();

    for await (const [_, fileInfo] of this.fileDb.iterator()) {
      if (fileInfo.name.toLowerCase().includes(searchTerm)) {
        results.push({
          ...fileInfo,
          peerId: this.libp2p.peerId.toString(),
          peerAddress: "local",
          availability: "online",
        });
      }
    }

    for (const file of this.networkFiles.values()) {
      if (file.name.toLowerCase().includes(searchTerm)) {
        results.push(file);
      }
    }

    const pluginResults = await this.pluginManager.searchFiles(query);
    results.push(...pluginResults);

    return results;
  }

  /**
   * Delegate to plugins for recommendations based on a given base CID.
   */
  async getRecommendations(basedOnCid: string): Promise<NetworkFileInfo[]> {
    return await this.pluginManager.getRecommendations(basedOnCid);
  }

  /**
   * Upload a file:
   * 1) Read raw bytes (ArrayBuffer)
   * 2) Encrypt with AES‐GCM (prepend version + IV)
   * 3) If storageMode = "ipfs" and localStorageEnabled, add encrypted bytes to Helia→CID
   *    Else create a “stream‐<uuid>” and keep in memory
   * 4) Let plugins enhance metadata
   * 5) Build metadata object and store it (either Helia or in‐memory)
   * 6) Persist metadata FileInfo in LevelDB
   * 7) Notify plugins and emit “fileUploaded”
   */
  async uploadFile(
    file: UploadFile,
    storageMode: StorageMode = "ipfs",
    metadata?: any,
  ): Promise<string> {
    try {
      console.log(
        `Vinyl: uploading file "${file.name}" via ${storageMode} with metadata:`,
        metadata,
      );

      if (!this.localStorageEnabled && storageMode === "ipfs") {
        throw new Error("Local IPFS storage is disabled. Use P2P streaming instead.");
      }
      if (!this.encryptionKey) {
        throw new Error("Encryption key is not initialized");
      }

      const arrayBuffer = await file.arrayBuffer();

      const iv = this.isBrowser()
        ? window.crypto.getRandomValues(new Uint8Array(12))
        : crypto.webcrypto.getRandomValues(new Uint8Array(12));

      const encryptedBuffer = this.isBrowser()
        ? await window.crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            this.encryptionKey!,
            arrayBuffer,
          )
        : await crypto.webcrypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            this.encryptionKey!,
            arrayBuffer,
          );
      const ciphertext = new Uint8Array(encryptedBuffer);

      const versionByte = new Uint8Array([this.currentKeyVersion]);
      const combined = new Uint8Array(1 + iv.byteLength + ciphertext.byteLength);
      combined.set(versionByte, 0);
      combined.set(iv, 1);
      combined.set(ciphertext, 1 + iv.byteLength);

      let storedCID: string;
      let storedStreamId: string | undefined;

      if (storageMode === "ipfs" && this.localStorageEnabled) {
        const ipfsCID = await this.fs.addBytes(combined);
        storedCID = ipfsCID.toString();
      } else {
        storedStreamId = uuidv4();
        storedCID = `stream-${storedStreamId}`;
        this.streamingFiles.set(storedStreamId, combined);
        this.announceStream(storedStreamId, file.name, file.size);
      }

      let finalMetadata: any = {};
      const pluginMetadata = await this.pluginManager.enhanceFileMetadata(file);
      finalMetadata = { ...pluginMetadata };

      if (metadata) {
        finalMetadata = { ...finalMetadata, ...metadata };
      }

      const metadataObject = {
        name: file.name,
        size: file.size,
        type: file.type,
        uploadDate: new Date().toISOString(),
        storageMode,
        storedCID,
        metadata: finalMetadata,
      };

      let metadataCID: string;
      let metadataStreamId: string | undefined;
      if (storageMode === "ipfs" && this.localStorageEnabled) {
        const metadataBytes = new TextEncoder().encode(JSON.stringify(metadataObject));
        const ipfsMetadataCID = await this.fs.addBytes(metadataBytes);
        metadataCID = ipfsMetadataCID.toString();
      } else {
        metadataStreamId = uuidv4();
        metadataCID = `metadata-${metadataStreamId}`;
        const metadataBytes = new TextEncoder().encode(JSON.stringify(metadataObject));
        this.streamingFiles.set(metadataStreamId, metadataBytes);
      }

      const fileInfo: FileInfo = {
        cid: metadataCID,
        name: file.name,
        size: file.size,
        type: file.type,
        uploadDate: new Date(),
        encrypted: true,
        storageMode,
        streamId: metadataStreamId,
        pinned: false,
        shareLink: this.generateShareLink(metadataCID, storageMode),
        metadata: finalMetadata,
      };

      await this.fileDb.put(metadataCID, fileInfo);

      this.pluginManager.notifyFileUploaded(metadataCID, fileInfo);
      this.emit("fileUploaded", {
        source: "vinyl",
        payload: { cid: metadataCID, fileInfo },
      });
      return metadataCID;
    } catch (error: any) {
      console.error("Vinyl: Failed to upload file:", error);
      this.emit("error", { source: "vinyl", payload: { error: error.message } });
      throw error;
    }
  }

  /**
   * Generate a shareable URI for the file:
   *  - IPFS: "vinyl://ipfs/<cid>"
   *  - P2P streaming: "vinyl://stream/<cid>"
   */
  private generateShareLink(cid: string, storageMode: StorageMode): string {
    return storageMode === "ipfs" ? `vinyl://ipfs/${cid}` : `vinyl://stream/${cid}`;
  }

  /**
   * Download a file by CID:
   * 1) If this is a metadataCID (exists in fileDb), return raw metadata JSON bytes.
   * 2) Otherwise (encrypted payload), fetch+decrypt and return decrypted bytes.
   * On success, notify plugins via notifyFileDownloaded and emit "fileDownloaded".
   */
  async downloadFile(cid: string): Promise<Uint8Array | null> {
    try {
      console.log(`Vinyl: downloading file with CID "${cid}"`);

      if (!this.encryptionKey) {
        throw new Error("Encryption key is not initialized");
      }

      let fileInfo: FileInfo | null = null;
      try {
        fileInfo = await this.fileDb.get(cid);
      } catch {
        // not in LevelDB
      }
      if (fileInfo) {
        // It’s a metadata JSON blob
        if (fileInfo.storageMode === "ipfs") {
          const catStream = this.fs.cat(cid);
          const chunks: Uint8Array[] = [];
          for await (const chunk of catStream) {
            chunks.push(chunk);
          }
          const all = chunks.flatMap((c) => Array.from(c));
          return new Uint8Array(all);
        } else {
          const metadataStreamId = fileInfo.streamId!;
          const metadataBytes = this.streamingFiles.get(metadataStreamId);
          if (!metadataBytes) {
            console.warn(`Vinyl: no streaming metadata for ID "${metadataStreamId}"`);
            return null;
          }
          return metadataBytes;
        }
      }

      let encryptedData: Uint8Array | undefined;
      if (cid.startsWith("stream-")) {
        const streamId = cid.replace(/^stream-/, "");
        encryptedData = this.streamingFiles.get(streamId);
        if (!encryptedData) {
          console.warn(`Vinyl: streaming audio "${streamId}" not found locally`);
          throw new Error("Stream not available");
        }
      } else {
        // IPFS retrieval via Helia
        if (!this.localStorageEnabled || !this.fs) {
          throw new Error("Local IPFS storage is disabled");
        }
        const catStream = this.fs.cat(cid);
        const chunks: Uint8Array[] = [];
        for await (const chunk of catStream) {
          chunks.push(chunk);
        }
        const all = chunks.flatMap((c) => Array.from(c));
        encryptedData = new Uint8Array(all);
      }

      const decrypted = await this.decryptFileData(encryptedData!);
      this.pluginManager.notifyFileDownloaded(cid);
      return decrypted;
    } catch (error: any) {
      console.error("Vinyl: Failed to download file:", error);
      this.emit("error", { source: "vinyl", payload: { error: error.message } });
      return null;
    }
  }

  /**
   * Decrypt a Uint8Array that was encrypted via AES‐GCM:
   * format = [version(1) | IV(12) | ciphertext…].
   */
  private async decryptFileData(encryptedData: Uint8Array): Promise<Uint8Array> {
    const version = encryptedData[0];
    const key = this.cryptoKeys.get(version);
    if (!key) {
      throw new Error(`Missing decryption key for version ${version}`);
    }
    const iv = encryptedData.slice(1, 13);
    const ciphertext = encryptedData.slice(13);

    const decryptedBuffer = this.isBrowser()
      ? await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext)
      : await crypto.webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);

    return new Uint8Array(decryptedBuffer);
  }

  /**
   * Announce a new P2P streaming file.
   */
  private announceStream(streamId: string, fileName: string, fileSize: number): void {
    console.log(
      `Vinyl: announcing stream "${fileName}" (size: ${fileSize}) → streamId="${streamId}"`,
    );
  }

  /**
   * Pin a file in Helia/IPFS; update FileInfo & emit "filePinned".
   * If localStorage is disabled, throws an error.
   */
  async pinFile(cid: string): Promise<void> {
    try {
      if (!this.localStorageEnabled || !this.helia) {
        throw new Error("Local storage is disabled; cannot pin files.");
      }
      await this.helia.pins.add(cid);
      this.pinnedFiles.add(cid);

      // Update FileInfo.pinned = true in LevelDB
      let fi: FileInfo | null = null;
      try {
        fi = await this.fileDb.get(cid);
      } catch {
        // not in DB
      }
      if (fi) {
        fi.pinned = true;
        await this.fileDb.put(cid, fi);
      }

      this.emit("filePinned", { source: "vinyl", payload: { cid } });
      console.log(`Vinyl: pinned file "${cid}"`);

      // Audit log
      await this.signAndAppend({
        timestamp: new Date().toISOString(),
        event: "filePin",
        plugin: "core",
        details: { cid },
      });
    } catch (error: any) {
      console.error("Vinyl: pinFile failed:", error);
      this.emit("error", { source: "vinyl", payload: { error: error.message } });
      throw error;
    }
  }

  /**
   * Unpin a file in Helia/IPFS; update FileInfo & emit "fileUnpinned".
   * If localStorage is disabled, throws an error.
   */
  async unpinFile(cid: string): Promise<void> {
    try {
      if (!this.localStorageEnabled || !this.helia) {
        throw new Error("Local storage is disabled; cannot unpin files.");
      }
      await this.helia.pins.rm(cid);
      this.pinnedFiles.delete(cid);

      // Update FileInfo.pinned = false in LevelDB
      let fi: FileInfo | null = null;
      try {
        fi = await this.fileDb.get(cid);
      } catch {
        // not in DB
      }
      if (fi) {
        fi.pinned = false;
        await this.fileDb.put(cid, fi);
      }

      this.emit("fileUnpinned", { source: "vinyl", payload: { cid } });
      console.log(`Vinyl: unpinned file "${cid}"`);

      // Audit log
      await this.signAndAppend({
        timestamp: new Date().toISOString(),
        event: "fileUnpin",
        plugin: "core",
        details: { cid },
      });
    } catch (error: any) {
      console.error("Vinyl: unpinFile failed:", error);
      this.emit("error", { source: "vinyl", payload: { error: error.message } });
      throw error;
    }
  }

  /**
   * Set up libp2p event listeners for peer connect/disconnect,
   * then notify plugins and emit our own events.
   */
  private setupEventListeners(): void {
    if (!this.libp2p) return;

    this.libp2p.addEventListener("peer:connect", (evt: any) => {
      const peerId = evt.detail.toString();
      const peerInfo: PeerInfo = {
        id: peerId,
        address: "unknown",
        status: "connected",
        lastSeen: new Date(),
      };
      this.peers.set(peerId, peerInfo);
      this.pluginManager.notifyPeerConnected(peerId, peerInfo);
      this.emit("peerConnected", { source: "vinyl", payload: { peerId } });
    });

    this.libp2p.addEventListener("peer:disconnect", (evt: any) => {
      const peerId = evt.detail.toString();
      const pi = this.peers.get(peerId);
      if (pi) {
        pi.status = "disconnected";
        this.peers.set(peerId, pi);
        this.pluginManager.notifyPeerDisconnected(peerId, pi);
      }
      this.emit("peerDisconnected", { source: "vinyl", payload: { peerId } });
    });
  }

  /**
   * Return aggregated node statistics for monitoring:
   *  - id, isOnline, peer counts, file counts, etc.
   */
  getNodeStats(): NodeStats {
    const connectedPeers = Array.from(this.peers.values()).filter((p) => p.status === "connected");
    return {
      id: this.libp2p?.peerId?.toString() || this.nodeId,
      isOnline: this.libp2p?.isStarted === true,
      connectedPeers: connectedPeers.length,
      totalPeers: this.peers.size,
      uploadedFiles: 0, // could increment on upload
      downloadedFiles: 0, // track if needed
      storageUsed: this.localStorageEnabled ? 0 : -1,
      storageAvailable: this.localStorageEnabled ? 1000 * 1024 * 1024 : 0,
      pinnedFiles: this.pinnedFiles.size,
    };
  }

  /** Return a snapshot list of known peers. */
  getPeers(): PeerInfo[] {
    return Array.from(this.peers.values());
  }

  /** Return a snapshot list of local FileInfo (reads from fileDb). */
  async getFiles(): Promise<FileInfo[]> {
    const files: FileInfo[] = [];
    for await (const [, info] of this.fileDb.iterator()) {
      files.push(info);
    }
    return files;
  }

  /** Return a snapshot list of NetworkFileInfo for known network‐advertised files. */
  getNetworkFiles(): NetworkFileInfo[] {
    return Array.from(this.networkFiles.values());
  }

  /**
   * Subscribe to node‐level events.
   */
  public on(callback: (event: string, envelope: { source: string; payload: any }) => void): void {
    this.listeners.push(callback);
  }

  /** Alias for `on(...)`. */
  public onEvent(
    callback: (event: string, envelope: { source: string; payload: any }) => void,
  ): void {
    this.on(callback);
  }

  /**
   * PUBLIC EMIT: call all listeners with (eventName, envelope).
   */
  public emit(event: string, envelope: { source?: string; payload: any }): void {
    if (!envelope.source) {
      envelope.source = "vinyl";
    }
    if (!validateEventEnvelope(envelope)) {
      console.warn("Vinyl: emit called with invalid envelope, dropping:", envelope);
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(event, envelope as { source: string; payload: any });
      } catch {
        // ignore listener errors
      }
    }
  }

  /**
   * Return the PluginManager so external code can query installed plugins.
   */
  getPluginManager(): PluginManager {
    return this.pluginManager;
  }

  /**
   * Gracefully shut down all plugins → Helia → libp2p.
   */
  async stop(): Promise<void> {
    await this.pluginManager.stopAllPlugins();
    if (this.helia) {
      await this.helia.stop();
    }
    if (this.libp2p) {
      await this.libp2p.stop();
    }
    console.log("Vinyl: Node stopped");

    await this.signAndAppend({
      timestamp: new Date().toISOString(),
      event: "nodeStopped",
      plugin: "core",
      details: { nodeId: this.libp2p?.peerId?.toString() || this.nodeId },
    });
  }
}
