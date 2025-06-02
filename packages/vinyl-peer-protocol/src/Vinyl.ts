import { createLibp2p } from "libp2p";
import { webSockets } from "@libp2p/websockets";
import { webRTC } from "@libp2p/webrtc";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { kadDHT } from "@libp2p/kad-dht";
import { ping } from "@libp2p/ping";
import { bootstrap } from "@libp2p/bootstrap";
import { createHelia } from "helia";
import { unixfs } from "@helia/unixfs";
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

import type express from "express";

import { fileURLToPath } from "url";

import rateLimit from "express-rate-limit";

import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Schema for event-envelope validation ----------
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

  // Unique node identifier
  private nodeId: string;

  // In-memory maps of peers, files, and network-advertised files
  private peers: Map<string, PeerInfo> = new Map();
  private files: Map<string, FileInfo> = new Map();
  private streamingFiles: Map<string, Uint8Array> = new Map();
  private networkFiles: Map<string, NetworkFileInfo> = new Map();

  // Set of CIDs that have been pinned locally
  private pinnedFiles: Set<string> = new Set();

  private origin: string[] = []; // Allowed origins for CORS (default: allow all)

  /**
   * PLUGIN + NODE EVENT BUS:
   * We keep a private array of listeners, each is (eventName, data) => void.
   * Plugins and external code can subscribe via `on()` or `onEvent()`.
   */
  private listeners: ((event: string, envelope: { source: string; payload: any }) => void)[] = [];

  // AES-GCM CryptoKey versions map
  private cryptoKeys: Map<number, CryptoKey> = new Map();
  private currentKeyVersion: number = 0;

  // HMAC key for audit logging
  private auditKey: Buffer = crypto.randomBytes(32);
  private auditLogPath: string = path.join(__dirname, "vinyl-audit.log");

  // “Current” encryption key (for convenience; always matches cryptoKeys.get(currentKeyVersion))
  private encryptionKey: CryptoKey | null = null;

  // Whether local IPFS storage is enabled (Helia)
  private localStorageEnabled: boolean = true;

  // Plugin framework
  private pluginManager: PluginManager;
  private pluginInstances: VinylPeerPlugin[];
  private nodePermissions: PluginPermissions;

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
  }

  /**
   * Helper to detect if running in a browser (window + document exist).
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
        addresses: {
          listen: ["/webrtc"],
        },
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

  /**
   * Set up libp2p event listeners for peer connect/disconnect,
   * then notify plugins and emit our own events.
   */
  private setupEventListeners(): void {
    if (!this.libp2p) return;

    this.libp2p.addEventListener("peer:connect", (evt: any) => {
      const peerId = evt.detail.toString();
      console.log("Vinyl: peer connected:", peerId);

      const peerInfo: PeerInfo = {
        id: peerId,
        address: "unknown",
        status: "connected",
        lastSeen: new Date(),
        isMusicNode: false,
      };
      this.peers.set(peerId, peerInfo);
      this.pluginManager.notifyPeerConnected(peerId, peerInfo);
      this.emit("peerConnected", { source: "vinyl", payload: { peerId } });
    });

    this.libp2p.addEventListener("peer:disconnect", (evt: any) => {
      const peerId = evt.detail.toString();
      console.log("Vinyl: peer disconnected:", peerId);

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
   * Initialize the node:
   * 1) Build libp2p with transports, mDNS/Bootstrap, encryption, DHT, etc.
   * 2) Generate or import AES‐GCM key via Web Crypto.
   * 3) If localStorage enabled, spin up a Helia (IPFS) node and UnixFS.
   * 4) Build PluginContext (including permissions), register all plugins, start libp2p, then plugins.
   */
  async initialize(enableLocalStorage: boolean = true, origin?: string[]): Promise<boolean> {
    try {
      console.log("Vinyl: Initializing libp2p node...");
      this.localStorageEnabled = enableLocalStorage;
      this.origin = origin || ["*"]; // Default to allow all origins

      // 1) Build transports & addresses
      const { addresses, transports } = await this.getTransportsAndAddresses();

      // 2) Build peer discovery modules
      const peerDiscoveryServices = await this.getPeerDiscoveryServices();

      // 3) Construct the libp2p node
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
          ...peerDiscoveryServices,
        },
      });

      // 4) Generate or import AES‐GCM key (initial rotation)
      await this.rotateEncryptionKey();

      // 5) If localStorage enabled, initialize Helia (IPFS) & UnixFS
      if (this.localStorageEnabled) {
        console.log("Vinyl: Initializing Helia (IPFS) node...");
        this.helia = await createHelia({ libp2p: this.libp2p });
        this.fs = unixfs(this.helia);
      } else {
        console.log("Vinyl: Local storage disabled → relay-only mode");
      }

      // 6) Build PluginContext
      const pluginContext: PluginContext = {
        nodeId: this.libp2p.peerId.toString(),
        libp2p: this.libp2p,
        files: this.files,
        peers: this.peers,
        networkFiles: this.networkFiles,
        emit: (event, envelope) => {
          if (!validateEventEnvelope(envelope)) {
            console.warn("Vinyl: invalid event envelope, dropping:", envelope);
            return;
          }
          // Broadcast event to all registered listeners
          for (const listener of this.listeners) {
            try {
              listener(event, envelope);
            } catch {
              // Ignore individual listener errors
            }
          }
        },
        pinFile: this.pinFile.bind(this),
        unpinFile: this.unpinFile.bind(this),
        getPermissions: () => this.nodePermissions,
      };
      this.pluginManager.setContext(pluginContext);

      // 7) Register each plugin instance
      for (const plugin of this.pluginInstances) {
        const caps = plugin.getCapabilities();
        console.log(`Vinyl: registering plugin "${caps.name}" v${caps.version}...`);

        // If plugin exposes HTTP, mount it under a secure sub‐router
        if (caps.permissions.exposeHttp && plugin.getHttpRouter && plugin.getHttpNamespace) {
          this.setupHttpForPlugin(plugin);
        }

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

      // 8) Set up peer event listeners, then start libp2p
      this.setupEventListeners();
      await this.libp2p.start();

      // 9) Start all plugins after libp2p is live
      await this.pluginManager.startAllPlugins();

      console.log(`Vinyl: Node started with ID: ${this.libp2p.peerId.toString()}`);
      console.log(`Vinyl: Local storage: ${this.localStorageEnabled ? "Enabled" : "Disabled"}`);
      console.log(`Vinyl: Registered plugins: ${this.pluginInstances.length}`);
      this.emit("nodeStarted", {
        source: "vinyl",
        payload: { nodeId: this.libp2p.peerId.toString() },
      });

      // Schedule daily key rotation
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
   * Setup a secured HTTP sub‐app for a plugin (if it wants to expose an HTTP API).
   */
  private async setupHttpForPlugin(plugin: VinylPeerPlugin) {
    if (!plugin.getHttpRouter || !plugin.getHttpNamespace) return;
    const express = (await import("express")).default;
    const helmet = (await import("helmet")).default;
    const cors = (await import("cors")).default;
    const app = express();

    // Enforce strict CORS policy (adjust as needed)
    app.use(
      cors({
        origin: this.origin, // change to your allowed origins
        methods: ["GET", "POST", "PUT", "DELETE"],
        credentials: true,
      }),
    );
    app.use(helmet());

    // Rate limiter: max 100 requests per 15 minutes per IP
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many requests – try again later." },
    });

    const router = plugin.getHttpRouter() as express.Router;
    app.use(plugin.getHttpNamespace(), limiter, router);

    // Mount plugin HTTP under main libp2p HTTP server if it exists
    if (this.libp2p && (this.libp2p as any).httpServer) {
      (this.libp2p as any).httpServer.use(plugin.getHttpNamespace(), app);
    } else {
      console.warn(
        `Vinyl: libp2p has no HTTP server; plugin "${plugin.getCapabilities().name}" HTTP routes are unmounted`,
      );
    }
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
      throw new Error("Web Crypto AES-GCM not available");
    }

    this.cryptoKeys.set(this.currentKeyVersion, newKey);

    // Keep only the last 3 key versions
    if (this.cryptoKeys.size > 3) {
      const oldest = Math.min(...Array.from(this.cryptoKeys.keys()));
      this.cryptoKeys.delete(oldest);
    }

    // Log the rotation
    await this.signAndAppend({
      timestamp: new Date().toISOString(),
      event: "keyRotation",
      plugin: "core",
      details: { version: this.currentKeyVersion },
    });

    // Update “current” pointer
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
   * Return the PluginManager so external code can query installed plugins.
   */
  getPluginManager(): PluginManager {
    return this.pluginManager;
  }

  /**
   * Search across:
   * 1) Local files (this.files) by matching name/metadata fields
   * 2) Known networkFiles
   * 3) Delegate to each plugin.searchFiles(...)
   * Returns an array of NetworkFileInfo matches.
   */
  async searchFiles(query: string): Promise<NetworkFileInfo[]> {
    const results: NetworkFileInfo[] = [];
    const searchTerm = query.toLowerCase();

    // 1) Local files
    for (const file of this.files.values()) {
      if (
        file.name.toLowerCase().includes(searchTerm) ||
        (file.metadata?.artist &&
          (file.metadata.artist as string).toLowerCase().includes(searchTerm)) ||
        (file.metadata?.album &&
          (file.metadata.album as string).toLowerCase().includes(searchTerm)) ||
        (file.metadata?.genre &&
          (file.metadata.genre as string).toLowerCase().includes(searchTerm)) ||
        (file.metadata?.title && (file.metadata.title as string).toLowerCase().includes(searchTerm))
      ) {
        results.push({
          ...file,
          peerId: this.libp2p.peerId.toString(),
          peerAddress: "local",
          availability: "online",
        });
      }
    }

    // 2) Network files
    for (const file of this.networkFiles.values()) {
      const nameMatch = file.name.toLowerCase().includes(searchTerm);
      const metadataMatch =
        (file.metadata?.artist &&
          (file.metadata.artist as string).toLowerCase().includes(searchTerm)) ||
        (file.metadata?.album &&
          (file.metadata.album as string).toLowerCase().includes(searchTerm)) ||
        (file.metadata?.genre &&
          (file.metadata.genre as string).toLowerCase().includes(searchTerm)) ||
        (file.metadata?.title &&
          (file.metadata.title as string).toLowerCase().includes(searchTerm));
      if (nameMatch || metadataMatch) {
        results.push(file);
      }
    }

    // 3) Plugin-provided search
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
   * 2) Encrypt with AES‐GCM using this.encryptionKey (prepend version + IV)
   * 3) If storageMode = "ipfs" and localStorageEnabled:
   *      • Add encrypted bytes to IPFS (Helia) → audioCID
   *    Else:
   *      • Create a "stream-<uuid>" ID → store encrypted bytes in-memory
   *      • Announce stream over pubsub (placeholder)
   * 4) Let each plugin enhance metadata via `enhanceFileMetadata()`
   * 5) Create a metadata JSON object (file name, size, type, uploadDate, audioCID, etc.)
   * 6) Store metadata JSON either on IPFS or in-memory stream
   * 7) Construct FileInfo, store in `this.files`, notify plugins, emit "fileUploaded"
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

      // 1) Read raw bytes
      const arrayBuffer = await file.arrayBuffer();

      // 2) Encrypt with AES‐GCM (prepend version byte + IV)
      const iv = this.isBrowser()
        ? window.crypto.getRandomValues(new Uint8Array(12))
        : crypto.webcrypto.getRandomValues(new Uint8Array(12));

      // Encrypt using currentKeyVersion
      const encryptedBuffer = await (this.isBrowser()
        ? window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.encryptionKey!, arrayBuffer)
        : crypto.webcrypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            this.encryptionKey!,
            arrayBuffer,
          ));
      const ciphertext = new Uint8Array(encryptedBuffer);

      // Build [ version(1 byte) | IV(12 bytes) | ciphertext... ]
      const versionByte = new Uint8Array([this.currentKeyVersion]);
      const combined = new Uint8Array(1 + iv.byteLength + ciphertext.byteLength);
      combined.set(versionByte, 0);
      combined.set(iv, 1);
      combined.set(ciphertext, 1 + iv.byteLength);

      let audioCID: string;
      let audioStreamId: string | undefined;
      let metadataCID: string;
      let metadataStreamId: string | undefined;

      // 3) Store encrypted audio
      if (storageMode === "ipfs" && this.localStorageEnabled) {
        const ipfsAudioCID = await this.fs.addBytes(combined);
        audioCID = ipfsAudioCID.toString();
      } else {
        audioStreamId = uuidv4();
        audioCID = `stream-${audioStreamId}`;
        this.streamingFiles.set(audioStreamId, combined);
        this.announceStream(audioStreamId, file.name, file.size);
      }

      // 4) Let plugins add metadata
      let finalMetadata: any = {};
      const pluginMetadata = await this.pluginManager.enhanceFileMetadata(file);
      finalMetadata = { ...this.extractMetadata(file), ...pluginMetadata };

      // Override with any user-provided metadata
      if (metadata) {
        finalMetadata = { ...finalMetadata, ...metadata };
      }

      // 5) Build metadata JSON object
      const metadataObject = {
        name: file.name,
        size: file.size,
        type: file.type,
        uploadDate: new Date().toISOString(),
        audioCID,
        audioStreamId,
        storageMode,
        metadata: finalMetadata,
      };

      // 6) Store metadata JSON (either IPFS or in-memory)
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

      // 7) Construct FileInfo, store locally, notify plugins, and emit event
      const fileInfo: FileInfo = {
        cid: metadataCID,
        name: file.name,
        size: file.size,
        type: file.type,
        uploadDate: new Date(),
        encrypted: true,
        storageMode,
        streamId: metadataStreamId,
        audioCID,
        audioStreamId,
        pinned: false,
        shareLink: this.generateShareLink(metadataCID, storageMode),
        metadata: finalMetadata,
      };

      this.files.set(metadataCID, fileInfo);
      this.pluginManager.notifyFileUploaded(metadataCID, fileInfo);
      this.emit("fileUploaded", { source: "vinyl", payload: { cid: metadataCID, fileInfo } });

      return metadataCID;
    } catch (error: any) {
      console.error("Vinyl: Failed to upload file:", error);
      this.emit("error", { source: "vinyl", payload: { error: error.message } });
      throw error;
    }
  }

  /**
   * Generate a shareable URI for the file:
   *  - For IPFS storage: "vinyl://ipfs/<cid>"
   *  - For P2P streaming:  "vinyl://stream/<cid>"
   */
  private generateShareLink(cid: string, storageMode: StorageMode): string {
    if (storageMode === "ipfs") {
      return `vinyl://ipfs/${cid}`;
    } else {
      return `vinyl://stream/${cid}`;
    }
  }

  /**
   * Basic metadata extraction from filename (for .audio files):
   *  - Expect "Artist - Title" or "Artist - Album - Title"
   *  - Extract genre = "Unknown" by default
   */
  private extractMetadata(file: UploadFile): any {
    const metadata: any = {};
    if (file.type.startsWith("audio/")) {
      const baseName = file.name.replace(/\.[^/.]+$/, "");
      const parts = baseName.split(" - ");
      if (parts.length >= 2) {
        metadata.artist = parts[0].trim();
        metadata.title = parts[1].trim();
      } else {
        metadata.title = baseName;
      }
      metadata.genre = "Unknown";
    }
    return metadata;
  }

  /**
   * Announce a new P2P streaming file:
   * In a real system, this could publish a pubsub message. Here we simply log.
   */
  private announceStream(streamId: string, fileName: string, fileSize: number): void {
    console.log(
      `Vinyl: announcing stream "${fileName}" (size: ${fileSize}) → streamId="${streamId}"`,
    );
  }

  /**
   * Download a file by CID:
   * 1) If it's a metadataCID, resolve to audioCID
   * 2) If audioCID starts with "stream-", read encrypted bytes from memory → decrypt → return
   * 3) Otherwise (IPFS): cat bytes via Helia → decrypt → return
   * On success, notify plugins via notifyFileDownloaded and emit "fileDownloaded".
   */
  async downloadFile(cid: string): Promise<Uint8Array | null> {
    try {
      console.log(`Vinyl: downloading file with CID "${cid}"`);

      if (!this.encryptionKey) {
        throw new Error("Encryption key is not initialized");
      }

      // 1) Check if this is a metadataCID (local map contains FileInfo)
      const fileInfo = this.files.get(cid);
      let targetCID = cid;

      if (fileInfo && fileInfo.audioCID) {
        // We found a FileInfo → extract audioCID
        targetCID = fileInfo.audioCID;
        console.log(`Vinyl: resolved metadata CID → audioCID "${targetCID}"`);
      } else if (cid.startsWith("metadata-")) {
        // It's a streaming metadata ID (in-memory JSON), return raw metadata bytes
        const metadataStreamId = cid.replace(/^metadata-/, "");
        const metadataBytes = this.streamingFiles.get(metadataStreamId);
        if (!metadataBytes) {
          console.warn(`Vinyl: no streaming metadata for ID "${metadataStreamId}"`);
          return null;
        }
        return metadataBytes;
      }

      // 2) Now handle the actual audio piece
      if (targetCID.startsWith("stream-")) {
        // In-memory encrypted bytes
        const streamId = targetCID.replace(/^stream-/, "");
        const encryptedData = this.streamingFiles.get(streamId);
        if (!encryptedData) {
          console.warn(`Vinyl: streaming audio "${streamId}" not found locally`);
          throw new Error("Stream not available");
        }
        const decrypted = await this.decryptFileData(encryptedData);
        this.pluginManager.notifyFileDownloaded(cid);
        return decrypted;
      } else {
        // 3) IPFS retrieval via Helia
        if (!this.localStorageEnabled || !this.fs) {
          throw new Error("Local IPFS storage is disabled");
        }

        const catStream = this.fs.cat(targetCID);
        const chunks: Uint8Array[] = [];
        for await (const chunk of catStream) {
          chunks.push(chunk);
        }

        // Concatenate chunks into one Uint8Array
        const combined = new Uint8Array(
          chunks.reduce((acc, c) => acc.concat(Array.from(c)), [] as number[]),
        );
        const decrypted = await this.decryptFileData(combined);
        this.pluginManager.notifyFileDownloaded(cid);
        return decrypted;
      }
    } catch (error: any) {
      console.error("Vinyl: Failed to download file:", error);
      this.emit("error", { source: "vinyl", payload: { error: error.message } });
      return null;
    }
  }

  /**
   * Decrypt a Uint8Array that was encrypted via AES‐GCM (with version+IV prefix).
   * Returns the raw decrypted bytes.
   */
  private async decryptFileData(encryptedData: Uint8Array): Promise<Uint8Array> {
    // 1) Extract version (first byte), IV (next 12 bytes), and ciphertext
    const version = encryptedData[0];
    const key = this.cryptoKeys.get(version);
    if (!key) {
      throw new Error(`Missing decryption key for version ${version}`);
    }
    const iv = encryptedData.slice(1, 13);
    const ciphertext = encryptedData.slice(13);

    // 2) Decrypt via Web Crypto
    const decryptedBuffer = await (this.isBrowser()
      ? window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext)
      : crypto.webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext));

    return new Uint8Array(decryptedBuffer);
  }

  /**
   * Pin a file in Helia/IPFS; update FileInfo & emit "filePinned".
   * - If localStorage is disabled, throws an error.
   */
  async pinFile(cid: string): Promise<void> {
    try {
      if (!this.localStorageEnabled || !this.helia) {
        throw new Error("Local storage is disabled; cannot pin files.");
      }
      await this.helia.pins.add(cid);
      this.pinnedFiles.add(cid);

      // Update FileInfo.pinned = true
      const fi = this.files.get(cid);
      if (fi) {
        fi.pinned = true;
        this.files.set(cid, fi);
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
   * - If localStorage is disabled, throws an error.
   */
  async unpinFile(cid: string): Promise<void> {
    try {
      if (!this.localStorageEnabled || !this.helia) {
        throw new Error("Local storage is disabled; cannot unpin files.");
      }
      await this.helia.pins.rm(cid);
      this.pinnedFiles.delete(cid);

      // Update FileInfo.pinned = false
      const fi = this.files.get(cid);
      if (fi) {
        fi.pinned = false;
        this.files.set(cid, fi);
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
   * Return aggregated node statistics for monitoring:
   *  - id, isOnline, peer counts, file counts, storage usage, etc.
   */
  getNodeStats(): NodeStats {
    const connectedPeers = Array.from(this.peers.values()).filter((p) => p.status === "connected");
    const musicPeers = Array.from(this.peers.values()).filter(
      (p) => p.status === "connected" && p.isMusicNode,
    );

    return {
      id: this.libp2p?.peerId?.toString() || this.nodeId,
      isOnline: this.libp2p?.isStarted === true,
      connectedPeers: connectedPeers.length,
      totalPeers: this.peers.size,
      uploadedFiles: this.files.size,
      downloadedFiles: 0, // Could track this if desired
      storageUsed: this.localStorageEnabled ? 0 : -1, // Placeholder
      storageAvailable: this.localStorageEnabled ? 1000 * 1024 * 1024 : 0, // Placeholder
      musicPeers: musicPeers.length,
      pinnedFiles: this.pinnedFiles.size,
    };
  }

  /** Return a snapshot list of known peers. */
  getPeers(): PeerInfo[] {
    return Array.from(this.peers.values());
  }

  /** Return a snapshot list of local FileInfo for all uploaded files. */
  getFiles(): FileInfo[] {
    return Array.from(this.files.values());
  }

  /** Return a snapshot list of NetworkFileInfo for all known network‐advertised files. */
  getNetworkFiles(): NetworkFileInfo[] {
    return Array.from(this.networkFiles.values());
  }

  /**
   * Subscribe to node-level events (“peerConnected”, “fileUploaded”, plugin events, etc.).
   * Callbacks receive (eventName, envelope).
   */
  public on(callback: (event: string, envelope: { source: string; payload: any }) => void): void {
    this.listeners.push(callback);
  }

  /** Alias for `on(...)` so that older code using `onEvent(...)` still works. */
  public onEvent(
    callback: (event: string, envelope: { source: string; payload: any }) => void,
  ): void {
    this.on(callback);
  }

  /**
   * PUBLIC EMIT: call every registered listener with (eventName, envelope).
   * Plugins and external code rely on this to receive node and plugin events.
   */
  public emit(event: string, envelope: { source?: string; payload: any }): void {
    // If plugins call this, "source" may be missing – wrap it if needed
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
        // Ignore errors in individual listeners
      }
    }
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
      details: { nodeId: this.libp2p?.peerId.toString() || this.nodeId },
    });
  }
}
