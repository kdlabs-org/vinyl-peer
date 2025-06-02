# Vinyl Peer Monorepo

Vinyl Peer is a modular, peer-to-peer (P2P) media-sharing network built with TypeScript. It leverages **libp2p** for decentralized networking and optionally integrates **Helia/IPFS** for local storage. The monorepo consists of the following packages:

- **vinyl-peer-protocol** (core P2P framework & plugin host)
- **vinyl-peer-music-plugin** (music-specific functionality)
- **vinyl-peer-analytics** (node & file analytics)
- **vinyl-peer-replication-plugin** (auto-pin/replication)
- **vinyl-peer-cli** (CLI + Express web server)

---

## Table of Contents

1. [Overview](#overview)
2. [Use Cases](#use-cases)
3. [Design & Architecture](#design--architecture)
4. [Installation](#installation)
5. [Execution Commands](#execution-commands)
6. [Code Examples](#code-examples)
7. [Packages](#packages)
8. [Contributing](#contributing)
9. [License](#license)

---

## Overview

Vinyl Peer enables decentralized sharing, discovery, replication, and analytics for media files (audio, video, documents, etc.) through a **plugin-based architecture**. The core (`vinyl-peer-protocol`) manages:

- A **libp2p** node (peer discovery, multiplexed streams, NAT traversal)
- Optional **Helia/IPFS** local storage (for content addressing, pinning)
- An HTTP server via **vinyl-peer-cli**
- A **plugin framework** that lets you add features—such as music discovery, analytics, and auto-pinning—without modifying core code.

Plugins can:

- Declare and handle custom **libp2p protocols**
- Hook into file upload/download events
- Enhance metadata (e.g. extract ID3 tags from audio)
- Expose their own HTTP endpoints (mounted under a unique namespace by the CLI)
- Pin or unpin IPFS CIDs (via the new `pinFile` / `unpinFile` API)

---

## Use Cases

Vinyl Peer supports a wide range of scenarios:

1. **Decentralized Media Sharing**

   - **What?** Upload/download/stream files across a P2P network.
   - **Example:** Friends share and stream high-fidelity audio tracks without a central server.

2. **Music Discovery & Recommendations**

   - **What?** Search by artist, album, genre; receive related-genre recommendations.
   - **Example:** A user searches “jazz” and finds new artists or tracks via the Music Plugin.

3. **Auto-Replication (Auto-Pinning)**

   - **What?** Automatically pin every file you download—ensuring it stays cached locally and helps replicate to other peers.
   - **Example:** A node operator installs the Replication Plugin; every time they download a CID, it’s auto-pinned in IPFS.

4. **Network Analytics**

   - **What?** Track peer counts, file popularity, bandwidth usage, pin counts, etc.
   - **Example:** A researcher monitors which genres are trending across nodes via the Analytics Plugin.

5. **Lightweight Relay Nodes**

   - **What?** Run without local storage; contribute only to peer routing and pubsub.
   - **Example:** A user with limited disk space runs in “relay-only” mode to boost network connectivity.

---

## Design & Architecture

### 1. Modularity via Plugins

- **Why?** Keep core light and allow independent development.
- **How?**

  - `vinyl-peer-protocol` provides a **PluginContext** (with libp2p, file maps, pin/unpin API, event bus).
  - Each plugin implements `VinylPeerPlugin` and declares:

    - A unique **name/version**
    - One or more **libp2p protocols** (e.g. `/music-discovery/1.0.0`)
    - **Capabilities**, **fileTypes**, and **permissions** (e.g. `["audio/*"]` + `{ accessFiles: true, useNetwork: true, ... }`)
    - (Optionally) HTTP routes under a namespace (e.g. `/api/music`)

  - Plugins register themselves with the core; core routes incoming libp2p streams to the correct plugin.
  - The actual HTTP server lives in `vinyl-peer-cli`, which mounts each plugin’s router under the namespace returned by `getHttpNamespace()`.

---

### 2. Core (`vinyl-peer-protocol`)

- **Libp2p Node**

  - Transports: TCP, WebSockets, WebRTC, circuit-relay
  - Security: Noise encryption, Yamux multiplexing
  - Peer Discovery: Bootstrap nodes + optional mDNS (Node only)
  - Services: identify, kadDHT, ping

- **Helia/IPFS (Optional)**

  - If local storage is enabled, a Helia (IPFS) node is spawned.
  - You can add bytes, cat bytes, pin, and unpin via Helia.

- **File Management**

  1. **uploadFile(...)**

     - Reads raw bytes, encrypts with AES-256, and either:

       - Stores in IPFS (if `storageMode = "ipfs"` and local storage enabled)
       - Or stores in an in-memory stream (for P2P streaming)

     - Calls each plugin’s `enhanceMetadata(uploadedFile)` to allow plugins to parse tags or add custom metadata.
     - Stores a metadata CID (or `metadata-<uuid>` for streaming) → `FileInfo` in `this.files`.
     - Emits a `fileUploaded` event (envelope shape: `{ source, payload }`) and calls each plugin’s `onFileUploaded(...)`.

  2. **downloadFile(cid)**

     - If `cid` is a metadata CID, resolves the corresponding audio CID.
     - Retrieves encrypted bytes either from IPFS or in-memory.
     - Decrypts and returns the raw file bytes.
     - Emits a `fileDownloaded` event and calls each plugin’s `onFileDownloaded(...)`.

  3. **pinFile(cid)** / **unpinFile(cid)**

     - Pin or unpin a given IPFS CID in Helia.
     - Updates `FileInfo.pinned` and emits `filePinned` / `fileUnpinned`.

- **Event Bus & PluginManager**

  - Plugins subscribe to core events via optional hooks:

    - `onPeerConnected(peerId, peerInfo)`
    - `onPeerDisconnected(peerId, peerInfo)`
    - `onFileUploaded(cid, fileInfo)`
    - `onFileDownloaded(cid)`

  - Core also provides:
    - `searchFiles(query: string)` → runs built-in local search + each plugin’s `searchFiles(...)`
    - `getRecommendations(basedOnCid)` → aggregates results from each plugin’s `getRecommendations(...)`

- **HTTP Server (via `vinyl-peer-cli`)**

  - Plugins still implement `getHttpNamespace()` and `getHttpRouter()`, but do **not** mount under a libp2p-owned server.
  - Instead, `vinyl-peer-cli` creates its own Express app (in `WebServer.ts`), then automatically mounts each plugin’s router under the path returned by `getHttpNamespace()`.
  - Example: if MusicPlugin returns `/api/music`, the CLI’s server will mount its router there.

---

### 3. PluginContext

Every plugin’s `initialize(context: PluginContext)` receives:

```ts
export interface PluginContext {
  /** Unique PeerID of this node */
  nodeId: string;

  /** The underlying libp2p instance */
  libp2p: any;

  /** Map of metadata CID → FileInfo for all locally uploaded files */
  files: Map<string, FileInfo>;

  /** Map of peerId → PeerInfo for all known peers */
  peers: Map<string, PeerInfo>;

  /** Map of remote file advertisements (NetworkFileInfo) */
  networkFiles: Map<string, NetworkFileInfo>;

  /**
   * Internal event emitter.
   * Must be called with an envelope: `{ source: <pluginName>, payload: <any> }`.
   * Core validates the envelope before broadcasting to listeners.
   */
  emit: (event: string, envelope: { source: string; payload: any }) => void;

  /** Pin a CID (replicate/download it locally into IPFS) */
  pinFile: (cid: string) => Promise<void>;

  /** Unpin a CID */
  unpinFile: (cid: string) => Promise<void>;

  /** Retrieve this plugin’s granted permissions */
  getPermissions: () => PluginPermissions;
}
```

Plugins typically store `this.context = context;` in their `initialize(...)`. Then they can:

- `this.context.libp2p.handle(protocol, handler)` to bind a custom protocol
- Read or modify `this.context.files.get(cid)` to inspect local files
- Mark peers (e.g. `peer.isMusicNode = true`) if `modifyPeers` permission was granted
- Auto-pin/unpin via `this.context.pinFile(cid)` / `this.context.unpinFile(cid)`
- Emit custom events like `this.context.emit("someEvent", { source: pluginName, payload })`

---

## Key Interfaces & Base Classes

Below are the detailed TypeScript definitions for the plugin system, including the new permission fields and updated `emit` signature.

### 1. `PluginPermissions`

```ts
export interface PluginPermissions {
  accessFiles: boolean; // Can read/write context.files
  useNetwork: boolean; // Can dial or handle libp2p protocols
  modifyPeers: boolean; // Can tag peers or change PeerInfo fields
  exposeHttp: boolean; // Can register HTTP routes via getHttpRouter()
}
```

### 2. `PluginCapabilities`

```ts
export interface PluginCapabilities {
  /** Unique plugin name (e.g. "vinyl-peer-music-plugin") */
  name: string;

  /** Semantic version, e.g. "1.0.0" */
  version: string;

  /** Custom libp2p protocols this plugin handles */
  protocols: string[]; // e.g. ["/music-discovery/1.0.0", "/music-metadata/1.0.0"]

  /** Functional tags (e.g. ["discovery", "metadata"]) */
  capabilities: string[];

  /** Optional: MIME-type prefixes this plugin will receive (e.g. ["audio/*"]) */
  fileTypes?: string[];

  /** Permissions that this plugin requests from the host node */
  permissions: PluginPermissions;
}
```

### 3. `VinylPeerPlugin`

```ts
export interface VinylPeerPlugin {
  // ─── Required (must implement) ─────────────────────────────────

  /** Return capabilities (name, version, protocols, capabilities, fileTypes, permissions) */
  getCapabilities(): PluginCapabilities;

  /** Called once at startup; store context & verify permissions */
  initialize(context: PluginContext): Promise<boolean>;

  /** Called after libp2p.start(); set up protocols, intervals, etc. */
  start(): Promise<void>;

  /** Called during node shutdown; clear intervals or cleanup resources */
  stop(): Promise<void>;

  /** Register all libp2p handlers (e.g. context.libp2p.handle(protocol, handler)) */
  setupProtocols(): void;

  /** Invoked whenever a registered protocol stream arrives */
  handleProtocol(protocol: string, stream: any, peerId: string): Promise<void>;

  // ─── Optional Hooks (implement as needed) ────────────────────────

  /** Filter which uploaded/downloaded files your plugin cares about */
  canHandleFile?(file: FileInfo): boolean;

  /** Called by core during uploadFile to add custom metadata */
  enhanceMetadata?(file: UploadFile): Promise<any>;

  /** Called whenever any file upload finishes; good for indexing or caching */
  onFileUploaded?(cid: string, fileInfo: FileInfo): void;

  /** Called whenever downloadFile(cid) succeeds; useful for auto-pin or cache */
  onFileDownloaded?(cid: string): void;

  /** Called whenever a local peer connects */
  onPeerConnected?(peerId: string, peer: PeerInfo): void;

  /** Called whenever a local peer disconnects */
  onPeerDisconnected?(peerId: string, peer: PeerInfo): void;

  /** Provide search results when core calls vinyl.searchFiles(query) */
  searchFiles?(query: any): Promise<NetworkFileInfo[]>;

  /** Provide recommendations when core calls vinyl.getRecommendations(cid) */
  getRecommendations?(basedOnCid: string): Promise<NetworkFileInfo[]>;

  /** (Optional) Test whether a peer supports your protocols */
  identifyPeer?(peerId: string): Promise<boolean>;

  // ─── HTTP Extension Hooks (if plugin exposes REST) ─────────────────

  /** Return the HTTP namespace (e.g. "/analytics") */
  getHttpNamespace?(): string;

  /** Return an Express Application or Router for your routes */
  getHttpRouter?(): Application | Router;
}
```

### 4. `BasePlugin`

```ts
export abstract class BasePlugin implements VinylPeerPlugin {
  protected context: PluginContext | null = null;
  protected isInitialized: boolean = false;
  protected isStarted: boolean = false;

  /** Must be implemented by each plugin to declare its name/version/protocols/etc. */
  abstract getCapabilities(): PluginCapabilities;

  async initialize(context: PluginContext): Promise<boolean> {
    this.context = context;
    this.isInitialized = true;

    // Verify requested permissions do not exceed granted permissions
    const requested = this.getCapabilities().permissions;
    const granted = context.getPermissions();
    for (const perm of Object.keys(requested) as (keyof PluginPermissions)[]) {
      if (requested[perm] && !granted[perm]) {
        console.error(
          `Plugin "${this.getCapabilities().name}" requested unauthorized permission: ${perm}`,
        );
        return false;
      }
    }
    return true;
  }

  async start(): Promise<void> {
    if (!this.isInitialized) {
      throw new Error("Plugin must be initialized before starting");
    }
    this.setupProtocols();
    this.isStarted = true;
  }

  async stop(): Promise<void> {
    this.isStarted = false;
  }

  abstract setupProtocols(): void;
  abstract handleProtocol(protocol: string, stream: any, peerId: string): Promise<void>;

  /**
   * Wrap every emitted event in an envelope: { source: pluginName, payload }
   * and forward to context.emit(...).
   */
  protected emit(event: string, payload: any): void {
    if (!this.context) return;
    const pluginName = this.getCapabilities().name;
    if (typeof event !== "string" || event.trim() === "") {
      console.warn(`Plugin "${pluginName}" attempted to emit invalid event:`, event);
      return;
    }
    this.context.emit(event, { source: pluginName, payload });
  }
}
```

---

## Creating a New Plugin Project

1. **Navigate to the monorepo root** (or your plugin workspace)

2. **Create a new folder** under `packages/` (e.g. `vinyl-peer-video-plugin`)

3. **Initialize a `package.json`** with at least:

   ```jsonc
   {
     "name": "vinyl-peer-video-plugin",
     "version": "1.0.0",
     "main": "dist/cjs/index.js",
     "module": "dist/esm/index.js",
     "types": "dist/esm/index.d.ts",
     "scripts": {
       "build": "tsc -b",
     },
     "dependencies": {
       "vinyl-peer-protocol": "workspace:*",
       "express": "^4.18.0",
     },
     "devDependencies": {
       "typescript": "^4.x",
     },
   }
   ```

4. **Create a `tsconfig.json`** targeting ES2020, `module: esnext`, output to `dist/`

5. **Install dependencies** (e.g. `npm install` or `yarn install` from repo root)

6. **Create your plugin’s source file**, e.g. `src/VideoPlugin.ts`

Your directory tree might look like:

```
packages/
└── vinyl-peer-video-plugin/
    ├── package.json
    ├── tsconfig.json
    └── src/
        └── VideoPlugin.ts
```

---

## Implementing Your Plugin

Below is a step-by-step breakdown for implementing a plugin. We’ll use a hypothetical “VideoPlugin” that:

- Advertises a custom libp2p protocol `/video-metadata/1.0.0`
- Hooks on file uploads to extract video resolution metadata
- Provides a simple search by resolution and title
- Exposes HTTP endpoints under `/api/video`

### 1. Define Capabilities

In `VideoPlugin.ts`, import core types:

```ts
import {
  BasePlugin,
  PluginCapabilities,
  PluginContext,
  VinylPeerPlugin,
} from "vinyl-peer-protocol";
import { PeerInfo, FileInfo, NetworkFileInfo, UploadFile } from "vinyl-peer-protocol";
import express, { Request, Response, Router } from "express";

interface VideoMetadata {
  title?: string;
  resolution?: string; // e.g. "1920x1080"
  durationSeconds?: number; // e.g. 120
}
```

Start your class and declare requested permissions:

```ts
export class VideoPlugin extends BasePlugin implements VinylPeerPlugin {
  private videoMetadataStore: Map<string, VideoMetadata> = new Map();

  constructor() {
    super();
  }

  getCapabilities(): PluginCapabilities {
    return {
      name: "vinyl-peer-video-plugin",
      version: "1.0.0",
      protocols: [
        "/video-metadata/1.0.0", // custom libp2p protocol
        "/video-discovery/1.0.0", // another discovery protocol
      ],
      capabilities: ["metadata", "search", "video"],
      fileTypes: ["video/*"], // only receive video uploads
      permissions: {
        accessFiles: true, // need to read/write context.files
        useNetwork: true, // need to handle and dial protocols
        modifyPeers: true, // might tag peers as “video nodes”
        exposeHttp: true, // will expose HTTP routes
      },
    };
  }

  // …continue below…
}
```

> **Key additions**:
>
> - `"permissions"` field is now **required**.
> - If you set `useNetwork: false`, any attempt to call `libp2p.handle(...)` in `setupProtocols()` will cause `initialize()` to return `false`.

---

### 2. Initialization

Override `initialize(context)` to store the context. Always call `super.initialize(context)` first to handle permission verification:

```ts
async initialize(context: PluginContext): Promise<boolean> {
  const ok = await super.initialize(context);
  if (!ok) return false;
  this.context = context;
  return true;
}
```

> **Note:** You do **not** need to set `this.isInitialized = true` yourself—`super.initialize` already does that, after verifying requested vs. granted permissions.

---

### 3. Protocol Handlers (`setupProtocols` + `handleProtocol`)

- **`setupProtocols()`** is invoked inside `start()`. It’s where you bind your libp2p protocol strings to `handleProtocol()` or inline handlers.
- **`handleProtocol()`** is called by the `PluginManager` whenever you receive an incoming libp2p stream that matches one of your declared protocols.

```ts
setupProtocols(): void {
  if (!this.context?.libp2p) return;

  // Bind "/video-metadata/1.0.0"
  this.context.libp2p.handle(
    "/video-metadata/1.0.0",
    async ({ stream, connection }: any) => {
      const remotePeerId = connection.remotePeer.toString();
      await this.handleProtocol("/video-metadata/1.0.0", stream, remotePeerId);
    }
  );

  // Bind "/video-discovery/1.0.0"
  this.context.libp2p.handle(
    "/video-discovery/1.0.0",
    async ({ stream, connection }: any) => {
      const remotePeerId = connection.remotePeer.toString();
      await this.handleProtocol("/video-discovery/1.0.0", stream, remotePeerId);
    }
  );
}

async handleProtocol(
  protocol: string,
  stream: any,
  peerId: string
): Promise<void> {
  if (protocol === "/video-metadata/1.0.0") {
    // 1. Read request bytes from stream.source
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream.source) {
      chunks.push(chunk);
    }
    const reqJson = new TextDecoder().decode(chunks[0]);
    const request = JSON.parse(reqJson) as { cid: string };

    // 2. Lookup stored metadata
    const vidMd = this.videoMetadataStore.get(request.cid) || null;
    const response = JSON.stringify({
      type: "video-metadata-response",
      cid: request.cid,
      metadata: vidMd,
    });

    // 3. Send back via stream.sink
    await stream.sink([new TextEncoder().encode(response)]);
  } else if (protocol === "/video-discovery/1.0.0") {
    // Similar pattern: read query, search, respond
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream.source) {
      chunks.push(chunk);
    }
    const reqJson = new TextDecoder().decode(chunks[0]);
    const query = JSON.parse(reqJson) as {
      resolution?: string;
      title?: string;
    };

    const matches: NetworkFileInfo[] = [];
    for (const [cid, md] of this.videoMetadataStore.entries()) {
      let match = true;
      if (query.resolution && md.resolution !== query.resolution) match = false;
      if (
        query.title &&
        !md.title?.toLowerCase().includes(query.title.toLowerCase())
      )
        match = false;
      if (match) {
        const fi = this.context!.files.get(cid)!;
        matches.push({
          ...fi,
          peerId: this.context!.nodeId,
          peerAddress: "local",
          availability: "online",
        });
      }
    }

    const response = JSON.stringify({
      type: "video-discovery-response",
      results: matches,
    });
    await stream.sink([new TextEncoder().encode(response)]);
  }
}
```

> **Tip:** Always check `this.context?.libp2p` before trying to bind protocols. If you declared `useNetwork: false` in `permissions`, attempting to call `libp2p.handle(...)` will fail.

---

### 4. Optional Hooks

You can implement any subset of the following hooks to extend core behavior:

#### a) `canHandleFile(file: FileInfo): boolean`

Filter which uploaded/downloaded files your plugin cares about.

```ts
canHandleFile(file: FileInfo): boolean {
  return file.type.startsWith("video/");
}
```

#### b) `enhanceMetadata(file: UploadFile): Promise<any>`

Called by core during `uploadFile()`. Return an object of custom metadata to merge into `FileInfo.metadata`.

```ts
async enhanceMetadata(file: UploadFile): Promise<VideoMetadata> {
  // (Stub) derive metadata from filename; replace with real video-probe logic
  const baseName = file.name.replace(/\.[^/.]+$/, "");
  const metadata: VideoMetadata = {
    title: baseName,
    resolution: "1920x1080",
    durationSeconds: 120,
  };
  return metadata;
}
```

Core merges this into `FileInfo.metadata`, then triggers `onFileUploaded(cid, fileInfo)`.

#### c) `onFileUploaded(cid: string, fileInfo: FileInfo): void`

Called after **any** file upload finishes. Good for indexing or caching.

```ts
onFileUploaded(cid: string, fileInfo: FileInfo): void {
  if (this.canHandleFile(fileInfo) && fileInfo.metadata) {
    this.videoMetadataStore.set(cid, fileInfo.metadata as VideoMetadata);
    this.emit("videoFileIndexed", { cid, metadata: fileInfo.metadata });
  }
}
```

#### d) `onFileDownloaded(cid: string): void`

Called whenever someone calls `node.downloadFile(cid)`. If you want to auto-pin or cache the video, implement here.

```ts
onFileDownloaded(cid: string): void {
  if (this.videoMetadataStore.has(cid)) {
    this.context!.pinFile(cid).catch(console.error);
  }
}
```

#### e) `onPeerConnected(peerId: string, peer: PeerInfo): void`

Fires whenever a peer connects. You can identify or tag peers as “video nodes”:

```ts
async identifyPeer(peerId: string): Promise<boolean> {
  try {
    await this.context!.libp2p.dialProtocol(peerId, "/video-metadata/1.0.0");
    return true;
  } catch {
    return false;
  }
}

onPeerConnected(peerId: string, peer: PeerInfo): void {
  this.identifyPeer(peerId).then((isVideoNode) => {
    if (isVideoNode && this.context) {
      peer.isVideoNode = true; // hypothetical field
      this.emit("videoPeerConnected", { peerId });
    }
  });
}
```

#### f) `searchFiles(query: any): Promise<NetworkFileInfo[]>`

If your plugin wants to provide search results when core’s `vinyl.searchFiles(query)` is called, implement this:

```ts
async searchFiles(query: any): Promise<NetworkFileInfo[]> {
  if (typeof query !== "object") return [];
  const results: NetworkFileInfo[] = [];
  for (const [cid, md] of this.videoMetadataStore.entries()) {
    let match = true;
    if (query.resolution && md.resolution !== query.resolution) match = false;
    if (
      query.title &&
      !md.title?.toLowerCase().includes((query.title as string).toLowerCase())
    )
      match = false;
    if (match) {
      const fi = this.context!.files.get(cid)!;
      results.push({
        ...fi,
        peerId: this.context!.nodeId,
        peerAddress: "local",
        availability: "online",
      });
    }
  }
  return results;
}
```

#### g) `getRecommendations(basedOnCid: string): Promise<NetworkFileInfo[]>`

Optional recommendation engine (e.g. “videos of similar resolution”).

```ts
async getRecommendations(basedOnCid: string): Promise<NetworkFileInfo[]> {
  const baseMd = this.videoMetadataStore.get(basedOnCid);
  if (!baseMd) return [];

  const recs: NetworkFileInfo[] = [];
  for (const [cid, md] of this.videoMetadataStore.entries()) {
    if (cid === basedOnCid) continue;
    if (md.resolution === baseMd.resolution) {
      const fi = this.context!.files.get(cid)!;
      recs.push({
        ...fi,
        peerId: this.context!.nodeId,
        peerAddress: "local",
        availability: "online",
      });
    }
  }
  return recs.slice(0, 10);
}
```

> **Note:** Core’s `vinyl.getRecommendations(cid)` automatically invokes every plugin’s `getRecommendations(...)` and aggregates their results.

---

### 5. HTTP Endpoints (if applicable)

If your plugin needs to expose REST endpoints, implement:

```ts
getHttpNamespace(): string {
  return "/api/video";
}

getHttpRouter(): Express | Router {
  const router = express.Router();

  /**
   * GET /api/video/metadata/:cid
   * → Return raw VideoMetadata for the given file CID.
   */
  router.get("/metadata/:cid", (req: Request, res: Response) => {
    const { cid } = req.params;
    const md = this.videoMetadataStore.get(cid) || null;
    if (!md) {
      return res.status(404).json({ error: `No metadata for CID ${cid}` });
    }
    return res.json(md);
  });

  /**
   * GET /api/video/search?resolution=1080p&title=demo
   * → Return search results by resolution/title.
   */
  router.get("/search", async (req: Request, res: Response) => {
    const query: any = {};
    if (req.query.resolution) query.resolution = String(req.query.resolution);
    if (req.query.title) query.title = String(req.query.title);
    try {
      const results = await this.searchFiles(query);
      return res.json({ results });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}
```

> **Important:** The CLI’s `WebServer` (in `vinyl-peer-cli`) will mount each plugin’s router under its namespace. For example, hitting `http://localhost:3001/api/video/metadata/<cid>` will route to your handler.

---

## Registering & Running Your Plugin

1. **Build your plugin**:

   ```bash
   cd packages/vinyl-peer-video-plugin
   npm run build
   # or from root:
   npm run build --workspace=vinyl-peer-video-plugin
   ```

   This compiles `src/VideoPlugin.ts` → `dist/esm/index.js` and `dist/cjs/index.js`.

2. **Modify the CLI launcher** to include your plugin in the `new Vinyl([...])` array. For example, in `packages/vinyl-peer-cli/src/run-vinyl.ts`:

   ```ts
   import { VideoPlugin } from "vinyl-peer-video-plugin/dist/esm/index.js";
   import { MusicPlugin } from "vinyl-peer-music-plugin/dist/esm/index.js";
   import { AnalyticsPlugin } from "vinyl-peer-analytics/dist/esm/index.js";
   import { ReplicationPlugin } from "vinyl-peer-replication-plugin/dist/esm/index.js";
   // …other imports…

   async function main() {
     const vinyl = new Vinyl([
       new MusicPlugin(),
       new AnalyticsPlugin(),
       new ReplicationPlugin(),
       new VideoPlugin(), // <-- your plugin
     ]);

     // … initialize, start WebServer, etc.
   }
   ```

3. **Run a node with your plugin**:

   ```bash
   npm run start --workspace=vinyl-peer-cli -- --web-server
   ```

   - You should see console logs indicating your plugin’s registration, protocol binding, and startup.
   - Verify your HTTP endpoints, e.g.:

     ```
     http://localhost:3001/api/video/metadata/<cid>
     ```

4. **Test libp2p protocols**:

   - Run two or more Vinyl nodes (each with your plugin) on different hosts or ports.
   - From Node B, call:

     ```ts
     await vinyl.libp2p.dialProtocol(peerIdA, "/video-metadata/1.0.0");
     ```

     to check if peer A responds with stored metadata.

---

## Testing & Debugging

- **Unit Tests**:

  - Write Jest or Mocha tests (in a `test/` folder) to validate your plugin’s methods in isolation.
  - Mock `PluginContext` by passing a minimal stub that implements `getPermissions()` + required fields.

- **Console Logging**:

  - Add `console.log(...)` inside `initialize`, `setupProtocols`, and any hook methods to confirm execution.

- **HTTP Endpoint Testing**:

  - Use `curl`, Postman, or your browser to hit `/api/<your-namespace>/…` and verify JSON responses.

- **Protocol Testing**:

  - In a separate script or REPL, import `libp2p` and manually dial your plugin’s protocol to a known peer.

- **Network Simulation**:

  - Run two Vinyl nodes (each with your plugin) on different hosts or ports.
  - Upload a video file on Node A; Node B should discover it via libp2p protocols (assuming you implement broadcast or DHT).
  - Observe logs in each node’s `onFileUploaded` or `onFileDownloaded`.

---

## Plugin Publishing & Versioning

1. Bump your plugin’s version in `package.json` (e.g., `"version": "1.1.0"`).

2. Tag your commit:

   ```bash
   git tag v1.1.0
   git push --tags
   ```

3. Publish to npm (ensure name is unique):

   ```bash
   cd packages/vinyl-peer-video-plugin
   npm publish --access public
   ```

4. Consumers can then:

   ```bash
   npm install vinyl-peer-video-plugin
   ```

   and add `new VideoPlugin()` to their Vinyl node.

---

## Packages

### 1. `vinyl-peer-protocol` (Core)

- **Purpose**:

  - Manages Libp2p node lifecycle, Helia/IPFS integration, file upload/download encryption, and the plugin framework.
  - Exposes an API for uploading/downloading, pin/unpin, searching, and event subscription.

- **Key Files/Modules**:

  - `Vinyl.ts`: Core `Vinyl` class (P2P node + storage + plugin management)
  - `PluginInterface.ts`: Defines `PluginContext`, `VinylPeerPlugin`, `PluginCapabilities`, `PluginPermissions`, `BasePlugin`, etc.
  - `PluginManager.ts`: Registers plugins, routes protocols, and propagates events.
  - `types.ts`: Shared types (`PeerInfo`, `FileInfo`, `NetworkFileInfo`, `NodeStats`, `StorageMode`, `UploadFile`).

- **README**: [packages/vinyl-peer-protocol/README.md](./packages/vinyl-peer-protocol/README.md)

---

### 2. `vinyl-peer-music-plugin`

- **Purpose**: Music-specific functionality.

- **Features**:

  - Metadata extraction (artist, title, year, genre) from filenames and ID3 tags.
  - Search engine for local music files (`searchFiles(query: MusicDiscoveryQuery)`).
  - Simple recommendation engine (`getRecommendations(basedOnCid)`).
  - HTTP endpoints under `/api/music`:

    - `GET  /recommendations/:cid` → Get recommendations.
    - `GET  /stats` → Music stats (counts, top artists/genres).
    - `GET  /metadata/:cid` → Raw music metadata by CID.
    - `GET  /all` → List all local audio files.

- **README**: [packages/vinyl-peer-music-plugin/README.md](./packages/vinyl-peer-music-plugin/README.md)

---

### 3. `vinyl-peer-analytics`

- **Purpose**: Collect and expose node-level analytics.

- **Features**:

  - Periodic snapshots of metrics: peer counts, file counts, storage usage, pin counts, bandwidth.
  - HTTP endpoints under `/api/analytics`:

    - `GET  /stats` → Current node stats (peers, files, storage, pins).
    - `GET  /peers` → List known peers and their statuses.
    - `GET  /files` → List local and network files with metadata.

- **README**: [packages/vinyl-peer-analytics/README.md](./packages/vinyl-peer-analytics/README.md)

---

### 4. `vinyl-peer-replication-plugin`

- **Purpose**: Auto-pin (auto-replicate) any file you download.

- **Features**:

  - Hooks into `onFileDownloaded(cid)` to call `context.pinFile(cid)` when enabled.
  - HTTP endpoints under `/replication`:

    - `GET  /status` → `{ enabled: boolean }`
    - `POST /on` → Turn auto-pin ON
    - `POST /off` → Turn auto-pin OFF

- **How It Works**:

  1. **Initialization**: Stores `PluginContext` (which now includes `pinFile`/`unpinFile`).
  2. **onFileDownloaded(...)**: If enabled, automatically calls `context.pinFile(cid)`.
  3. **HTTP Routes**: Toggle the `enabled` flag at runtime via `POST /on` or `POST /off`.

- **README**: [packages/vinyl-peer-replication-plugin/README.md](./packages/vinyl-peer-replication-plugin/README.md)

---

### 5. `vinyl-peer-cli` (CLI & Web Server)

- **Purpose**:

  - Provides a command-line interface for interacting with a Vinyl node.
  - Runs an Express web server to expose core + plugin HTTP endpoints on port 3001 by default.

- **Features**:

  - CLI commands: `start`, `upload <file>`, `download <cid>`, `pin <cid>`, `unpin <cid>`, `search <term>`
  - `WebServer.ts`: Instantiates an Express app, mounts each plugin’s HTTP routes under its namespace, and starts listening.

---

## CORS & Helmet in `WebServer.ts`

The CLI’s Express app in `vinyl-peer-cli` uses CORS and Helmet to secure plugin endpoints. Example:

```ts
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const app = express();

// Replace the origin array with your actual front-end domains (e.g. "https://app.example.com")
app.use(
  cors({
    origin: ["https://app.example.com", "https://dashboard.example.com"],
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  }),
);

app.use(helmet());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests – try again later." },
});

app.use(limiter);

// Mount each plugin’s router under its namespace here
// e.g. app.use("/api/music", musicPlugin.getHttpRouter());
// …
```

- **CORS `origin`**: Specify the browser origins you trust (e.g. your front-end’s domain). This is not a path on each peer; it’s the list of allowed domains that may make cross-origin requests.
- **Helmet**: Adds standard security headers.
- **Rate Limiter**: Protects against brute-force or DoS by limiting requests per IP.

---

## Contributing

We welcome contributions! Please see the [Contributing Guidelines](CONTRIBUTING.md) for details on:

- Setting up your development environment
- Coding conventions & styling
- Submitting pull requests & issue reporting

---

## License

This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for details.
