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

import type {
  MicroPost,
  CommentRecord,
  LikeRecord,
  PollRecord,
  VoteRecord,
  NewCommentEvent,
  NewLikeEvent,
  NewPollEvent,
  NewPostEvent,
  NewVoteEvent,
  IdentityRecord,
  FollowPubEvent,
  BanPubEvent,
  PollOption,
} from "./types.js";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *   Authentication Helpers
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Canonicalize a JSON object by lexicographically sorting keys.
 * Used to build a consistent string for signing / verifying.
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
 * Verify an Ed25519 signature given publicKey bytes, message hash, and base64 signature.
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

/**
 * Middleware that enforces two-layer authentication on every request:
 *   1. User‐level: x-peer-id + x-signature over JSON body + timestamp check.
 *   2. App‐level:  x-app-id + x-app-signature over JSON body + timestamp check.
 *
 * After validation, sets `req.peerId`, `req.handle` and `req.appId` on the request object.
 */
function createAuthMiddleware(context: PluginContext, identityDb: Level<string, IdentityRecord>) {
  return async function auth(
    req: Request & { peerId?: string; handle?: string; appId?: string },
    res: Response,
    next: any,
  ) {
    try {
      // ─── 1) App‐level headers ─────────────────────────────────────────────────
      const appId = req.header("x-app-id");
      const appSig = req.header("x-app-signature");
      if (!appId || !appSig) {
        return res.status(401).json({ error: "Missing x-app-id or x-app-signature" });
      }
      // App payload for signature: JSON‐stringify(req.body + timestamp), same canonicalization
      const appPayload = req.body;
      if (!appPayload.timestamp) {
        return res.status(400).json({ error: "Missing timestamp in request body" });
      }
      const ts = Date.parse(appPayload.timestamp);
      if (Number.isNaN(ts) || Math.abs(Date.now() - ts) > 2 * 60_000) {
        return res.status(401).json({ error: "App timestamp out of range" });
      }
      // Look up App's registered public key in a fictional "appIdentityDb"
      // (for demonstration, we assume identityDb also stores AppRecords keyed by "app:<appId>")
      let appRecord: IdentityRecord;
      try {
        appRecord = await identityDb.get(`app:${appId}`);
      } catch {
        return res.status(401).json({ error: "Unknown or unregistered appId" });
      }
      const appPubBytes = Buffer.from(appRecord.currentPeerId, "utf-8"); // in reality you'd store actual publicKey bytes
      // (here we assume currentPeerId field was overloaded to hold base64 publicKey—adjust as needed)
      const appCanon = canonicalize({
        appId: appRecord.handle,
        timestamp: appPayload.timestamp,
      });
      const appHash = await sha256.digest(new TextEncoder().encode(appCanon));
      const appOK = await verifySignature(appPubBytes, appHash.bytes, appSig);
      if (!appOK) {
        return res.status(401).json({ error: "App signature invalid" });
      }

      // ─── 2) User‐level headers ─────────────────────────────────────────────────
      const peerIdStr = req.header("x-peer-id");
      const sigBase64 = req.header("x-signature");
      if (!peerIdStr || !sigBase64) {
        return res.status(401).json({ error: "Missing x-peer-id or x-signature" });
      }
      // Validate same timestamp again
      // Re‐canonicalize request body
      const payloadStr = JSON.stringify(req.body);
      const payloadHash = await sha256.digest(new TextEncoder().encode(payloadStr));
      // Fetch peer’s public key from peerStore
      let peerPubBytes: Uint8Array;
      try {
        const peerRecord = await context.libp2p.peerStore.get(peerIdStr as any);
        if (!peerRecord || !peerRecord.publicKey) {
          throw new Error("No public key");
        }
        peerPubBytes = (peerRecord.publicKey as any).bytes;
      } catch {
        return res.status(401).json({ error: "Unknown peerId or no public key" });
      }
      const sigOK = await verifySignature(peerPubBytes, payloadHash.bytes, sigBase64);
      if (!sigOK) {
        return res.status(401).json({ error: "User signature invalid" });
      }

      // ─── 3) Map peerId → handle ─────────────────────────────────────────────────
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

      // ─── 4) All good: attach to request ───────────────────────────────────────
      req.peerId = peerIdStr;
      req.handle = matchedHandle;
      req.appId = appId!;
      return next();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
      return;
    }
  };
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *   VPlugin Implementation (now with Comments/Likes/Dislikes/Polls/Friends/Bans)
 * ─────────────────────────────────────────────────────────────────────────────
 */
export class VPlugin extends BasePlugin implements VinylPeerPlugin {
  protected context!: PluginContext;

  // Per‐app (appId) LevelDB instances:
  private postDb!: Level<string, MicroPost>; // v-posts-<appId>
  private commentDb!: Level<string, CommentRecord>; // v-comments-<appId>
  private likeDb!: Level<string, LikeRecord>; // v-likes-<appId>      keyed by "<postId>::<handle>"
  private pollDb!: Level<string, PollRecord>; // v-polls-<appId>
  private voteDb!: Level<string, VoteRecord>; // v-votes-<appId>      keyed by "<pollId>::<handle>"
  private followDb!: Level<string, string[]>; // v-follows-<appId>
  private banDb!: Level<string, string[]>; // v-bans-<appId>       keyed by "<actor>" → array of banned handles
  private identityDb!: Level<string, IdentityRecord>; // v-identities-<appId> keyed by "handle" → record

  getCapabilities(): PluginCapabilities {
    return {
      name: "vinyl-peer-plugin-v",
      version: "0.0.2",
      protocols: [],
      capabilities: ["microblog", "identity", "social", "polls", "bans"],
      permissions: {
        accessFiles: false,
        useNetwork: true,
        modifyPeers: false,
        exposeHttp: true,
      },
    };
  }

  /**
   * Initialize: open or create all per‐app LevelDBs.
   */
  async initialize(context: PluginContext): Promise<boolean> {
    const ok = await super.initialize(context);
    if (!ok) return false;
    this.context = context;

    const appId = (context as any).appId as string;
    if (!appId) throw new Error("VPlugin: missing appId in PluginContext");

    // Each DB is namespaced by appId suffix:
    this.postDb = new Level<string, MicroPost>(`v-posts-${appId}`, { valueEncoding: "json" });
    this.commentDb = new Level<string, CommentRecord>(`v-comments-${appId}`, {
      valueEncoding: "json",
    });
    this.likeDb = new Level<string, LikeRecord>(`v-likes-${appId}`, { valueEncoding: "json" });
    this.pollDb = new Level<string, PollRecord>(`v-polls-${appId}`, { valueEncoding: "json" });
    this.voteDb = new Level<string, VoteRecord>(`v-votes-${appId}`, { valueEncoding: "json" });
    this.followDb = new Level<string, string[]>(`v-follows-${appId}`, { valueEncoding: "json" });
    this.banDb = new Level<string, string[]>(`v-bans-${appId}`, { valueEncoding: "json" });
    this.identityDb = new Level<string, IdentityRecord>(`v-identities-${appId}`, {
      valueEncoding: "json",
    });

    return true;
  }

  async start(): Promise<void> {
    await super.start();

    // Subscribe to all relevant PubSub topics for this appId:
    const appId = (this.context as any).appId as string;
    const ps = (this.context.libp2p as any).pubsub ?? (this.context.libp2p as any).services?.pubsub;
    if (!ps) {
      throw new Error("VPlugin: PubSub service not available");
    }

    const topics = [
      `/v/posts/${appId}/1.0.0`,
      `/v/comments/${appId}/1.0.0`,
      `/v/likes/${appId}/1.0.0`,
      `/v/polls/${appId}/1.0.0`,
      `/v/votes/${appId}/1.0.0`,
      `/v/follows/${appId}/1.0.0`,
      `/v/bans/${appId}/1.0.0`,
    ];
    for (const t of topics) {
      await ps.subscribe(t);
    }

    // Any incoming PubSub messages get written into the local DB (unless we already have them)
    ps.addEventListener("message", async (evt: any) => {
      const { topic, data } = evt.detail;
      const msg = new TextDecoder().decode(data);
      try {
        if (topic === `/v/posts/${appId}/1.0.0`) {
          const event = JSON.parse(msg) as NewPostEvent;
          const exists = await this.postDb.get(event.post.postId).catch(() => null);
          if (!exists) {
            await this.postDb.put(event.post.postId, event.post);
          }
        } else if (topic === `/v/comments/${appId}/1.0.0`) {
          const event = JSON.parse(msg) as NewCommentEvent;
          const exists = await this.commentDb.get(event.comment.commentId).catch(() => null);
          if (!exists) {
            await this.commentDb.put(event.comment.commentId, event.comment);
          }
        } else if (topic === `/v/likes/${appId}/1.0.0`) {
          const event = JSON.parse(msg) as NewLikeEvent;
          const key = `${event.like.postId}::${event.like.handle}`;
          await this.likeDb.put(key, event.like);
        } else if (topic === `/v/polls/${appId}/1.0.0`) {
          const event = JSON.parse(msg) as NewPollEvent;
          await this.pollDb.put(event.poll.pollId, event.poll);
        } else if (topic === `/v/votes/${appId}/1.0.0`) {
          const event = JSON.parse(msg) as NewVoteEvent;
          const key = `${event.vote.pollId}::${event.vote.handle}`;
          await this.voteDb.put(key, event.vote);
        } else if (topic === `/v/follows/${appId}/1.0.0`) {
          const event = JSON.parse(msg) as FollowPubEvent;
          const current = await this.followDb.get(event.from).catch(() => [] as string[]);
          if (event.type === "follow" && !current.includes(event.to)) {
            current.push(event.to);
            await this.followDb.put(event.from, current);
          } else if (event.type === "unfollow" && current.includes(event.to)) {
            const updated = current.filter((x) => x !== event.to);
            await this.followDb.put(event.from, updated);
          }
        } else if (topic === `/v/bans/${appId}/1.0.0`) {
          const event = JSON.parse(msg) as BanPubEvent;
          const current = await this.banDb.get(event.actor).catch(() => [] as string[]);
          if (!current.includes(event.target)) {
            current.push(event.target);
            await this.banDb.put(event.actor, current);
          }
        }
      } catch {
        // ignore malformed messages
      }
    });
  }

  async stop(): Promise<void> {
    await this.postDb.close();
    await this.commentDb.close();
    await this.likeDb.close();
    await this.pollDb.close();
    await this.voteDb.close();
    await this.followDb.close();
    await this.banDb.close();
    await this.identityDb.close();
    await super.stop();
  }

  setupProtocols(): void {
    // No custom libp2p protocols; we rely on PubSub instead.
  }

  async handleProtocol(_protocol: string, _stream: any, _peerId: string): Promise<void> {
    // None
  }

  /**
   * HTTP namespace will be `/api/v`
   * (the appId is included via headers, so we mount once and read x-app-id each time)
   */
  getHttpNamespace(): string {
    return "/api/v";
  }

  getHttpRouter(): Router {
    const router = express.Router();
    router.use(express.json());

    // Create an auth middleware bound to this plugin’s identityDb:
    const auth = createAuthMiddleware(this.context, this.identityDb);
    router.use(auth);

    // ────────────────────────────────────────────────────────────────────────────
    //   Identity (register / rotate / lookup)
    // ────────────────────────────────────────────────────────────────────────────

    /** POST /api/v/identity/register
     *  {
     *    handle, currentPeerId, previousPeerIds, createdAt, sig
     *  }
     */
    router.post("/identity/register", async (req: Request, res: Response) => {
      try {
        const rec = req.body as IdentityRecord;
        // Ensure handle is free:
        try {
          await this.identityDb.get(rec.handle);
          res.status(409).json({ error: "Handle already exists" });
          return;
        } catch {
          // OK, does not exist yet.
        }
        // Verify rec.sig over canonicalized {handle, currentPeerId, previousPeerIds, createdAt}
        const pay = {
          handle: rec.handle,
          currentPeerId: rec.currentPeerId,
          previousPeerIds: rec.previousPeerIds,
          createdAt: rec.createdAt,
        };
        const canon = canonicalize(pay);
        const hash = await sha256.digest(new TextEncoder().encode(canon));
        // Lookup public key of rec.currentPeerId in peerStore:
        const peerRec = await this.context.libp2p.peerStore.get(rec.currentPeerId as any);
        if (!peerRec || !peerRec.publicKey) {
          throw new Error("No public key for given peerId");
        }
        const pubBytes = (peerRec.publicKey as any).bytes;
        const ok = await verifySignature(pubBytes, hash.bytes, rec.sig);
        if (!ok) {
          res.status(401).json({ error: "Signature invalid" });
          return;
        }
        // Store
        await this.identityDb.put(rec.handle, rec);
        res.json({ success: true, handle: rec.handle });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
        return;
      }
    });

    /** POST /api/v/identity/rotate
     *  {
     *    handle, currentPeerId, previousPeerIds, createdAt, sig
     *  }
     */
    router.post("/identity/rotate", async (req: Request, res: Response) => {
      try {
        const rec = req.body as IdentityRecord;
        // Fetch existing:
        let existing: IdentityRecord;
        try {
          existing = await this.identityDb.get(rec.handle);
        } catch {
          res.status(404).json({ error: "No such identity to rotate" });
          return;
        }
        // Only existing.currentPeerId may rotate:
        if ((req as Request & { peerId?: string }).peerId !== existing.currentPeerId) {
          res.status(403).json({ error: "Not authorized to rotate" });
          return;
        }
        // Verify rec.sig signed by old key:
        const payload = {
          handle: rec.handle,
          currentPeerId: rec.currentPeerId,
          previousPeerIds: rec.previousPeerIds,
          createdAt: rec.createdAt,
        };
        const canon = canonicalize(payload);
        const hash = await sha256.digest(new TextEncoder().encode(canon));
        const oldPeerRec = await this.context.libp2p.peerStore.get(existing.currentPeerId as any);
        if (!oldPeerRec || !oldPeerRec.publicKey) {
          throw new Error("No public key for old PeerId");
        }
        const oldPubBytes = (oldPeerRec.publicKey as any).bytes;
        const ok = await verifySignature(oldPubBytes, hash.bytes, rec.sig);
        if (!ok) {
          res.status(401).json({ error: "Rotation signature invalid" });
          return;
        }
        // Persist:
        await this.identityDb.put(rec.handle, rec);
        res.json({ success: true, handle: rec.handle, newPeerId: rec.currentPeerId });
        return;
      } catch (err: any) {
        res.status(500).json({ error: err.message });
        return;
      }
    });

    /** GET /api/v/identity/:handle */
    router.get("/identity/:handle", async (req: Request, res: Response) => {
      try {
        const rec = await this.identityDb.get(req.params.handle);
        res.json(rec);
        return;
      } catch {
        res.status(404).json({ error: "Identity not found" });
        return;
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    //   Post Routes (Create / Read)
    // ────────────────────────────────────────────────────────────────────────────

    /** POST /api/v/post
     *  {
     *    text, timestamp
     *  }
     */
    router.post("/post", async (req: Request, res: Response) => {
      try {
        const handle = (req as Request & { handle?: string }).handle!;
        const peerId = (req as Request & { peerId?: string }).peerId!;
        const appId = (req as Request & { appId?: string }).appId!;
        const text: string = req.body.text;
        const timestamp: string = req.body.timestamp;

        // Check length (if not a poll reference):
        if (!req.body.isPoll && (!text || text.length > 280)) {
          res.status(400).json({ error: "Text must be 1–280 characters" });
          return;
        }

        // Construct MicroPost:
        const postId = `${handle}-${Date.now()}-${uuidv4()}`;
        const post: MicroPost = {
          postId,
          author: handle,
          peerId,
          text,
          createdAt: timestamp,
          isPoll: req.body.isPoll ?? false,
        };

        // Save locally then broadcast via PubSub:
        await this.postDb.put(postId, post);
        const event: NewPostEvent = { type: "newPost", post };
        const ps =
          (this.context.libp2p as any).pubsub ?? (this.context.libp2p as any).services?.pubsub;
        await ps.publish(
          `/v/posts/${appId}/1.0.0`,
          new TextEncoder().encode(JSON.stringify(event)),
        );

        res.json({ success: true, postId });
        return;
      } catch (err: any) {
        res.status(500).json({ error: err.message });
        return;
      }
    });

    /** GET /api/v/posts/:postId → fetch a single post */
    router.get("/posts/:postId", async (req: Request, res: Response) => {
      try {
        const post = await this.postDb.get(req.params.postId);
        res.json(post);
        return;
      } catch {
        res.status(404).json({ error: "Post not found" });
        return;
      }
    });

    /** GET /api/v/allPosts → fetch all posts sorted desc by createdAt */
    router.get("/allPosts", async (_req: Request, res: Response) => {
      try {
        const arr: MicroPost[] = [];
        for await (const [, p] of this.postDb.iterator()) {
          arr.push(p);
        }
        arr.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
        res.json({ posts: arr });
        return;
      } catch (err: any) {
        res.status(500).json({ error: err.message });
        return;
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    //   Comment Routes
    // ────────────────────────────────────────────────────────────────────────────

    /** POST /api/v/comment
     *  {
     *    postId, text, timestamp
     *  }
     */
    router.post("/comment", async (req: Request, res: Response) => {
      try {
        const handle = (req as Request & { handle?: string }).handle!;
        const peerId = (req as Request & { peerId?: string }).peerId!;
        const appId = (req as Request & { appId?: string }).appId!;
        const postId: string = req.body.postId;
        const text: string = req.body.text;
        const timestamp: string = req.body.timestamp;

        if (!text || text.length > 280) {
          res.status(400).json({ error: "Comment must be 1–280 characters" });
          return;
        }
        // Ensure post exists:
        const exists = await this.postDb.get(postId).catch(() => null);
        if (!exists) {
          res.status(404).json({ error: "Post not found" });
          return;
        }
        // Check if commenter is banned by post author or by app:
        const author = exists.author;
        const authorBans: string[] = await this.banDb.get(author).catch(() => [] as string[]);
        if (authorBans.includes(handle)) {
          res.status(403).json({ error: "You are banned from commenting on this user’s posts." });
          return;
        }
        // Create comment:
        const commentId = `${postId}-comment-${uuidv4()}`;
        const comment: CommentRecord = {
          commentId,
          postId,
          author: handle,
          peerId,
          text,
          createdAt: timestamp,
        };
        await this.commentDb.put(commentId, comment);
        // Broadcast via PubSub:
        const event: NewCommentEvent = { type: "newComment", comment };
        const ps =
          (this.context.libp2p as any).pubsub ?? (this.context.libp2p as any).services?.pubsub;
        await ps.publish(
          `/v/comments/${appId}/1.0.0`,
          new TextEncoder().encode(JSON.stringify(event)),
        );
        res.json({ success: true, commentId });
        return;
      } catch (err: any) {
        res.status(500).json({ error: err.message });
        return;
      }
    });

    /** GET /api/v/comments/:postId → fetch all comments for a post, sorted asc */
    router.get("/comments/:postId", async (req: Request, res: Response) => {
      try {
        const postId = req.params.postId;
        const arr: CommentRecord[] = [];
        for await (const [, c] of this.commentDb.iterator()) {
          if (c.postId === postId) arr.push(c);
        }
        arr.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
        res.json({ comments: arr });
        return;
      } catch (err: any) {
        res.status(500).json({ error: err.message });
        return;
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    //   Like / Dislike Routes
    // ────────────────────────────────────────────────────────────────────────────

    /** POST /api/v/like
     *  {
     *    postId, isLike (true/false), timestamp
     *  }
     */
    router.post("/like", async (req: Request, res: Response) => {
      try {
        const handle = (req as Request & { handle?: string }).handle!;
        const peerId = (req as Request & { peerId?: string }).peerId!;
        const appId = (req as Request & { appId?: string }).appId!;
        const postId: string = req.body.postId;
        const isLike: boolean = req.body.isLike;
        const timestamp: string = req.body.timestamp;

        // Ensure post exists:
        const exists = await this.postDb.get(postId).catch(() => null);
        if (!exists) {
          res.status(404).json({ error: "Post not found" });
          return;
        }
        // Check if user is banned by post author
        const author = exists.author;
        const authorBans: string[] = await this.banDb.get(author).catch(() => [] as string[]);
        if (authorBans.includes(handle)) {
          res
            .status(403)
            .json({ error: "You are banned from interacting with this user’s posts." });
          return;
        }
        // Upsert LikeRecord:
        const key = `${postId}::${handle}`;
        const record: LikeRecord = {
          postId,
          handle,
          peerId,
          isLike,
          createdAt: timestamp,
        };
        await this.likeDb.put(key, record);

        // Broadcast via PubSub:
        const event: NewLikeEvent = { type: "newLike", like: record };
        const ps =
          (this.context.libp2p as any).pubsub ?? (this.context.libp2p as any).services?.pubsub;
        await ps.publish(
          `/v/likes/${appId}/1.0.0`,
          new TextEncoder().encode(JSON.stringify(event)),
        );

        res.json({ success: true });
        return;
      } catch (err: any) {
        res.status(500).json({ error: err.message });
        return;
      }
    });

    /** GET /api/v/likes/:postId → fetch like/dislike counts for a post */
    router.get("/likes/:postId", async (req: Request, res: Response) => {
      try {
        const postId = req.params.postId;
        let likes = 0;
        let dislikes = 0;
        for await (const [, rec] of this.likeDb.iterator()) {
          if (rec.postId === postId) {
            if (rec.isLike) likes++;
            else dislikes++;
          }
        }
        res.json({ postId, likes, dislikes });
        return;
      } catch (err: any) {
        res.status(500).json({ error: err.message });
        return;
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    //   Poll Routes
    // ────────────────────────────────────────────────────────────────────────────

    /** POST /api/v/poll
     *  {
     *    postId, question, options: [string], timestamp, expiresAt?
     *  }
     */
    router.post("/poll", async (req: Request, res: Response) => {
      try {
        const handle = (req as Request & { handle?: string }).handle!;
        const peerId = (req as Request & { peerId?: string }).peerId!;
        const appId = (req as Request & { appId?: string }).appId!;
        const postId: string = req.body.postId;
        const question: string = req.body.question;
        const opts: string[] = req.body.options;
        const timestamp: string = req.body.timestamp;
        const expiresAt: string | undefined = req.body.expiresAt;

        // postId must exist
        const postExists = await this.postDb.get(postId).catch(() => null);
        if (!postExists) {
          res.status(404).json({ error: "Associated post not found" });
          return;
        }
        // Compose PollRecord:
        const pollId = `${postId}-poll`;
        const pollOpts: PollOption[] = opts.map((text) => ({
          optionId: uuidv4(),
          text,
          voteCount: 0,
        }));
        const poll: PollRecord = {
          pollId,
          postId,
          question,
          options: pollOpts,
          createdAt: timestamp,
          expiresAt,
        };
        await this.pollDb.put(pollId, poll);
        // Broadcast:
        const event: NewPollEvent = { type: "newPoll", poll };
        const ps =
          (this.context.libp2p as any).pubsub ?? (this.context.libp2p as any).services?.pubsub;
        await ps.publish(
          `/v/polls/${appId}/1.0.0`,
          new TextEncoder().encode(JSON.stringify(event)),
        );
        res.json({ success: true, pollId });
        return;
      } catch (err: any) {
        res.status(500).json({ error: err.message });
        return;
      }
    });

    /** GET /api/v/poll/:pollId → fetch a poll’s details & vote counts */
    router.get("/poll/:pollId", async (req: Request, res: Response) => {
      try {
        const pollId = req.params.pollId;
        const poll = await this.pollDb.get(pollId).catch(() => null);
        if (!poll) {
          res.status(404).json({ error: "Poll not found" });
          return;
        }
        // Count votes from voteDb:
        const updatedOptions: PollOption[] = poll.options.map((opt) => ({ ...opt, voteCount: 0 }));
        for await (const [, v] of this.voteDb.iterator()) {
          if (v.pollId === pollId) {
            const idx = updatedOptions.findIndex((o) => o.optionId === v.optionId);
            if (idx !== -1) {
              updatedOptions[idx].voteCount++;
            }
          }
        }
        res.json({ poll: { ...poll, options: updatedOptions } });
        return;
      } catch (err: any) {
        res.status(500).json({ error: err.message });
        return;
      }
    });

    /** POST /api/v/vote
     *  {
     *    pollId, optionId, timestamp
     *  }
     */
    router.post("/vote", async (req: Request, res: Response) => {
      try {
        const handle = (req as Request & { handle?: string }).handle!;
        const peerId = (req as Request & { peerId?: string }).peerId!;
        const appId = (req as Request & { appId?: string }).appId!;
        const pollId: string = req.body.pollId;
        const optionId: string = req.body.optionId;
        const timestamp: string = req.body.timestamp;

        // Ensure poll exists and not expired:
        const poll = await this.pollDb.get(pollId).catch(() => null);
        if (!poll) {
          res.status(404).json({ error: "Poll not found" });
          return;
        }
        if (poll.expiresAt && Date.now() > Date.parse(poll.expiresAt)) {
          res.status(400).json({ error: "Poll has expired" });
          return;
        }
        // Upsert VoteRecord:
        const key = `${pollId}::${handle}`;
        const vote: VoteRecord = { pollId, optionId, handle, peerId, createdAt: timestamp };
        await this.voteDb.put(key, vote);
        // Broadcast:
        const event: NewVoteEvent = { type: "newVote", vote };
        const ps =
          (this.context.libp2p as any).pubsub ?? (this.context.libp2p as any).services?.pubsub;
        await ps.publish(
          `/v/votes/${appId}/1.0.0`,
          new TextEncoder().encode(JSON.stringify(event)),
        );
        res.json({ success: true });
        return;
      } catch (err: any) {
        res.status(500).json({ error: err.message });
        return;
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    //   Follow / Unfollow (Friends) Routes
    // ────────────────────────────────────────────────────────────────────────────

    /** POST /api/v/follow/:target */
    router.post("/follow/:targetHandle", async (req: Request, res: Response) => {
      try {
        const actor = (req as Request & { handle?: string }).handle!;
        const target = req.params.targetHandle;
        // Ensure target handle exists:
        try {
          await this.identityDb.get(target);
        } catch {
          res.status(404).json({ error: "Target handle not found" });
          return;
        }
        const current = await this.followDb.get(actor).catch(() => [] as string[]);
        if (!current.includes(target)) {
          current.push(target);
          await this.followDb.put(actor, current);
          // Broadcast:
          const fe: FollowPubEvent = {
            type: "follow",
            from: actor,
            to: target,
            timestamp: new Date().toISOString(),
          };
          const appId = (req as Request & { appId?: string }).appId!;
          const ps =
            (this.context.libp2p as any).pubsub ?? (this.context.libp2p as any).services?.pubsub;
          await ps.publish(
            `/v/follows/${appId}/1.0.0`,
            new TextEncoder().encode(JSON.stringify(fe)),
          );
        }
        res.json({ following: current });
        return;
      } catch (err: any) {
        res.status(500).json({ error: err.message });
        return;
      }
    });

    /** GET /api/v/following */
    router.get("/following", async (req: Request, res: Response) => {
      try {
        const actor = (req as Request & { handle?: string }).handle!;
        const current = await this.followDb.get(actor).catch(() => []);
        res.json({ following: current });
        return;
      } catch (err: any) {
        res.status(500).json({ error: err.message });
        return;
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    //   Ban Routes
    // ────────────────────────────────────────────────────────────────────────────

    /** POST /api/v/ban/:targetHandle */
    router.post("/ban/:targetHandle", async (req: Request, res: Response) => {
      try {
        const actor = (req as Request & { handle?: string }).handle!;
        const target = req.params.targetHandle;
        // Cannot ban oneself:
        if (actor === target) {
          res.status(400).json({ error: "Cannot ban yourself" });
          return;
        }
        // Record ban:
        const current = await this.banDb.get(actor).catch(() => [] as string[]);
        if (!current.includes(target)) {
          current.push(target);
          await this.banDb.put(actor, current);
          // Broadcast:
          const event: BanPubEvent = {
            type: "ban",
            actor,
            target,
            timestamp: new Date().toISOString(),
          };
          const appId = (req as Request & { appId?: string }).appId!;
          const ps =
            (this.context.libp2p as any).pubsub ?? (this.context.libp2p as any).services?.pubsub;
          await ps.publish(
            `/v/bans/${appId}/1.0.0`,
            new TextEncoder().encode(JSON.stringify(event)),
          );
        }
        res.json({ banned: current });
        return;
      } catch (err: any) {
        res.status(500).json({ error: err.message });
        return;
      }
    });

    /** GET /api/v/bans → list who *I* have banned */
    router.get("/bans", async (req: Request, res: Response) => {
      try {
        const actor = (req as Request & { handle?: string }).handle!;
        const current = await this.banDb.get(actor).catch(() => []);
        res.json({ banned: current });
        return;
      } catch (err: any) {
        res.status(500).json({ error: err.message });
        return;
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    //   Stream / SSE Endpoints
    // ────────────────────────────────────────────────────────────────────────────

    /** GET /api/v/stream/posts → SSE for new posts from those I follow */
    router.get("/stream/posts", async (req: Request, res: Response) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(":\n\n");

      const me = (req as Request & { handle?: string }).handle!;
      let followArr = await this.followDb.get(me).catch(() => []);
      let followSet = new Set(followArr);
      followSet.add(me);

      // Helper to send a post via SSE
      const sendPost = (p: MicroPost) => {
        res.write(`event: newPost\n`);
        res.write(`data: ${JSON.stringify(p)}\n\n`);
      };

      const appId = (req as Request & { appId?: string }).appId!;
      const ps =
        (this.context.libp2p as any).pubsub ?? (this.context.libp2p as any).services?.pubsub;

      const handler = async (_evtName: string, envelope: any) => {
        const topic: string = envelope.payload.topic;
        const data: Uint8Array = envelope.payload.data;
        try {
          if (topic === `/v/posts/${appId}/1.0.0`) {
            const ev = JSON.parse(new TextDecoder().decode(data)) as NewPostEvent;
            if (followSet.has(ev.post.author)) {
              sendPost(ev.post);
            }
          } else if (topic === `/v/follows/${appId}/1.0.0`) {
            const fe = JSON.parse(new TextDecoder().decode(data)) as FollowPubEvent;
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

    /** GET /api/v/stream/comments → SSE for new comments on posts I follow */
    router.get("/stream/comments", async (req: Request, res: Response) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(":\n\n");

      const me = (req as Request & { handle?: string }).handle!;
      let followArr = await this.followDb.get(me).catch(() => []);
      let followSet = new Set(followArr);
      followSet.add(me);

      const sendComment = (c: CommentRecord) => {
        res.write(`event: newComment\n`);
        res.write(`data: ${JSON.stringify(c)}\n\n`);
      };

      const appId = (req as Request & { appId?: string }).appId!;
      const ps =
        (this.context.libp2p as any).pubsub ?? (this.context.libp2p as any).services?.pubsub;

      const handler = async (_evtName: string, envelope: any) => {
        const topic: string = envelope.payload.topic;
        const data: Uint8Array = envelope.payload.data;
        try {
          if (topic === `/v/comments/${appId}/1.0.0`) {
            const ev = JSON.parse(new TextDecoder().decode(data)) as NewCommentEvent;
            // Only send comments on posts whose author we follow:
            const parentPost = await this.postDb.get(ev.comment.postId).catch(() => null);
            if (parentPost && followSet.has(parentPost.author)) {
              sendComment(ev.comment);
            }
          } else if (topic === `/v/follows/${appId}/1.0.0`) {
            const fe = JSON.parse(new TextDecoder().decode(data)) as FollowPubEvent;
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

    // ────────────────────────────────────────────────────────────────────────────
    //   Poll Stream → SSE for new poll creations & votes
    // ────────────────────────────────────────────────────────────────────────────

    /** GET /api/v/stream/polls → SSE for new polls I can see (my follows) */
    router.get("/stream/polls", async (req: Request, res: Response) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(":\n\n");

      const me = (req as Request & { handle?: string }).handle!;
      let followArr = await this.followDb.get(me).catch(() => []);
      let followSet = new Set(followArr);
      followSet.add(me);

      const sendPoll = (p: PollRecord) => {
        res.write(`event: newPoll\n`);
        res.write(`data: ${JSON.stringify(p)}\n\n`);
      };

      const appId = (req as Request & { appId?: string }).appId!;
      const ps =
        (this.context.libp2p as any).pubsub ?? (this.context.libp2p as any).services?.pubsub;

      const handler = async (_evtName: string, envelope: any) => {
        const topic: string = envelope.payload.topic;
        const data: Uint8Array = envelope.payload.data;
        try {
          if (topic === `/v/polls/${appId}/1.0.0`) {
            const ev = JSON.parse(new TextDecoder().decode(data)) as NewPollEvent;
            // Only show polls whose parent post author we follow:
            const parentPost = await this.postDb.get(ev.poll.postId).catch(() => null);
            if (parentPost && followSet.has(parentPost.author)) {
              sendPoll(ev.poll);
            }
          } else if (topic === `/v/follows/${appId}/1.0.0`) {
            const fe = JSON.parse(new TextDecoder().decode(data)) as FollowPubEvent;
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

    // ────────────────────────────────────────────────────────────────────────────
    //   Ban / Unban Stream → SSE for ban events affecting me
    // ────────────────────────────────────────────────────────────────────────────

    /** GET /api/v/stream/bans → SSE for new bans where I am the target */
    router.get("/stream/bans", async (req: Request, res: Response) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(":\n\n");

      const me = (req as Request & { handle?: string }).handle!;

      const sendBan = (b: BanPubEvent) => {
        if (b.target === me) {
          res.write(`event: ban\n`);
          res.write(`data: ${JSON.stringify(b)}\n\n`);
        }
      };

      const appId = (req as Request & { appId?: string }).appId!;
      const ps =
        (this.context.libp2p as any).pubsub ?? (this.context.libp2p as any).services?.pubsub;

      const handler = async (_evtName: string, envelope: any) => {
        const topic: string = envelope.payload.topic;
        const data: Uint8Array = envelope.payload.data;
        try {
          if (topic === `/v/bans/${appId}/1.0.0`) {
            const ev = JSON.parse(new TextDecoder().decode(data)) as BanPubEvent;
            sendBan(ev);
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
