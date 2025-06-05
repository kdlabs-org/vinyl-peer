import express, { Router, RequestHandler } from "express";
import { CID } from "multiformats/cid";
import {
  BasePlugin,
  PluginCapabilities,
  PluginContext,
  VinylPeerPlugin,
  PeerInfo,
  FileInfo,
  NetworkFileInfo,
  UploadFile,
} from "vinyl-peer-protocol";
import { unixfs } from "@helia/unixfs";
import multer from "multer";
import mime from "mime-types";
import type { MusicMetadata, MusicDiscoveryQuery, AnnouncementPayload, Playlist } from "./types.js";
export class MusicPlugin extends BasePlugin implements VinylPeerPlugin {
  protected context!: PluginContext;

  // In-memory caches
  private musicMetadata: Map<string, MusicMetadata> = new Map();
  private genreGraph: Map<string, string[]> = new Map();
  private musicPeers: Set<string> = new Set();
  private discoveredTracks: Map<string, { peerId: string; metadata: MusicMetadata }> = new Map();
  private playlists: Map<string, Playlist> = new Map();

  // Multer for file uploads
  private upload: multer.Multer;

  // PubSub topic for announcements
  private readonly ANNOUNCE_TOPIC = "/music-announcements/1.0.0";

  constructor() {
    super();
    this.initializeMusicKnowledge();
    this.upload = multer({ storage: multer.memoryStorage() });
  }

  /** Declare plugin identity, protocols, capabilities, fileTypes, permissions */
  getCapabilities(): PluginCapabilities {
    return {
      name: "vinyl-peer-plugin-music-network",
      version: "1.0.0",
      protocols: [
        "/music-discovery/1.0.0",
        "/music-recommendations/1.0.0",
        "/music-metadata/1.0.0",
        "/music-stream/1.0.0",
      ],
      capabilities: ["streaming", "discovery", "recommendations", "metadata", "upload", "playlist"],
      fileTypes: ["audio/*"],
      permissions: {
        accessFiles: true,
        useNetwork: true,
        modifyPeers: true,
        exposeHttp: true,
      },
    };
  }

  /** Build genreGraph for heuristic recommendations */
  private initializeMusicKnowledge(): void {
    this.genreGraph.set("rock", ["alternative", "indie", "punk", "metal"]);
    this.genreGraph.set("electronic", ["techno", "house", "ambient", "dubstep"]);
    this.genreGraph.set("jazz", ["blues", "fusion", "swing", "bebop"]);
    this.genreGraph.set("classical", ["baroque", "romantic", "contemporary"]);
    this.genreGraph.set("hip-hop", ["rap", "trap", "old-school"]);
    this.genreGraph.set("folk", ["country", "bluegrass", "acoustic"]);
    this.genreGraph.set("urban", ["rnb", "soul", "funk"]);
  }

  async initialize(context: PluginContext): Promise<boolean> {
    const ok = await super.initialize(context);
    if (!ok) return false;
    this.context = context;

    // Subscribe to PubSub announcements
    const pubsub = this.context.libp2p.services.pubsub;
    if (pubsub) {
      await pubsub.subscribe(this.ANNOUNCE_TOPIC);
      pubsub.addEventListener("message", (evt: any) => {
        if (evt.detail.topic !== this.ANNOUNCE_TOPIC) return;
        try {
          const msg = JSON.parse(new TextDecoder().decode(evt.detail.data)) as AnnouncementPayload;
          if (msg.type === "new-track") {
            const { cid, metadata, peerId } = msg;
            // store discovered track
            this.discoveredTracks.set(cid, { peerId, metadata });
          }
        } catch {
          // ignore
        }
      });
    }

    return true;
  }

  async start(): Promise<void> {
    await super.start();
    // Periodically attempt to identify music-capable peers
    this.startPeerDiscovery();
  }

  async stop(): Promise<void> {
    await super.stop();
  }

  /** No-op to avoid double registration */
  setupProtocols(): void {}

  /** Handle incoming libp2p protocol streams */
  async handleProtocol(protocol: string, stream: any, peerId: string): Promise<void> {
    switch (protocol) {
      case "/music-discovery/1.0.0":
        await this.handleMusicDiscoveryRequest(stream, peerId);
        break;
      case "/music-recommendations/1.0.0":
        await this.handleRecommendationRequest(stream, peerId);
        break;
      case "/music-metadata/1.0.0":
        await this.handleMetadataRequest(stream, peerId);
        break;
      case "/music-stream/1.0.0":
        await this.handleStreamRequest(stream, peerId);
        break;
      default:
        break;
    }
  }

  /** Return true if file is audio based on MIME type */
  canHandleFile(file: FileInfo): boolean {
    return file.type.startsWith("audio/");
  }

  /**
   * Enhance metadata for a newly uploaded file by parsing filename patterns:
   * - "Artist - Album - Title"
   * - "Artist - Title"
   * - Extract year
   * - Guess genre
   */
  async enhanceMetadata(file: UploadFile): Promise<MusicMetadata> {
    if (!file || file.size === 0) {
      throw new Error("MusicNetworkPlugin: Invalid file provided");
    }
    const metadata: MusicMetadata = {};
    const fileNameWithoutExt = file.name.replace(/\.[^/.]+$/, "");

    // Pattern: Artist - Album - Title
    const tripleMatch = fileNameWithoutExt.match(/^(.+?)\s*-\s*(.+?)\s*-\s*(.+?)$/);
    if (tripleMatch) {
      metadata.artist = tripleMatch[1].trim();
      metadata.album = tripleMatch[2].trim();
      metadata.title = tripleMatch[3].trim();
    } else {
      // Pattern: Artist - Title
      const duoMatch = fileNameWithoutExt.match(/^(.+?)\s*-\s*(.+?)$/);
      if (duoMatch) {
        metadata.artist = duoMatch[1].trim();
        metadata.title = duoMatch[2].trim();
      } else {
        metadata.title = fileNameWithoutExt;
      }
    }

    // Extract year if present
    const yearMatch = fileNameWithoutExt.match(/\b(19|20)\d{2}\b/);
    if (yearMatch) {
      metadata.year = parseInt(yearMatch[0], 10);
    }

    // Guess genre
    const lowerName = fileNameWithoutExt.toLowerCase();
    for (const [genre, keywords] of this.genreGraph.entries()) {
      if (keywords.some((kw) => lowerName.includes(kw))) {
        metadata.genre = genre;
        break;
      }
    }

    return metadata;
  }

  /** Search local + discovered tracks according to MusicDiscoveryQuery */
  async searchFiles(query: any): Promise<NetworkFileInfo[]> {
    if (!this.context) {
      throw new Error("MusicNetworkPlugin: missing context");
    }
    if (typeof query !== "object") {
      throw new Error("MusicNetworkPlugin: Invalid search query provided");
    }
    const q = query as MusicDiscoveryQuery;
    const results: NetworkFileInfo[] = [];

    // Local files
    for (const file of Array.from(this.context.files.values())) {
      if (!this.canHandleFile(file) || !file.metadata) continue;
      let score = 0;
      const md = file.metadata as MusicMetadata;

      if (q.artist && md.artist) {
        if (md.artist.toLowerCase().includes(q.artist.toLowerCase())) {
          score += 10;
        }
      }
      if (q.album && md.album) {
        if (md.album.toLowerCase().includes(q.album.toLowerCase())) {
          score += 8;
        }
      }
      if (q.genre && md.genre) {
        if (md.genre.toLowerCase() === q.genre.toLowerCase()) {
          score += 7;
        } else if (this.isRelatedGenre(md.genre, q.genre)) {
          score += 4;
        }
      }
      if (score > 0) {
        results.push({
          ...file,
          peerId: this.context.nodeId,
          peerAddress: "local",
          availability: "online",
        });
      }
    }

    // Discovered remote tracks
    for (const [cid, { peerId, metadata }] of this.discoveredTracks.entries()) {
      let score = 0;
      if (q.artist && metadata.artist) {
        if (metadata.artist.toLowerCase().includes(q.artist.toLowerCase())) {
          score += 10;
        }
      }
      if (q.album && metadata.album) {
        if (metadata.album.toLowerCase().includes(q.album.toLowerCase())) {
          score += 8;
        }
      }
      if (q.genre && metadata.genre) {
        if (metadata.genre.toLowerCase() === q.genre.toLowerCase()) {
          score += 7;
        } else if (this.isRelatedGenre(metadata.genre, q.genre)) {
          score += 4;
        }
      }
      if (score > 0) {
        results.push({
          cid,
          name: metadata.title || cid,
          size: 0, // unknown for remote
          type: "audio/unknown",
          uploadDate: new Date(),
          encrypted: false,
          storageMode: "ipfs",
          streamId: undefined,
          pinned: false,
          shareLink: `vinyl://ipfs/${cid}`,
          metadata,
          peerId,
          peerAddress: "network",
          availability: "online",
        });
      }
    }

    return results;
  }

  /** Provide recommendations based on shared metadata heuristics */
  async getRecommendations(basedOnCid: string): Promise<NetworkFileInfo[]> {
    if (!this.context) {
      throw new Error("MusicNetworkPlugin: missing context");
    }
    const candidates: Array<NetworkFileInfo & { _score: number }> = [];
    let baseMetadata: MusicMetadata | undefined;
    let basePeerId: string | undefined;

    // Check local first
    const baseLocal = this.context.files.get(basedOnCid);
    if (baseLocal && baseLocal.metadata) {
      baseMetadata = baseLocal.metadata as MusicMetadata;
      basePeerId = this.context.nodeId;
    } else if (this.discoveredTracks.has(basedOnCid)) {
      const rec = this.discoveredTracks.get(basedOnCid)!;
      baseMetadata = rec.metadata;
      basePeerId = rec.peerId;
    }

    if (!baseMetadata) {
      throw new Error(`MusicNetworkPlugin: Base file ${basedOnCid} not found`);
    }

    const evaluate = (
      file: FileInfo | { cid: string; metadata: MusicMetadata; peerId: string },
    ) => {
      let score = 0;
      const md = ("metadata" in file ? file.metadata : file.metadata) as MusicMetadata;
      // Same artist
      if (baseMetadata!.artist && md.artist === baseMetadata!.artist) {
        score += 15;
      }
      // Same genre
      if (baseMetadata!.genre && md.genre === baseMetadata!.genre) {
        score += 10;
      } else if (
        baseMetadata!.genre &&
        md.genre &&
        this.isRelatedGenre(baseMetadata!.genre, md.genre)
      ) {
        score += 6;
      }
      return score;
    };

    // Local candidates
    for (const file of Array.from(this.context.files.values())) {
      if (file.cid === basedOnCid || !this.canHandleFile(file) || !file.metadata) continue;
      const sc = evaluate(file);
      if (sc >= 5) {
        candidates.push({
          ...file,
          peerId: this.context.nodeId,
          peerAddress: "local",
          availability: "online",
          _score: sc,
        });
      }
    }

    // Remote candidates
    for (const [cid, rec] of this.discoveredTracks.entries()) {
      if (cid === basedOnCid) continue;
      const sc = evaluate({ cid, metadata: rec.metadata, peerId: rec.peerId });
      if (sc >= 5) {
        candidates.push({
          cid,
          name: rec.metadata.title || cid,
          size: 0,
          type: "audio/unknown",
          uploadDate: new Date(),
          encrypted: false,
          storageMode: "ipfs",
          streamId: undefined,
          pinned: false,
          shareLink: `vinyl://ipfs/${cid}`,
          metadata: rec.metadata,
          peerId: rec.peerId,
          peerAddress: "network",
          availability: "online",
          _score: sc,
        } as NetworkFileInfo & { _score: number });
      }
    }

    candidates.sort((a, b) => (b as any)._score - (a as any)._score);
    return candidates.slice(0, 10).map((c) => {
      delete (c as any)._score;
      return c;
    });
  }

  /** Check if two genres are related via genreGraph */
  private isRelatedGenre(g1: string, g2: string): boolean {
    const rel1 = this.genreGraph.get(g1.toLowerCase()) || [];
    const rel2 = this.genreGraph.get(g2.toLowerCase()) || [];
    return rel1.includes(g2.toLowerCase()) || rel2.includes(g1.toLowerCase());
  }

  /** Called when a peer connects: attempt to identify as music peer via custom protocol */
  onPeerConnected(peerId: string, peer: PeerInfo): void {
    if (!this.context || !this.context.libp2p.isStarted) return;
    this.context.libp2p
      .dialProtocol(peerId, "/music-network/1.0.0")
      .then(() => {
        this.musicPeers.add(peerId);
      })
      .catch(() => {
        // not a music peer
      });
  }

  /** Called when a peer disconnects: remove from musicPeers */
  onPeerDisconnected(peerId: string, peer: PeerInfo): void {
    this.musicPeers.delete(peerId);
  }

  /** Called when a file is uploaded: store metadata, announce, index */
  async onFileUploaded(cid: string, fileInfo: FileInfo): Promise<void> {
    if (this.canHandleFile(fileInfo) && fileInfo.metadata) {
      const md = fileInfo.metadata as MusicMetadata;
      this.musicMetadata.set(cid, md);
      // Announce to network
      const pubsub = this.context.libp2p.services.pubsub;
      if (pubsub) {
        const payload: AnnouncementPayload = {
          type: "new-track",
          cid,
          metadata: md,
          peerId: this.context.nodeId,
        };
        pubsub
          .publish(this.ANNOUNCE_TOPIC, new TextEncoder().encode(JSON.stringify(payload)))
          .catch(() => {});
      }
    }
  }

  /** Called when a file is downloaded: no-op */
  onFileDownloaded(cid: string): void {
    // could track metrics or demand
  }

  // ─── HTTP ROUTES ───

  getHttpNamespace(): string {
    return "/api/music";
  }

  getHttpRouter(): Router {
    const router = Router();

    // — Upload endpoint
    router.post("/upload", this.upload.single("file"), this.handleHttpUpload());

    // — Search endpoint
    router.post("/search", this.handleHttpSearch());

    // — Recommendations endpoint
    router.get("/recommendations/:cid", this.handleHttpRecommend());

    // — Metadata retrieval
    router.get("/metadata/:cid", this.handleHttpMetadata());

    // — List all local music
    router.get("/all", this.handleHttpListAll());

    // — Stats endpoint
    router.get("/stats", this.handleHttpStats());

    // — Stream endpoint (HTTP range support)
    router.get("/stream/:cid", this.handleHttpStream());

    // — Playlist endpoints
    router.post("/playlist", express.json(), this.handleCreatePlaylist());
    router.get("/playlist/:name", this.handleGetPlaylist());
    router.put("/playlist/:name", express.json(), this.handleUpdatePlaylist());
    router.delete("/playlist/:name", this.handleDeletePlaylist());

    return router;
  }

  /** Handle HTTP upload: store on Helia/IPFS, index in fileDb, emit events */
  private handleHttpUpload(): RequestHandler {
    return async (req, res) => {
      try {
        const file = req.file;
        if (!file || !file.buffer) {
          res.status(400).json({ error: "Missing file (field=name='file')" });
          return;
        }

        // Enhance metadata
        const md = await this.enhanceMetadata({
          name: file.originalname,
          size: file.size,
          type: file.mimetype || "application/octet-stream",
          arrayBuffer: async () => {
            const ab = new ArrayBuffer(file.buffer.byteLength);
            new Uint8Array(ab).set(file.buffer);
            return ab;
          },
        });

        // Add bytes to Helia/IPFS

        const fs = unixfs(this.context.helia);
        const cidObj = await fs.addBytes(file.buffer);
        const cidStr = cidObj.toString();

        // Build FileInfo
        const mimeType =
          file.mimetype || (mime.lookup(file.originalname) as string) || "application/octet-stream";
        const fileInfo: FileInfo = {
          cid: cidStr,
          name: file.originalname,
          size: file.size,
          type: mimeType,
          uploadDate: new Date(),
          encrypted: false,
          storageMode: "ipfs",
          streamId: undefined,
          pinned: false,
          shareLink: `vinyl://ipfs/${cidStr}`,
          metadata: md,
        };

        // Persist FileInfo in LevelDB
        await this.context.fileDb.put(cidStr, fileInfo);

        // Notify core/UI
        this.context.emit("fileUploaded", { source: "music-plugin", payload: cidStr });

        res.json({ cid: cidStr, metadata: md });
      } catch (err: any) {
        console.error("[MusicNetworkPlugin] upload failed:", err);
        res.status(500).json({ error: err.message });
      }
    };
  }

  /** Handle HTTP search */
  private handleHttpSearch(): RequestHandler {
    return async (req, res) => {
      try {
        const query = req.body as MusicDiscoveryQuery;
        const results = await this.searchFiles(query);
        res.json({ results });
      } catch (err: any) {
        res.status(400).json({ error: err.message });
      }
    };
  }

  /** Handle HTTP recommendations */
  private handleHttpRecommend(): RequestHandler {
    return async (req, res) => {
      try {
        const { cid } = req.params;
        const recs = await this.getRecommendations(cid);
        res.json({ recommendations: recs });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    };
  }

  /** Handle HTTP metadata retrieval */
  private handleHttpMetadata(): RequestHandler {
    return (req, res) => {
      try {
        const { cid } = req.params;
        let md: MusicMetadata | undefined;
        // check local
        const local = this.context.fileDb.get(cid).catch(() => undefined);
        Promise.resolve(local).then((fi) => {
          if (fi && fi.metadata) {
            md = fi.metadata as MusicMetadata;
            res.json(md);
          } else if (this.discoveredTracks.has(cid)) {
            md = this.discoveredTracks.get(cid)!.metadata;
            res.json(md);
          } else {
            res.status(404).json({ error: `Metadata not found for ${cid}` });
          }
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    };
  }

  /** Handle HTTP list all local music files */
  private handleHttpListAll(): RequestHandler {
    return async (_req, res) => {
      try {
        const all = Array.from(this.context.files.values()).filter((f) => this.canHandleFile(f));
        res.json({ files: all });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    };
  }

  /** Handle HTTP stats: total files, genre distribution, top artists, connected peers */
  private handleHttpStats(): RequestHandler {
    return (_req, res) => {
      try {
        const stats = this.getMusicStats();
        res.json(stats);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    };
  }

  private handleHttpStream(): RequestHandler {
    return async (req, res) => {
      try {
        const { cid: cidStr } = req.params;

        // 1. Parse the string into a CID instance
        const cidObj = CID.parse(cidStr);

        // 2. Wrap Helia in UnixFS and stream the file by CID
        const fs = unixfs(this.context.helia);
        const chunks: Uint8Array[] = [];
        for await (const chunk of fs.cat(cidObj)) {
          chunks.push(chunk);
        }
        const fullBuffer = Buffer.concat(chunks.map((u) => Buffer.from(u)));

        // 3. Support HTTP Range requests as before
        const range = req.headers.range;
        const fileSize = fullBuffer.length;
        const contentType = mime.lookup(cidStr) || "audio/mpeg";

        if (range) {
          const parts = range.replace(/bytes=/, "").split("-");
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
          const chunkSize = end - start + 1;
          const streamBuffer = fullBuffer.slice(start, end + 1);

          res.writeHead(206, {
            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
            "Accept-Ranges": "bytes",
            "Content-Length": chunkSize,
            "Content-Type": contentType,
          });
          res.end(streamBuffer);
        } else {
          res.writeHead(200, {
            "Content-Length": fileSize,
            "Content-Type": contentType,
          });
          res.end(fullBuffer);
        }
      } catch (err: any) {
        console.error("[MusicNetworkPlugin] stream error:", err);
        res.status(404).json({ error: "Stream not available" });
      }
    };
  }

  /** Handle HTTP create playlist */
  private handleCreatePlaylist(): RequestHandler {
    return async (req, res) => {
      try {
        const { name, trackCids } = req.body as {
          name: string;
          trackCids: string[];
        };
        if (!name || !Array.isArray(trackCids)) {
          res.status(400).json({ error: "Invalid payload" });
          return;
        }
        const playlist: Playlist = {
          name,
          ownerPeer: this.context.nodeId,
          trackCids,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        this.playlists.set(name, playlist);
        res.json({ success: true, playlist });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    };
  }

  /** Handle HTTP get playlist */
  private handleGetPlaylist(): RequestHandler {
    return (req, res) => {
      try {
        const { name } = req.params;
        const pl = this.playlists.get(name);
        if (!pl) {
          res.status(404).json({ error: `Playlist ${name} not found` });
          return;
        }
        res.json(pl);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    };
  }

  /** Handle HTTP update playlist */
  private handleUpdatePlaylist(): RequestHandler {
    return (req, res) => {
      try {
        const { name } = req.params;
        const pl = this.playlists.get(name);
        if (!pl) {
          res.status(404).json({ error: `Playlist ${name} not found` });
          return;
        }
        const { trackCids } = req.body as { trackCids: string[] };
        if (!Array.isArray(trackCids)) {
          res.status(400).json({ error: "Invalid payload" });
          return;
        }
        pl.trackCids = trackCids;
        pl.updatedAt = new Date().toISOString();
        this.playlists.set(name, pl);
        res.json({ success: true, playlist: pl });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    };
  }

  /** Handle HTTP delete playlist */
  private handleDeletePlaylist(): RequestHandler {
    return (req, res) => {
      try {
        const { name } = req.params;
        if (!this.playlists.has(name)) {
          res.status(404).json({ error: `Playlist ${name} not found` });
          return;
        }
        this.playlists.delete(name);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    };
  }

  // ─── Internal Protocol Handlers ───

  private async handleMusicDiscoveryRequest(stream: any, peerId: string) {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream.source) {
        chunks.push(chunk);
      }
      const data = new TextDecoder().decode(chunks[0]);
      const query: MusicDiscoveryQuery = JSON.parse(data);
      const results = await this.searchFiles(query);
      const response = JSON.stringify({ type: "discovery-results", results });
      await stream.sink([new TextEncoder().encode(response)]);
    } catch (err: any) {
      console.error("MusicNetworkPlugin: Discovery error:", err);
    }
  }

  private async handleRecommendationRequest(stream: any, peerId: string) {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream.source) {
        chunks.push(chunk);
      }
      const data = new TextDecoder().decode(chunks[0]);
      const request = JSON.parse(data);
      if (request.type === "recommendation-request" && request.basedOn) {
        const recs = await this.getRecommendations(request.basedOn);
        const response = JSON.stringify({
          type: "recommendations",
          recommendations: recs,
        });
        await stream.sink([new TextEncoder().encode(response)]);
      }
    } catch (err: any) {
      console.error("MusicNetworkPlugin: Recommendation error:", err);
    }
  }

  private async handleMetadataRequest(stream: any, peerId: string) {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream.source) {
        chunks.push(chunk);
      }
      const data = new TextDecoder().decode(chunks[0]);
      const request = JSON.parse(data);
      if (request.type === "metadata-request" && request.cid) {
        const mdLocal = this.musicMetadata.get(request.cid) || null;
        const mdRemote = this.discoveredTracks.get(request.cid)?.metadata || null;
        const metadata = mdLocal || mdRemote;
        const response = JSON.stringify({
          type: "metadata-response",
          cid: request.cid,
          metadata,
        });
        await stream.sink([new TextEncoder().encode(response)]);
      }
    } catch (err: any) {
      console.error("MusicNetworkPlugin: Metadata error:", err);
    }
  }

  private async handleStreamRequest(stream: any, peerId: string) {
    try {
      // 1. Read the incoming request payload
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream.source) {
        chunks.push(chunk);
      }
      const data = new TextDecoder().decode(chunks[0]);
      const request = JSON.parse(data);

      if (request.type === "stream-request" && request.cid) {
        // 2. Wrap Helia in UnixFS and fetch the file by CID
        const fs = unixfs(this.context.helia);
        for await (const dataChunk of fs.cat(request.cid)) {
          // 3. Send each chunk back to the requester
          await stream.sink([dataChunk]);
        }
      }
    } catch (err: any) {
      console.error("MusicNetworkPlugin: Stream error:", err);
    }
  }

  /** Entry point: connect to peers and announce this node supports music‐network protocol */
  private startPeerDiscovery(): void {
    setInterval(async () => {
      if (this.context?.libp2p && this.context.libp2p.isStarted) {
        const connections = this.context.libp2p.getConnections();
        for (const conn of connections) {
          try {
            await this.context.libp2p.dialProtocol(conn.remotePeer, "/music-network/1.0.0");
            this.musicPeers.add(conn.remotePeer.toString());
          } catch {
            // not a music network peer
          }
        }
      }
    }, 15000);
  }

  // ─── Public Utility Methods ───

  /**
   * Compute basic music stats: total files, genre distribution, top artists, connected peers
   */
  getMusicStats(): {
    totalMusicFiles: number;
    genreDistribution: Record<string, number>;
    topArtists: { artist: string; count: number }[];
    connectedMusicPeers: number;
  } {
    if (!this.context) {
      throw new Error("MusicNetworkPlugin: missing context");
    }

    const genreCount: Map<string, number> = new Map();
    const artistCount: Map<string, number> = new Map();
    let totalMusicFiles = 0;

    for (const file of Array.from(this.context.files.values())) {
      if (this.canHandleFile(file) && file.metadata) {
        totalMusicFiles++;
        const md = file.metadata as MusicMetadata;
        if (md.genre) {
          genreCount.set(md.genre, (genreCount.get(md.genre) || 0) + 1);
        }
        if (md.artist) {
          artistCount.set(md.artist, (artistCount.get(md.artist) || 0) + 1);
        }
      }
    }

    for (const [cid, rec] of this.discoveredTracks.entries()) {
      const md = rec.metadata;
      totalMusicFiles++;
      if (md.genre) {
        genreCount.set(md.genre, (genreCount.get(md.genre) || 0) + 1);
      }
      if (md.artist) {
        artistCount.set(md.artist, (artistCount.get(md.artist) || 0) + 1);
      }
    }

    const genreDistribution: Record<string, number> = {};
    for (const [g, count] of genreCount) {
      genreDistribution[g] = count;
    }

    const topArtists = Array.from(artistCount.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([artist, count]) => ({ artist, count }));

    return {
      totalMusicFiles,
      genreDistribution,
      topArtists,
      connectedMusicPeers: this.musicPeers.size,
    };
  }

  /** Fetch all locally stored music FileInfo */
  getAllMusicFiles(): FileInfo[] {
    if (!this.context) {
      throw new Error("MusicNetworkPlugin: missing context");
    }
    return Array.from(this.context.files.values()).filter((f) => this.canHandleFile(f));
  }
}

export * from "./types.js";
