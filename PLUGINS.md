# Vinyl Peer Plugin Development Guide

This guide walks you through creating a custom plugin for Vinyl Peer, our modular P2P media‐sharing framework. You’ll learn how to:

1. Understand the core plugin interfaces (including permissions)
2. Scaffold a new plugin (TypeScript project structure)
3. Implement required methods (`getCapabilities`, `initialize`, `setupProtocols`, `handleProtocol`)
4. Add optional hooks (file events, peer events, metadata, search/recommendations)
5. Expose HTTP endpoints
6. Register and test your plugin with a Vinyl node

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Plugin Architecture Overview](#plugin-architecture-overview)
3. [Key Interfaces & Base Classes](#key-interfaces--base-classes)
4. [Creating a New Plugin Project](#creating-a-new-plugin-project)
5. [Implementing Your Plugin](#implementing-your-plugin)
   - [1. Define Capabilities (including permissions)](#1-define-capabilities)
   - [2. Initialization](#2-initialization)
   - [3. Protocol Handlers (`setupProtocols` + `handleProtocol`)](#3-protocol-handlers-setupprotocols--handleprotocol)
   - [4. Optional Hooks](#4-optional-hooks)
   - [5. HTTP Endpoints (if applicable)](#5-http-endpoints-if-applicable)
6. [Registering & Running Your Plugin](#registering--running-your-plugin)
7. [Testing & Debugging](#testing--debugging)
8. [Plugin Publishing & Versioning](#plugin-publishing--versioning)
9. [Example: A “Video Discovery” Plugin](#example-a-video-discovery-plugin)
10. [Best Practices & Tips](#best-practices--tips)

---

## Prerequisites

- Basic familiarity with **Node.js** and **TypeScript**
- Understanding of **npm** (or Yarn) workspaces
- A working Vinyl Peer monorepo checkout (or installed from npm)
- Installed dependencies:

  ```bash
  npm install
  # or
  yarn install
  ```

````

* (Optional) Familiarity with **libp2p** and **Express**

---

## Plugin Architecture Overview

Vinyl Peer’s core package (`vinyl-peer-protocol`) provides:

* A **`PluginContext`** object that exposes:

  * `nodeId: string` → your node’s PeerID
  * `libp2p: any` → the underlying libp2p instance (for custom protocols)
  * `files: Map<string, FileInfo>` → local `FileInfo` map
  * `peers: Map<string, PeerInfo>` → known peers
  * `networkFiles: Map<string, NetworkFileInfo>` → discovered remote files
  * `emit(event: string, envelope: { source: string; payload: any })`: broadcast custom events (must provide an envelope)
  * `pinFile(cid: string): Promise<void>` → pin an IPFS CID locally
  * `unpinFile(cid: string): Promise<void>` → unpin a CID
  * `getPermissions(): PluginPermissions` → retrieve granted permission set

* A **`PluginManager`** that:

  1. Calls `initialize(context)` on each plugin, checks requested vs. granted permissions
  2. Registers any custom libp2p protocols via `libp2p.handle(...)` (if `useNetwork: true`)
  3. Stores plugins in a registry and notifies them of events (`onPeerConnected`, `onFileUploaded`, etc.)
  4. Invokes `start()` after `libp2p.start()`, so you can set up protocols safely
  5. Dispatches `searchFiles` & `getRecommendations` to each plugin

* A **`BasePlugin`** abstract class implementing `VinylPeerPlugin`, providing:

  * A default `initialize(context)` that stores the context, verifies permissions, and sets `isInitialized = true`
  * A default `start()` that enforces `isInitialized`, calls `setupProtocols()`, then sets `isStarted = true`
  * A default `stop()` that sets `isStarted = false`
  * A protected helper `emit(event: string, payload: any)` that wraps payload in `{ source: pluginName, payload }` and invokes `context.emit(...)`

* An HTTP server (in **`vinyl-peer-cli`**), which automatically:

  1. Creates an Express app
  2. Applies global middleware (CORS, Helmet, rate limiting)
  3. Mounts each plugin’s router under its namespace (returned by `getHttpNamespace()`)
  4. Listens on port 3001 (by default)

---

## Key Interfaces & Base Classes

Below are the up‐to‐date, exact TypeScript definitions you’ll use when writing plugins. Note the permissions field and updated `emit` signature.

### 1. `PluginContext`

```ts
export interface PluginContext {
  nodeId: string;
  libp2p: any;
  files: Map<string, FileInfo>;
  peers: Map<string, PeerInfo>;
  networkFiles: Map<string, NetworkFileInfo>;

  /**
   * Internal event emitter. Must include an envelope:
   *   { source: <pluginName>, payload: <any> }
   * Validated by Vinyl before broadcasting.
   */
  emit: (event: string, envelope: { source: string; payload: any }) => void;

  /** Pin a CID locally. */
  pinFile: (cid: string) => Promise<void>;
  /** Unpin a CID locally. */
  unpinFile: (cid: string) => Promise<void>;

  /** Retrieve this plugin’s granted permissions. */
  getPermissions: () => PluginPermissions;
}
```

> **Important changes**:
>
> 1. `emit(...)` expects an **envelope** `{ source, payload }`.
> 2. `getPermissions()` returns a `PluginPermissions` object so your plugin can verify allowances.

---

### 2. `PluginCapabilities`

```ts
export interface PluginCapabilities {
  /** Unique plugin name (e.g., "vinyl-peer-music-plugin") */
  name: string;
  /** Semantic version, e.g., "1.0.0" */
  version: string;
  /** libp2p protocols this plugin handles */
  protocols: string[]; // e.g., ["/music-discovery/1.0.0"]
  /** Functional tags (e.g., ["streaming", "search", "metadata"]) */
  capabilities: string[];
  /** Optional: MIME‐type prefixes this plugin will receive (e.g., ["audio/*"]) */
  fileTypes?: string[];
  /** Permissions requested from the host node */
  permissions: PluginPermissions;
}
```

---

### 3. `PluginPermissions`

```ts
export interface PluginPermissions {
  accessFiles: boolean; // Can read/write `context.files`
  useNetwork: boolean; // Can dial or handle libp2p protocols
  modifyPeers: boolean; // Can tag peers (e.g., `peer.isMusicNode = true`)
  exposeHttp: boolean; // Can register HTTP routes via `getHttpRouter()`
}
```

> **Example**:
>
> ```ts
> permissions: {
>   accessFiles: true,
>   useNetwork: false,
>   modifyPeers: false,
>   exposeHttp: true,
> }
> ```

---

### 4. `VinylPeerPlugin`

```ts
export interface VinylPeerPlugin {
  // ─── Required ─────────────────────────────────

  /** Return capabilities (name, version, protocols, etc.) */
  getCapabilities(): PluginCapabilities;

  /** Called once at startup; store context & verify permissions */
  initialize(context: PluginContext): Promise<boolean>;

  /** Called after libp2p.start(); set up protocols, intervals, etc. */
  start(): Promise<void>;

  /** Called during shutdown; clear intervals or cleanup. */
  stop(): Promise<void>;

  /** Register libp2p handlers (e.g., `libp2p.handle(protocol, handler)`) */
  setupProtocols(): void;

  /** Invoked whenever a registered protocol stream arrives */
  handleProtocol(protocol: string, stream: any, peerId: string): Promise<void>;

  // ─── Optional Hooks ─────────────────────────────────

  /** Filter which uploaded/downloaded files you care about */
  canHandleFile?(file: FileInfo): boolean;

  /** Called during `uploadFile` for custom metadata */
  enhanceMetadata?(file: UploadFile): Promise<any>;

  /** Called after any file upload; good for indexing/caching */
  onFileUploaded?(cid: string, fileInfo: FileInfo): void;

  /** Called after `downloadFile(cid)` completes; e.g. auto‐pin */
  onFileDownloaded?(cid: string): void;

  /** Called when a peer connects */
  onPeerConnected?(peerId: string, peer: PeerInfo): void;

  /** Called when a peer disconnects */
  onPeerDisconnected?(peerId: string, peer: PeerInfo): void;

  /** Provide search results for `vinyl.searchFiles(...)` */
  searchFiles?(query: any): Promise<NetworkFileInfo[]>;

  /** Provide recommendations for `vinyl.getRecommendations(cid)` */
  getRecommendations?(basedOnCid: string): Promise<NetworkFileInfo[]>;

  /** Optionally verify whether a peer supports your protocols */
  identifyPeer?(peerId: string): Promise<boolean>;

  // ─── HTTP Hooks (if exposing REST) ───────────────────────

  /** Return the single namespace under which you’ll mount HTTP routes */
  getHttpNamespace?(): string; // e.g., "/api/music"

  /** Return an Express `Router` (or `Express` app) for REST endpoints */
  getHttpRouter?(): Express | Router;
}
```

---

### 5. `BasePlugin`

```ts
export abstract class BasePlugin implements VinylPeerPlugin {
  protected context: PluginContext | null = null;
  protected isInitialized: boolean = false;
  protected isStarted: boolean = false;

  /** Declare plugin name/version/protocols/permissions. */
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
          `Plugin "${this.getCapabilities().name}" requested unauthorized permission: ${perm}`
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
   * Wrap every emitted event in an envelope { source, payload }
   * and forward to `context.emit(...)`.
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

> **Note:** If any requested permission is denied, `initialize()` returns `false` and your plugin will not be registered.

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
       "build": "tsc -b"
     },
     "dependencies": {
       "vinyl-peer-protocol": "workspace:*",
       "express": "^4.18.0"
     },
     "devDependencies": {
       "typescript": "^4.x"
     }
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

Below is a step‐by‐step breakdown. We’ll use a hypothetical “VideoPlugin” that:

* Advertises a libp2p protocol `/video-metadata/1.0.0`
* Hooks on file uploads to extract video resolution metadata
* Provides a search by resolution and title
* Exposes HTTP endpoints under `/api/video`

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
        accessFiles: true,   // Can read/write `context.files`
        useNetwork: true,    // Can bind/dial libp2p protocols
        modifyPeers: true,   // Can tag peers as “video nodes”
        exposeHttp: true,    // Can register HTTP routes
      },
    };
  }

  // …continue below…
}
```

> **Key**:
>
> * `"permissions"` is required.
> * If you set `useNetwork: false`, any attempt to call `libp2p.handle(...)` in `setupProtocols()` will fail.

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

> You do **not** need to set `this.isInitialized = true` yourself—`super.initialize` does that after verifying permissions.

---

### 3. Protocol Handlers (`setupProtocols` + `handleProtocol`)

* **`setupProtocols()`** is invoked inside `start()`. Bind libp2p protocols here.
* **`handleProtocol()`** is called whenever a registered protocol stream arrives.

```ts
setupProtocols(): void {
  if (!this.context?.libp2p) return;

  // Bind "/video-metadata/1.0.0"
  this.context.libp2p.handle("/video-metadata/1.0.0", async ({ stream, connection }: any) => {
    const remotePeerId = connection.remotePeer.toString();
    await this.handleProtocol("/video-metadata/1.0.0", stream, remotePeerId);
  });

  // Bind "/video-discovery/1.0.0"
  this.context.libp2p.handle("/video-discovery/1.0.0", async ({ stream, connection }: any) => {
    const remotePeerId = connection.remotePeer.toString();
    await this.handleProtocol("/video-discovery/1.0.0", stream, remotePeerId);
  });
}

async handleProtocol(protocol: string, stream: any, peerId: string): Promise<void> {
  if (protocol === "/video-metadata/1.0.0") {
    // Read request from stream.source
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream.source) {
      chunks.push(chunk);
    }
    const req = JSON.parse(new TextDecoder().decode(chunks[0])) as { cid: string };
    const vidMd = this.videoMetadataStore.get(req.cid) || null;

    const response = JSON.stringify({
      type: "video-metadata-response",
      cid: req.cid,
      metadata: vidMd,
    });
    await stream.sink([new TextEncoder().encode(response)]);

  } else if (protocol === "/video-discovery/1.0.0") {
    // Read query from stream.source
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream.source) {
      chunks.push(chunk);
    }
    const query = JSON.parse(new TextDecoder().decode(chunks[0])) as {
      resolution?: string;
      title?: string;
    };

    const matches: NetworkFileInfo[] = [];
    for (const [cid, md] of this.videoMetadataStore.entries()) {
      let match = true;
      if (query.resolution && md.resolution !== query.resolution) match = false;
      if (query.title && !md.title?.toLowerCase().includes(query.title.toLowerCase()))
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

> **Tip**: Always check `this.context?.libp2p` before binding protocols. If `useNetwork: false`, `initialize()` will fail.

---

### 4. Optional Hooks

Implement any subset to extend core behavior:

#### a) `canHandleFile(file: FileInfo): boolean`

Filter which uploaded/downloaded files your plugin cares about.

```ts
canHandleFile(file: FileInfo): boolean {
  return file.type.startsWith("video/");
}
```

#### b) `enhanceMetadata(file: UploadFile): Promise<any>`

Called during `uploadFile()`. Return an object of custom metadata to merge into `FileInfo.metadata`.

```ts
async enhanceMetadata(file: UploadFile): Promise<VideoMetadata> {
  const baseName = file.name.replace(/\.[^/.]+$/, "");
  return {
    title: baseName,
    resolution: "1920x1080", // stub—replace with real probing logic
    durationSeconds: 120,
  };
}
```

Core merges this into `FileInfo.metadata`, then calls `onFileUploaded(cid, fileInfo)`.

#### c) `onFileUploaded(cid: string, fileInfo: FileInfo): void`

Called after any file upload finishes. Good for indexing or caching.

```ts
onFileUploaded(cid: string, fileInfo: FileInfo): void {
  if (this.canHandleFile(fileInfo) && fileInfo.metadata) {
    this.videoMetadataStore.set(cid, fileInfo.metadata as VideoMetadata);
    this.emit("videoFileIndexed", { cid, metadata: fileInfo.metadata });
  }
}
```

#### d) `onFileDownloaded(cid: string): void`

Called when `downloadFile(cid)` completes successfully. E.g., auto‐pin the CID:

```ts
onFileDownloaded(cid: string): void {
  if (this.videoMetadataStore.has(cid)) {
    this.context!.pinFile(cid).catch(console.error);
  }
}
```

#### e) `onPeerConnected(peerId: string, peer: PeerInfo): void`

Called when a peer connects. You can identify or tag peers:

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
    if (isVideoNode) {
      peer.isVideoNode = true; // hypothetical field
      this.emit("videoPeerConnected", { peerId });
    }
  });
}
```

#### f) `searchFiles(query: any): Promise<NetworkFileInfo[]>`

Core’s `vinyl.searchFiles("term")` calls all plugins that implement this. Return matching `NetworkFileInfo[]`.

```ts
async searchFiles(query: any): Promise<NetworkFileInfo[]> {
  if (typeof query !== "object") return [];
  const results: NetworkFileInfo[] = [];
  for (const [cid, md] of this.videoMetadataStore.entries()) {
    let match = true;
    if (query.resolution && md.resolution !== query.resolution) match = false;
    if (query.title && !md.title?.toLowerCase().includes((query.title as string).toLowerCase()))
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

Optional recommendation engine (e.g., “videos of similar resolution”).

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

> **Note**: Core’s `vinyl.getRecommendations(cid)` automatically invokes all plugins’ `getRecommendations(...)` and aggregates results.

---

### 5. HTTP Endpoints (if applicable)

If your plugin needs to expose REST endpoints, implement:

```ts
getHttpNamespace(): string {
  return "/api/video";
}

getHttpRouter(): Express | Router {
  const router = express.Router();

  /** GET /api/video/metadata/:cid → Return VideoMetadata for a CID */
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

> **Important**: The CLI’s Express server will mount each plugin’s router under the returned namespace. For example, if your namespace is `/api/video`, then hitting `http://localhost:3001/api/video/metadata/<cid>` will route to your handler.

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

     // …initialize, start WebServer, etc.
   }
   ```

3. **Run a node with your plugin**:

   ```bash
   npm run start --workspace=vinyl-peer-cli -- --web-server
   ```

   * You should see console logs indicating your plugin’s registration, protocol binding, and startup.
   * Verify your HTTP endpoints, e.g.:

     ```
     http://localhost:3001/api/video/metadata/<cid>
     ```

4. **Test libp2p protocols**:

   * Run two or more Vinyl nodes (each with your plugin).
   * From Node B, call:

     ```ts
     await vinyl.libp2p.dialProtocol(peerIdA, "/video-metadata/1.0.0");
     ```

     to check if peer A responds with stored metadata.

---

## Testing & Debugging

* **Unit Tests**:

  * Write Jest or Mocha tests (in a `test/` folder) to validate your plugin’s methods in isolation.
  * Mock `PluginContext` by passing a minimal stub that implements the interface (including `getPermissions`).

* **Console Logging**:

  * Add `console.log(...)` inside `initialize`, `setupProtocols`, and any hook methods to confirm execution.

* **HTTP Endpoint Testing**:

  * Use `curl`, Postman, or your browser to hit `/api/<your-namespace>/…` and verify JSON responses.

* **Protocol Testing**:

  * In a separate script or REPL, import `libp2p` and manually dial your protocol to a known peer.

* **Network Simulation**:

  * Run two Vinyl nodes (each with your plugin) on different hosts or ports.
  * Upload a video file on Node A; Node B should discover it via libp2p protocols (if you implement broadcasting or DHT).
  * Observe logs in each node’s `onFileUploaded` or `onFileDownloaded`.

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

## Example: A “Video Discovery” Plugin

Below is a concise, end‐to‐end example of `src/VideoPlugin.ts`. Copy/paste into your plugin folder (adjust imports), run `npm run build`, and test.

```ts
// File: packages/vinyl-peer-video-plugin/src/VideoPlugin.ts

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
  resolution?: string;
  durationSeconds?: number;
}

export class VideoPlugin extends BasePlugin implements VinylPeerPlugin {
  private videoMetadataStore: Map<string, VideoMetadata> = new Map();

  constructor() {
    super();
  }

  getCapabilities(): PluginCapabilities {
    return {
      name: "vinyl-peer-video-plugin",
      version: "1.0.0",
      protocols: ["/video-metadata/1.0.0", "/video-discovery/1.0.0"],
      capabilities: ["metadata", "search", "video"],
      fileTypes: ["video/*"],
      permissions: {
        accessFiles: true,
        useNetwork: true,
        modifyPeers: true,
        exposeHttp: true,
      },
    };
  }

  async initialize(context: PluginContext): Promise<boolean> {
    const ok = await super.initialize(context);
    if (!ok) return false;
    this.context = context;
    return true;
  }

  setupProtocols(): void {
    if (!this.context?.libp2p) return;

    this.context.libp2p.handle("/video-metadata/1.0.0", async ({ stream, connection }: any) => {
      await this.handleProtocol("/video-metadata/1.0.0", stream, connection.remotePeer.toString());
    });

    this.context.libp2p.handle("/video-discovery/1.0.0", async ({ stream, connection }: any) => {
      await this.handleProtocol("/video-discovery/1.0.0", stream, connection.remotePeer.toString());
    });
  }

  async handleProtocol(protocol: string, stream: any, peerId: string): Promise<void> {
    if (protocol === "/video-metadata/1.0.0") {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream.source) {
        chunks.push(chunk);
      }
      const req = JSON.parse(new TextDecoder().decode(chunks[0])) as { cid: string };
      const vidMd = this.videoMetadataStore.get(req.cid) || null;
      const response = JSON.stringify({
        type: "video-metadata-response",
        cid: req.cid,
        metadata: vidMd,
      });
      await stream.sink([new TextEncoder().encode(response)]);
    } else if (protocol === "/video-discovery/1.0.0") {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream.source) {
        chunks.push(chunk);
      }
      const query = JSON.parse(new TextDecoder().decode(chunks[0])) as {
        resolution?: string;
        title?: string;
      };
      const matches: NetworkFileInfo[] = [];
      for (const [cid, md] of this.videoMetadataStore.entries()) {
        let match = true;
        if (query.resolution && md.resolution !== query.resolution) match = false;
        if (query.title && !md.title?.toLowerCase().includes(query.title.toLowerCase()))
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

  canHandleFile(file: FileInfo): boolean {
    return file.type.startsWith("video/");
  }

  async enhanceMetadata(file: UploadFile): Promise<VideoMetadata> {
    const baseName = file.name.replace(/\.[^/.]+$/, "");
    return {
      title: baseName,
      resolution: "1920x1080",
      durationSeconds: 120,
    };
  }

  onFileUploaded(cid: string, fileInfo: FileInfo): void {
    if (this.canHandleFile(fileInfo) && fileInfo.metadata) {
      this.videoMetadataStore.set(cid, fileInfo.metadata as VideoMetadata);
      this.emit("videoFileIndexed", { cid, metadata: fileInfo.metadata });
    }
  }

  onFileDownloaded(cid: string): void {
    if (this.videoMetadataStore.has(cid)) {
      this.context!.pinFile(cid).catch(console.error);
    }
  }

  async searchFiles(query: any): Promise<NetworkFileInfo[]> {
    if (typeof query !== "object") return [];
    const results: NetworkFileInfo[] = [];
    for (const [cid, md] of this.videoMetadataStore.entries()) {
      let match = true;
      if (query.resolution && md.resolution !== query.resolution) match = false;
      if (query.title && !md.title?.toLowerCase().includes(query.title.toLowerCase()))
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

  getHttpNamespace(): string {
    return "/api/video";
  }

  getHttpRouter(): Router {
    const router = express.Router();

    router.get("/metadata/:cid", (req: Request, res: Response) => {
      const { cid } = req.params;
      const md = this.videoMetadataStore.get(cid) || null;
      if (!md) {
        return res.status(404).json({ error: `No metadata for CID ${cid}` });
      }
      return res.json(md);
    });

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
}
```

Build this plugin (`npm run build`), then register it in your CLI node launcher and start Vinyl:

```bash
npm run start --workspace=vinyl-peer-cli -- --web-server
```

Look for logs like:

```
PluginManager: initializing plugin "vinyl-peer-video-plugin" v1.0.0…
PluginManager: bound protocol "/video-metadata/1.0.0" → plugin "vinyl-peer-video-plugin"
PluginManager: bound protocol "/video-discovery/1.0.0" → plugin "vinyl-peer-video-plugin"
PluginManager: plugin "vinyl-peer-video-plugin" started
```

---

## Best Practices & Tips

1. **Unique Protocol Names & Versions**

   * Include a version segment (e.g. `"/video-metadata/1.0.0"`).
   * Bump version if semantics change (e.g., `1.0.0 → 1.1.0`).

2. **Filter by `fileTypes` + `canHandleFile`**

   * Use `fileTypes: ["video/*"]` to indicate you only want video uploads.
   * In hooks, double‐verify with `canHandleFile(file)` before processing.

3. **Permissions Are Mandatory**

   * If `useNetwork: true`, core will bind your protocols—otherwise, `initialize()` fails.
   * If `exposeHttp: true`, the CLI’s server will mount your `getHttpRouter()` under `getHttpNamespace()`.

4. **Minimize Heavy Work in Hooks**

   * Long‐running tasks (e.g. video transcoding) should be offloaded asynchronously.
   * Consider returning a job ID in your hook, then processing in the background.

5. **Leverage Core’s Search & Recommendation**

   * Implement `searchFiles()` or `getRecommendations()` so that `vinyl.searchFiles("term")` and `vinyl.getRecommendations(cid)` include your results.

6. **Use `context.emit(...)` for Custom Events**

   * Fire events like `"videoFileIndexed"` or `"videoProcessingComplete"`.
   * Consumers can subscribe via `vinyl.onEvent((event, envelope) => {...})`.

7. **Pin/Unpin Responsibly**

   * Don’t auto‐pin every downloaded CID by default—provide a toggle (e.g. via HTTP).

8. **Expose Clear HTTP Namespaces**

   * Choose a unique namespace string (e.g. `/api/video`).
   * Return a fresh `express.Router()` in `getHttpRouter()`.

9. **Versioned Dependencies**

   * Depend on a compatible `vinyl-peer-protocol@^X.Y.Z` in your `package.json`.
   * Publish under a unique npm name (e.g. `@myorg/vinyl-peer-video-plugin`).

10. **Comprehensive Documentation**

    * Document:

      * Protocol strings (e.g. `"/video-metadata/1.0.0"`)
      * HTTP endpoints (routes + parameters)
      * Example JSON payloads for protocol messages
      * Peer‐bootstrap or DHT usage if applicable

11. **Graceful Shutdown**

    * If setting intervals (e.g. broadcast loops), implement `stop()` to clear them.
    * Always call `await super.stop()` if you override `stop()`.

---

Congratulations—you now have everything you need to build, test, and deploy your own Vinyl Peer plugin! Whether adding support for video, images, document search, or decentralized chat, the same principles apply:

1. **Declare your capabilities (including permissions)**
2. **Initialize with `PluginContext`, verify permissions, and wire up `setupProtocols()`**
3. **Implement optional hooks (file events, search, recommendations)**
4. **Expose HTTP routes under a unique namespace**
5. **Register in the CLI or a custom node launcher**

Happy hacking!
````
