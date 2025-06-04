/*
 * =========================
 * V (Vinyl Microblog) Plugin
 * =========================
 * Provides Twitter-like microblogging capabilities on Vinyl.
 *
 * Features:
 *  - User identity via libp2p PeerId + rotation support
 *  - Create, edit, and retrieve micro-posts (up to 280 chars)
 *  - Follow/unfollow peers, view timeline (own + followed)
 *  - Real-time updates via PubSub + SSE
 *  - Historical catch-up via allPosts endpoint
 *  - Key rotation with identity registry
 *
 * Structure mirrors other Vinyl plugins:
 *  - getCapabilities(): PluginCapabilities
 *  - initialize(context)
 *  - start(): subscribe to PubSub, plugin manager will mount HTTP via getHttpRouter()
 *  - stop(): close DBs
 *  - setupProtocols(): (none)
 *  - handleProtocol(): (none)
 *
 * Data Storage:
 *  - postDb: LevelDB mapping postId → MicroPost
 *  - followDb: LevelDB mapping peerId → string[] of followed peerIds
 *  - identityDb: LevelDB mapping handle → IdentityRecord
 *
 * HTTP Namespace: /api/v
 */

import type { Request, Response, Router } from "express";
import {
  BasePlugin,
  PluginContext,
  VinylPeerPlugin,
  PluginCapabilities,
} from "vinyl-peer-protocol";
import { Level } from "level";
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { sha256 } from "multiformats/hashes/sha2";
import crypto from "libp2p-crypto";

// --------------------
// Type Definitions
// --------------------

/** A single micro-post (up to 280 characters) */
export interface MicroPost {
  postId: string; // e.g. "<handle>-<timestamp>-<uuid>"
  author: string; // handle of the poster
  peerId: string; // actual libp2p PeerId used
  text: string; // up to 280 characters
  createdAt: string; // ISO timestamp
  replyTo?: string; // optional postId if this is a reply
}

/** Identity record linking a stable handle to libp2p keys (current + previous) */
export interface IdentityRecord {
  handle: string; // e.g. "alice"
  currentPeerId: string; // active libp2p PeerId
  previousPeerIds: string[]; // prior PeerIds
  createdAt: string; // timestamp of this record
  sig: string; // base64 signature by previous key (or self if initial)
}

/** PubSub event for new posts */
export interface NewPostEvent {
  type: "newPost";
  post: MicroPost;
}

/** PubSub event for follows/unfollows */
export interface FollowEvent {
  type: "follow" | "unfollow";
  from: string; // handle of actor
  to: string; // handle being (un)followed
  timestamp: string;
}

// --------------------
// Utility Functions
// --------------------

/**
 * Canonicalize a JSON object by sorting its keys lexicographically.
 * Returns a string suitable for signing/verifying.
 */
function canonicalize(obj: any): string {
  if (Array.isArray(obj)) {
    return `[${obj.map(canonicalize).join(",")}]`;
  }
  if (obj && typeof obj === "object") {
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `"${k}":${canonicalize(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(obj);
}

/**
 * Verify an Ed25519 signature given publicKey bytes, message, and base64 signature.
 */
async function verifySignature(
  publicKeyBytes: Uint8Array,
  message: Uint8Array,
  sigBase64: string,
): Promise<boolean> {
  const signature = Buffer.from(sigBase64, "base64");
  const publicKey = await crypto.keys.unmarshalPublicKey(publicKeyBytes);
  return publicKey.verify(message, signature);
}

// --------------------
// Authentication Middleware
// --------------------

/**
 * Require that requests carry:
 *  - x-peer-id: the libp2p PeerId string
 *  - x-signature: base64 signature over JSON.stringify(req.body)
 *  - req.body.timestamp: an ISO timestamp within ±2 minutes
 *
 * Verifies signature against the public key from peerStore.
 * Sets req.peerId and req.handle if valid.
 */
function createAuthMiddleware(context: PluginContext, identityDb: Level<string, IdentityRecord>) {
  return async function auth(
    req: Request & { peerId?: string; handle?: string },
    res: Response,
    next: any,
  ) {
    try {
      const peerIdStr = req.header("x-peer-id");
      const sigBase64 = req.header("x-signature");
      if (!peerIdStr || !sigBase64) {
        return res.status(401).json({ error: "Missing authentication headers" });
      }
      // Validate timestamp
      const body = req.body as any;
      const ts = body.timestamp;
      if (typeof ts !== "string") {
        return res.status(400).json({ error: "Missing or invalid timestamp" });
      }
      const then = Date.parse(ts);
      if (Number.isNaN(then)) {
        return res.status(400).json({ error: "Invalid timestamp format" });
      }
      const now = Date.now();
      if (Math.abs(now - then) > 2 * 60_000) {
        return res.status(401).json({ error: "Timestamp out of range" });
      }
      // Recompute message bytes
      const payloadStr = JSON.stringify(req.body);
      const payloadBytes = new TextEncoder().encode(payloadStr);
      const hash = await sha256.digest(payloadBytes);
      // Lookup PeerId’s public key
      let peerPubKeyBytes: Uint8Array;
      try {
        // In libp2p v0.26+, peerStore.get(peerId) returns PeerMetadata containing pubkey
        const peerRecord = await context.libp2p.peerStore.get(peerIdStr as any);
        if (!peerRecord || !peerRecord.publicKey) throw new Error("No public key");
        peerPubKeyBytes = (peerRecord.publicKey as any).bytes;
      } catch {
        return res.status(401).json({ error: "Unknown peerId or no public key" });
      }
      const sigOK = await verifySignature(peerPubKeyBytes, hash.bytes, sigBase64);
      if (!sigOK) {
        return res.status(401).json({ error: "Signature verification failed" });
      }
      // Determine handle: scan identityDb for a matching record
      let matchedHandle: string | null = null;
      for await (const [handle, rec] of identityDb.iterator()) {
        if (rec.currentPeerId === peerIdStr || rec.previousPeerIds.includes(peerIdStr)) {
          matchedHandle = handle;
          break;
        }
      }
      if (!matchedHandle) {
        return res.status(401).json({ error: "Unregistered or revoked peerId" });
      }
      req.peerId = peerIdStr;
      req.handle = matchedHandle;
      return next();
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  };
}

// --------------------
// VPlugin Implementation
// --------------------

export class VPlugin extends BasePlugin implements VinylPeerPlugin {
  protected context!: PluginContext;
  public postDb!: Level<string, MicroPost>;
  public followDb!: Level<string, string[]>;
  public identityDb!: Level<string, IdentityRecord>;

  getCapabilities(): PluginCapabilities {
    return {
      name: "vinyl-peer-plugin-v", // plugin name
      version: "0.0.1",
      protocols: [],
      capabilities: ["microblog", "identity", "social"],
      permissions: {
        accessFiles: false,
        useNetwork: true,
        modifyPeers: false,
        exposeHttp: true,
      },
    };
  }

  /** Open LevelDBs for posts, follows, and identities */
  async initialize(context: PluginContext): Promise<boolean> {
    const ok = await super.initialize(context);
    if (!ok) return false;
    this.context = context;
    this.postDb = new Level<string, MicroPost>("v-posts", { valueEncoding: "json" });
    this.followDb = new Level<string, string[]>("v-follows", { valueEncoding: "json" });
    this.identityDb = new Level<string, IdentityRecord>("v-identities", { valueEncoding: "json" });
    return true;
  }

  async start(): Promise<void> {
    await super.start();

    // Locate PubSub service (some libp2p versions put it under services.pubsub)
    const ps = (this.context.libp2p as any).pubsub ?? (this.context.libp2p as any).services?.pubsub;
    if (!ps) {
      throw new Error("PubSub service not available");
    }

    // Subscribe to newPost and follow topics
    await ps.subscribe("/v/posts/1.0.0");
    await ps.subscribe("/v/follows/1.0.0");

    // PubSub handlers: save incoming posts and follow events into local DBs
    ps.addEventListener("message", async (evt: any) => {
      const topic = evt.detail.topic;
      const data = new TextDecoder().decode(evt.detail.data);
      try {
        if (topic === "/v/posts/1.0.0") {
          const msg = JSON.parse(data) as NewPostEvent;
          const existing = await this.postDb.get(msg.post.postId).catch(() => null);
          if (!existing) {
            await this.postDb.put(msg.post.postId, msg.post);
          }
        } else if (topic === "/v/follows/1.0.0") {
          const fe = JSON.parse(data) as FollowEvent;
          const actor = fe.from;
          const current = await this.followDb.get(actor).catch(() => [] as string[]);
          if (fe.type === "follow" && !current.includes(fe.to)) {
            current.push(fe.to);
            await this.followDb.put(actor, current);
          }
          if (fe.type === "unfollow" && current.includes(fe.to)) {
            const updated = current.filter((x) => x !== fe.to);
            await this.followDb.put(actor, updated);
          }
        }
      } catch {
        // ignore malformed
      }
    });
  }

  async stop(): Promise<void> {
    await this.postDb.close();
    await this.followDb.close();
    await this.identityDb.close();
    await super.stop();
  }

  setupProtocols(): void {
    // No custom libp2p protocols (we use PubSub instead)
  }

  async handleProtocol(_protocol: string, _stream: any, _peerId: string): Promise<void> {
    // No custom protocol handlers
  }

  /** Return HTTP namespace under which plugin routes will mount */
  getHttpNamespace(): string {
    return "/api/v";
  }

  /** Build and return Express.Router for /api/v */
  getHttpRouter(): Router {
    const router = express.Router();
    const auth = createAuthMiddleware(this.context, this.identityDb);

    router.use(express.json());
    router.use(auth);

    // ----------------
    // Identity Routes
    // ----------------

    /** Register a new handle */
    router.post("/identity/register", async (req: Request, res: Response) => {
      try {
        const rec = req.body as IdentityRecord;
        // Check that rec.handle is new
        try {
          await this.identityDb.get(rec.handle);
          res.status(409).json({ error: "Handle already exists" });
          return;
        } catch {
          // OK
        }
        // Verify rec.sig using public key from rec.currentPeerId
        const payload = {
          handle: rec.handle,
          currentPeerId: rec.currentPeerId,
          previousPeerIds: rec.previousPeerIds,
          createdAt: rec.createdAt,
        };
        const canon = canonicalize(payload);
        const hash = await sha256.digest(new TextEncoder().encode(canon));
        // Lookup public key bytes
        const peerRecord = await this.context.libp2p.peerStore.get(rec.currentPeerId as any);
        if (!peerRecord || !peerRecord.publicKey) throw new Error("No public key for peerId");
        const pubKeyBytes = (peerRecord.publicKey as any).bytes;
        const ok = await verifySignature(pubKeyBytes, hash.bytes, rec.sig);
        if (!ok) {
          res.status(401).json({ error: "Signature invalid" });
          return;
        }
        // Save
        await this.identityDb.put(rec.handle, rec);
        res.json({ success: true, handle: rec.handle });
        return;
      } catch (err: any) {
        res.status(500).json({ error: err.message });
        return;
      }
    });

    /** Rotate to a new key */
    router.post("/identity/rotate", async (req: Request & { peerId?: string }, res: Response) => {
      try {
        const rec = req.body as IdentityRecord;
        // Fetch existing
        let existing: IdentityRecord;
        try {
          existing = await this.identityDb.get(rec.handle);
        } catch {
          res.status(404).json({ error: "No such identity to rotate" });
          return;
        }
        // Only currentPeerId can rotate
        if (req.peerId !== existing.currentPeerId) {
          res.status(403).json({ error: "Not authorized to rotate" });
          return;
        }
        // Verify rec.sig signed by old key
        const payload = {
          handle: rec.handle,
          currentPeerId: rec.currentPeerId,
          previousPeerIds: rec.previousPeerIds,
          createdAt: rec.createdAt,
        };
        const canon = canonicalize(payload);
        const hash = await sha256.digest(new TextEncoder().encode(canon));
        const oldPeerRecord = await this.context.libp2p.peerStore.get(
          existing.currentPeerId as any,
        );
        if (!oldPeerRecord || !oldPeerRecord.publicKey) throw new Error("No pubkey for old key");
        const oldPubKeyBytes = (oldPeerRecord.publicKey as any).bytes;
        const ok = await verifySignature(oldPubKeyBytes, hash.bytes, rec.sig);
        if (!ok) {
          res.status(401).json({ error: "Rotation signature invalid" });
          return;
        }
        // Persist new record
        await this.identityDb.put(rec.handle, rec);
        res.json({ success: true, handle: rec.handle, newPeerId: rec.currentPeerId });
        return;
      } catch (err: any) {
        res.status(500).json({ error: err.message });
        return;
      }
    });

    /** Fetch identity record by handle */
    router.get("/identity/:handle", (req: Request, res: Response) => {
      (async () => {
        try {
          const handle = req.params.handle;
          const rec = await this.identityDb.get(handle);
          return res.json(rec);
        } catch {
          return res.status(404).json({ error: "Identity not found" });
        }
      })();
    });

    // -------------
    // Post Routes
    // -------------

    /** Create a new micro-post */
    router.post("/post", (req: Request, res: Response) => {
      (async () => {
        try {
          const authorHandle = (req as Request & { handle?: string }).handle!;
          const authorPeerId = (req as Request & { peerId?: string }).peerId!;
          const text: string = req.body.text;
          if (!text || text.length > 280) {
            return res.status(400).json({ error: "Text must be 1–280 characters" });
          }
          const timestamp = new Date().toISOString();
          const postId = `${authorHandle}-${Date.now()}-${uuidv4()}`;
          const post: MicroPost = {
            postId,
            author: authorHandle,
            peerId: authorPeerId,
            text,
            createdAt: timestamp,
          };
          await this.postDb.put(postId, post);
          // Broadcast via PubSub
          const event: NewPostEvent = { type: "newPost", post };
          const pubsub =
            (this.context.libp2p as any).pubsub ?? (this.context.libp2p as any).services?.pubsub;
          await pubsub.publish("/v/posts/1.0.0", new TextEncoder().encode(JSON.stringify(event)));
          return res.json({ success: true, postId });
        } catch (err: any) {
          return res.status(500).json({ error: err.message });
        }
      })();
    });

    /** Fetch all posts (for catch-up) */
    router.get("/allPosts", (req: Request, res: Response) => {
      (async () => {
        try {
          const posts: MicroPost[] = [];
          for await (const [_, post] of this.postDb.iterator()) {
            posts.push(post);
          }
          // Sort by createdAt ascending
          posts.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
          res.json({ posts });
        } catch (err: any) {
          res.status(500).json({ error: err.message });
        }
      })();
    });

    // -----------------
    // Follow/Unfollow
    // -----------------

    /** Follow another handle */
    router.post("/follow/:targetHandle", (req: Request & { handle?: string }, res: Response) => {
      (async () => {
        try {
          const actor = req.handle!;
          const target = req.params.targetHandle;
          // Verify target exists in identityDb
          try {
            await this.identityDb.get(target);
          } catch {
            return res.status(404).json({ error: "Target handle not found" });
          }
          const current = await this.followDb.get(actor).catch(() => [] as string[]);
          if (!current.includes(target)) {
            current.push(target);
            await this.followDb.put(actor, current);
            const fe: FollowEvent = {
              type: "follow",
              from: actor,
              to: target,
              timestamp: new Date().toISOString(),
            };
            const pubsub =
              (this.context.libp2p as any).pubsub ?? (this.context.libp2p as any).services?.pubsub;
            await pubsub.publish("/v/follows/1.0.0", new TextEncoder().encode(JSON.stringify(fe)));
          }
          return res.json({ following: current });
        } catch (err: any) {
          return res.status(500).json({ error: err.message });
        }
      })();
    });

    /** Get list of who I follow */
    router.get("/following", (req: Request & { handle?: string }, res: Response) => {
      (async () => {
        try {
          const actor = req.handle!;
          const current = await this.followDb.get(actor).catch(() => []);
          return res.json({ following: current });
        } catch (err: any) {
          return res.status(500).json({ error: err.message });
        }
      })();
    });

    // -------------------
    // Timeline Endpoints
    // -------------------

    /** Get timeline: latest 100 posts from me + followed */
    router.get("/timeline", (req: Request & { handle?: string }, res: Response) => {
      (async () => {
        try {
          const me = req.handle!;
          const followSetArr = await this.followDb.get(me).catch(() => []);
          const followSet = new Set(followSetArr);
          followSet.add(me);
          const all: MicroPost[] = [];
          for await (const [_, post] of this.postDb.iterator()) {
            if (followSet.has(post.author)) {
              all.push(post);
            }
          }
          all.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
          return res.json({ timeline: all.slice(0, 100) });
        } catch (err: any) {
          return res.status(500).json({ error: err.message });
        }
      })();
    });

    /** SSE stream for real-time timeline */
    router.get("/timeline/stream", async (req: Request & { handle?: string }, res: Response) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(":\n\n");

      const me = req.handle!;
      let followSetArr = await this.followDb.get(me).catch(() => []);
      let followSet = new Set(followSetArr);
      followSet.add(me);

      // Function to send a post via SSE
      const sendPost = (post: MicroPost) => {
        res.write(`event: newPost\n`);
        res.write(`data: ${JSON.stringify(post)}\n\n`);
      };

      const ps =
        (this.context.libp2p as any).pubsub ?? (this.context.libp2p as any).services?.pubsub;
      const handler = async (_evtName: string, envelope: any) => {
        const { topic, data } = envelope.payload;
        try {
          if (topic === "/v/posts/1.0.0") {
            const msg = JSON.parse(new TextDecoder().decode(data)) as NewPostEvent;
            if (followSet.has(msg.post.author)) {
              sendPost(msg.post);
            }
          } else if (topic === "/v/follows/1.0.0") {
            const fe = JSON.parse(new TextDecoder().decode(data)) as FollowEvent;
            if (fe.from === me && fe.type === "follow") {
              followSet.add(fe.to);
            }
            if (fe.from === me && fe.type === "unfollow") {
              followSet.delete(fe.to);
            }
          }
        } catch {
          // ignore parse errors
        }
      };

      ps.addEventListener("message", handler);

      req.on("close", () => {
        ps.removeEventListener("message", handler);
      });
    });

    return router;
  }
}
