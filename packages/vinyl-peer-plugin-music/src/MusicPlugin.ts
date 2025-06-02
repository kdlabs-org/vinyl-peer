import express, { Request, Response, Router } from "express";
import {
  BasePlugin,
  PluginCapabilities,
  PluginContext,
  VinylPeerPlugin,
} from "vinyl-peer-protocol";
import { PeerInfo, FileInfo, NetworkFileInfo, UploadFile } from "vinyl-peer-protocol";
import { MusicMetadata, MusicDiscoveryQuery, MusicRecommendation } from "./types.js";

export class MusicPlugin extends BasePlugin implements VinylPeerPlugin {
  protected context!: PluginContext;
  private musicMetadata: Map<string, MusicMetadata> = new Map();
  private genreGraph: Map<string, string[]> = new Map();
  private musicPeers: Set<string> = new Set();

  constructor() {
    super();
    this.initializeMusicKnowledge();
  }

  /** Declare plugin identity, supported protocols, capabilities, file types, and permissions. */
  getCapabilities(): PluginCapabilities {
    return {
      name: "vinyl-peer-music-plugin",
      version: "1.0.0",
      protocols: [
        "/music-discovery/1.0.0",
        "/music-recommendations/1.0.0",
        "/music-metadata/1.0.0",
        "/vinyl-network/1.0.0",
      ],
      capabilities: ["streaming", "discovery", "recommendations", "metadata"],
      fileTypes: ["audio/*"],
      permissions: {
        accessFiles: true,
        useNetwork: true,
        modifyPeers: true,
        exposeHttp: true,
      },
    };
  }

  /** Build a simple "related genre" map for heuristic recommendations. */
  private initializeMusicKnowledge(): void {
    this.genreGraph.set("rock", ["alternative", "indie", "punk", "metal"]);
    this.genreGraph.set("electronic", ["techno", "house", "ambient", "dubstep"]);
    this.genreGraph.set("jazz", ["blues", "fusion", "swing", "bebop"]);
    this.genreGraph.set("classical", ["baroque", "romantic", "contemporary"]);
    this.genreGraph.set("hip-hop", ["rap", "trap", "old-school"]);
    this.genreGraph.set("folk", ["country", "bluegrass", "acoustic"]);
  }

  /** Standard initialize; store context and mark as initialized. */
  async initialize(context: PluginContext): Promise<boolean> {
    const ok = await super.initialize(context);
    if (!ok) return false;
    this.context = context;
    return true;
  }

  /** Once NodeService has started, set up libp2p protocol handlers. */
  async start(): Promise<void> {
    await super.start();
  }

  /** Stop any running intervals or services (nothing to clean up here). */
  async stop(): Promise<void> {
    await super.stop();
  }

  /** No-op here: PluginManager already registers protocol handlers. */
  setupProtocols(): void {
    // Intentionally empty to avoid duplicate libp2p.handle calls
  }

  /**
   * Called by PluginManager when a protocol‐matched stream arrives.
   */
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
      case "/vinyl-network/1.0.0":
        this.handleMusicNetworkIdentification(peerId, [
          "streaming",
          "discovery",
          "recommendations",
        ]);
        break;
      default:
        break;
    }
  }

  /** Return true if this plugin handles audio files. */
  canHandleFile(file: FileInfo): boolean {
    return file.type.startsWith("audio/");
  }

  /**
   * Enhance a newly uploaded file’s metadata by parsing filename patterns:
   * - "Artist - Album - Title"
   * - "Artist - Title"
   * - Extract year if present
   * - Guess genre via simple keyword matching
   */
  async enhanceMetadata(file: UploadFile): Promise<MusicMetadata> {
    if (!file || file.size === 0) {
      throw new Error("MusicPlugin: Invalid file provided");
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

    // Extract year (four digits starting with 19 or 20)
    const yearMatch = fileNameWithoutExt.match(/\b(19|20)\d{2}\b/);
    if (yearMatch) {
      metadata.year = parseInt(yearMatch[0], 10);
    }

    // Guess genre from filename keywords
    const lowerName = fileNameWithoutExt.toLowerCase();
    for (const [genre, keywords] of this.genreGraph.entries()) {
      if (keywords.some((kw) => lowerName.includes(kw))) {
        metadata.genre = genre;
        break;
      }
    }

    return metadata;
  }

  /**
   * Search local files (context.files) for matches to a MusicDiscoveryQuery.
   * Only returns results where canHandleFile(file) is true and score > 0.
   */
  async searchFiles(query: any): Promise<NetworkFileInfo[]> {
    if (!this.context) {
      throw new Error("MusicPlugin: missing context");
    }
    if (typeof query !== "object") {
      throw new Error("MusicPlugin: Invalid search query provided (expected object)");
    }
    const q = query as MusicDiscoveryQuery;
    const results: NetworkFileInfo[] = [];

    for (const file of Array.from(this.context.files.values())) {
      if (!this.canHandleFile(file) || !file.metadata) continue;
      let score = 0;
      const md = file.metadata as MusicMetadata;

      // Artist matching
      if (q.artist && md.artist) {
        if (md.artist.toLowerCase().includes(q.artist.toLowerCase())) {
          score += 10;
        }
      }
      // Album matching
      if (q.album && md.album) {
        if (md.album.toLowerCase().includes(q.album.toLowerCase())) {
          score += 8;
        }
      }
      // Genre matching
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

    return results;
  }

  /**
   * Provide recommendations for a given base CID:
   *  - +15 if same artist
   *  - +10 if same genre
   *  - +6 if related genre
   * Returns top 10 with score >= 5.
   */
  async getRecommendations(basedOnCid: string): Promise<NetworkFileInfo[]> {
    if (!this.context) {
      throw new Error("MusicPlugin: missing context");
    }
    const baseFile = this.context.files.get(basedOnCid);
    if (!baseFile || !baseFile.metadata) {
      throw new Error(`MusicPlugin: Base file ${basedOnCid} not found or missing metadata`);
    }
    const baseMetadata = baseFile.metadata as MusicMetadata;
    const candidates: Array<NetworkFileInfo & { _score: number }> = [];

    for (const file of Array.from(this.context.files.values())) {
      if (file.cid === basedOnCid || !this.canHandleFile(file) || !file.metadata) {
        continue;
      }
      const md = file.metadata as MusicMetadata;
      let score = 0;

      // Same artist
      if (baseMetadata.artist && md.artist === baseMetadata.artist) {
        score += 15;
      }
      // Same genre
      if (baseMetadata.genre && md.genre === baseMetadata.genre) {
        score += 10;
      } else if (
        baseMetadata.genre &&
        md.genre &&
        this.isRelatedGenre(baseMetadata.genre, md.genre)
      ) {
        score += 6;
      }

      if (score >= 5) {
        candidates.push({
          ...file,
          peerId: this.context.nodeId,
          peerAddress: "local",
          availability: "online",
          _score: score,
        } as NetworkFileInfo & { _score: number });
      }
    }

    // Sort by descending score
    candidates.sort((a, b) => b._score - a._score);
    // Return top 10
    return candidates.slice(0, 10).map((c) => ({
      cid: c.cid,
      name: c.name,
      size: c.size,
      type: c.type,
      uploadDate: c.uploadDate,
      encrypted: c.encrypted,
      storageMode: c.storageMode,
      streamId: c.streamId,
      pinned: c.pinned,
      shareLink: c.shareLink,
      audioCID: c.audioCID,
      audioStreamId: c.audioStreamId,
      metadata: c.metadata,
      peerId: c.peerId,
      peerAddress: c.peerAddress,
      availability: c.availability,
    }));
  }

  /** Check if two genres are “related” by our simple genreGraph. */
  private isRelatedGenre(g1: string, g2: string): boolean {
    const rel1 = this.genreGraph.get(g1.toLowerCase()) || [];
    const rel2 = this.genreGraph.get(g2.toLowerCase()) || [];
    return rel1.includes(g2.toLowerCase()) || rel2.includes(g1.toLowerCase());
  }

  /** Called by PluginManager when any peer connects. */
  onPeerConnected(peerId: string, peer: PeerInfo): void {
    if (peer.isMusicNode) {
      console.log(`MusicPlugin: connected music peer ${peerId.substring(0, 16)}…`);
      this.musicPeers.add(peerId);
      this.emit("musicPeerConnected", { peerId, peer });
    }
  }

  /** Called by PluginManager when any peer disconnects. */
  onPeerDisconnected(peerId: string, peer: PeerInfo): void {
    this.musicPeers.delete(peerId);
  }

  /** Called by PluginManager when any file is uploaded. */
  onFileUploaded(cid: string, fileInfo: FileInfo): void {
    if (this.canHandleFile(fileInfo) && fileInfo.metadata) {
      this.musicMetadata.set(cid, fileInfo.metadata as MusicMetadata);
      console.log(`MusicPlugin: new music file "${fileInfo.name}" (CID=${cid})`);
      this.emit("musicFileUploaded", {
        cid,
        name: fileInfo.name,
        metadata: fileInfo.metadata,
      });
    }
  }

  /** Called by PluginManager when any file is downloaded. */
  onFileDownloaded(cid: string): void {
    this.emit("musicFileDownloaded", { cid });
  }

  // ─────────——— HTTP Extension Hooks ———─────────

  /** Declare the HTTP namespace under which this plugin will mount its routes. */
  getHttpNamespace(): string {
    return "/api/music";
  }

  /** Return an Express router containing all music‐specific endpoints. */
  getHttpRouter(): express.Router {
    const router = express.Router();

    /**
     * GET /api/music/recommendations/:cid
     * → Return recommendations for the given music metadata CID.
     */
    router.get("/recommendations/:cid", async (req: Request, res: Response) => {
      try {
        const { cid } = req.params;
        const recs = await this.getRecommendations(cid);
        res.json({ recommendations: recs });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    /**
     * GET /api/music/stats
     * → Return aggregated music stats: totalMusicFiles, genreDistribution, topArtists, connectedMusicPeers.
     */
    router.get("/stats", (req: Request, res: Response) => {
      try {
        const stats = this.getMusicStats();
        res.json(stats);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    /**
     * GET /api/music/metadata/:cid
     * → Return raw MusicMetadata for the given file CID, if present.
     */
    router.get("/metadata/:cid", (req: Request, res: Response) => {
      try {
        const { cid } = req.params;
        const md = this.getMusicMetadata(cid);
        if (!md) {
          res.status(404).json({ error: `No metadata found for CID ${cid}` });
          return;
        }
        res.json(md);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    /**
     * GET /api/music/all
     * → Return a list of all locally stored audio files (FileInfo[]).
     */
    router.get("/all", (req: Request, res: Response) => {
      try {
        const allMusic = this.getAllMusicFiles();
        res.json(allMusic);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    return router;
  }

  // ─────────—— Public API Methods for Frontend ———────────

  getMusicStats(): {
    totalMusicFiles: number;
    genreDistribution: Record<string, number>;
    topArtists: { artist: string; count: number }[];
    connectedMusicPeers: number;
  } {
    if (!this.context) {
      throw new Error("MusicPlugin: missing context");
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

  getMusicMetadata(cid: string): MusicMetadata | undefined {
    return this.musicMetadata.get(cid);
  }

  getAllMusicFiles(): FileInfo[] {
    if (!this.context) {
      throw new Error("MusicPlugin: missing context");
    }
    return Array.from(this.context.files.values()).filter((f) => this.canHandleFile(f));
  }

  // ─────────——— Internal Protocol Handlers ———─────────

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
      console.error("MusicPlugin: Discovery error:", err);
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
      console.error("MusicPlugin: Recommendation error:", err);
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
        const metadata = this.musicMetadata.get(request.cid) || null;
        const response = JSON.stringify({
          type: "metadata-response",
          cid: request.cid,
          metadata,
        });
        await stream.sink([new TextEncoder().encode(response)]);
      }
    } catch (err: any) {
      console.error("MusicPlugin: Metadata error:", err);
    }
  }

  private handleMusicNetworkIdentification(peerId: string, capabilities: string[]) {
    if (!this.context) return;
    const existingPeer = this.context.peers.get(peerId);
    if (existingPeer) {
      existingPeer.isMusicNode = true;
      existingPeer.musicNodeCapabilities = capabilities;
      this.musicPeers.add(peerId);
      console.log(`MusicPlugin: identified music peer "${peerId.substring(0, 16)}..."`);
      this.emit("musicPeerConnected", { peerId, peer: existingPeer });
    }
  }

  /**
   * Every 15 seconds, dial connected peers to see if they support /vinyl-network/1.0.0.
   * If dial succeeds, that peer is a music node.
   */
  private startCapabilityAnnouncements(): void {
    setInterval(async () => {
      if (this.context?.libp2p && this.context.libp2p.isStarted) {
        const connections = this.context.libp2p.getConnections();
        for (const conn of connections) {
          try {
            await this.context!.libp2p.dialProtocol(conn.remotePeer, "/vinyl-network/1.0.0");
          } catch {
            // Peer doesn't support music protocol
          }
        }
      }
    }, 15000);
  }
}
