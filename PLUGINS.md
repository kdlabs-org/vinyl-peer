# Vinyl Peer Plugin Development Guide

This guide provides a comprehensive walkthrough for creating custom plugins for Vinyl Peer, a modular P2P media-sharing framework. By following this guide, you will learn how to:

1. Understand the core plugin interfaces, including the permissions system
2. Scaffold a new plugin using a TypeScript project structure
3. Implement required methods (`getCapabilities`, `initialize`, `setupProtocols`, `handleProtocol`)
4. Add optional hooks for file events, peer events, metadata enhancement, and search/recommendation features
5. Expose HTTP endpoints for external interaction, now integrated directly into the core `Vinyl` class
6. Register, run, and test your plugin with a Vinyl Peer node

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Plugin Architecture Overview](#plugin-architecture-overview)
3. [Key Interfaces & Base Classes](#key-interfaces--base-classes)
4. [Creating a New Plugin Project](#creating-a-new-plugin-project)
5. [Implementing Your Plugin](#implementing-your-plugin)
   - [1. Define Capabilities (Including Permissions)](#1-define-capabilities-including-permissions)
   - [2. Initialization](#2-initialization)
   - [3. Protocol Handlers (`setupProtocols` + `handleProtocol`)](#3-protocol-handlers-setupprotocols--handleprotocol)
   - [4. Optional Hooks](#4-optional-hooks)
   - [5. HTTP Endpoints (If Applicable)](#5-http-endpoints-if-applicable)
6. [Registering & Running Your Plugin](#registering--running-your-plugin)
7. [Testing & Debugging](#testing--debugging)
8. [Plugin Publishing & Versioning](#plugin-publishing--versioning)
9. [Example: A “Video Discovery” Plugin](#example-a-video-discovery-plugin)
10. [Best Practices & Tips](#best-practices--tips)

---

## Prerequisites

To develop a Vinyl Peer plugin, ensure you have the following:

- **Basic familiarity** with **Node.js** and **TypeScript**
- **Understanding** of **npm** (or Yarn) workspaces
- A working **Vinyl Peer monorepo checkout** (or installed from npm)
- **Installed dependencies**:

  ```bash
  npm install
  # or
  yarn install
  ```

- _(Optional)_ Familiarity with **libp2p** (for custom protocols) and **Express** (for HTTP endpoints)

---

## Plugin Architecture Overview

The Vinyl Peer framework, centered around the `vinyl-peer-protocol` package, provides a robust plugin system with the following components:

- **`PluginContext`**: An object providing access to:

  - `nodeId: string` – Your node’s PeerID
  - `libp2p: any` – The underlying libp2p instance for custom protocols
  - `files: Map<string, FileInfo>` – Local file metadata
  - `peers: Map<string, PeerInfo>` – Known peers in the network
  - `networkFiles: Map<string, NetworkFileInfo>` – Discovered remote files
  - `emit(event: string, envelope: { source: string; payload: any })` – Broadcast custom events with a required envelope
  - `pinFile(cid: string): Promise<void>` – Pin an IPFS CID locally
  - `unpinFile(cid: string): Promise<void>` – Unpin a CID
  - `getPermissions(): PluginPermissions` – Retrieve the plugin’s granted permissions

- **`PluginManager`**: Manages plugins by:

  1. Calling `initialize(context)` to set up each plugin and verify permissions
  2. Registering custom libp2p protocols (if `useNetwork: true`)
  3. Storing plugins in a registry and dispatching events (e.g., `onPeerConnected`, `onFileUploaded`)
  4. Invoking `start()` after `libp2p.start()` for safe protocol setup
  5. Forwarding `searchFiles` and `getRecommendations` calls to applicable plugins

- **`BasePlugin`**: An abstract class implementing `VinylPeerPlugin`, offering:

  - Default `initialize(context)` to store context, verify permissions, and set `isInitialized = true`
  - Default `start()` to enforce initialization, call `setupProtocols()`, and set `isStarted = true`
  - Default `stop()` to reset `isStarted = false`
  - Protected `emit(event: string, payload: any)` helper to wrap payloads in an envelope and emit via `context.emit`

- **HTTP Server**: Now integrated directly into the core `Vinyl` class, it:
  1. Initializes an Express app with global middleware (CORS, Helmet, rate limiting)
  2. Mounts each plugin’s router under its specified namespace (e.g., `/api/video`)
  3. Listens on a configurable port (default: `3001`) via the `startHttp` method

> **Key Update**: Plugins no longer manage their own HTTP servers. Instead, they provide a namespace and a router, which the core `Vinyl` class mounts automatically. The `exposeHttp` permission controls whether a plugin is allowed to expose HTTP endpoints.

---

## Key Interfaces & Base Classes

Below are the latest TypeScript definitions for Vinyl Peer plugin development, updated to reflect the current architecture.

### 1. `PluginContext`

```ts
export interface PluginContext {
  nodeId: string;
  libp2p: any;
  files: Map<string, FileInfo>;
  peers: Map<string, PeerInfo>;
  networkFiles: Map<string, NetworkFileInfo>;

  /**
   * Emit custom events with an envelope containing source and payload.
   * Validated by Vinyl Peer before broadcasting.
   */
  emit: (event: string, envelope: { source: string; payload: any }) => void;

  pinFile: (cid: string) => Promise<void>;
  unpinFile: (cid: string) => Promise<void>;
  getPermissions: () => PluginPermissions;
}
```

> **Key Updates**:
>
> - `emit` now requires an `{ source, payload }` envelope.
> - `getPermissions` provides runtime access to granted permissions.

### 2. `PluginCapabilities`

```ts
export interface PluginCapabilities {
  name: string; // Unique plugin name (e.g., "vinyl-peer-video-plugin")
  version: string; // Semantic version (e.g., "1.0.0")
  protocols: string[]; // libp2p protocols (e.g., ["/video-metadata/1.0.0"])
  capabilities: string[]; // Functional tags (e.g., ["metadata", "search"])
  fileTypes?: string[]; // MIME-type prefixes (e.g., ["video/*"])
  permissions: PluginPermissions; // Requested permissions
}
```

### 3. `PluginPermissions`

```ts
export interface PluginPermissions {
  accessFiles: boolean; // Access `context.files`
  useNetwork: boolean; // Use libp2p protocols
  modifyPeers: boolean; // Modify peer metadata
  exposeHttp: boolean; // Expose HTTP endpoints
}
```

> **Example**:
>
> ```ts
> permissions: {
>   accessFiles: true,
>   useNetwork: true,
>   modifyPeers: false,
>   exposeHttp: true
> }
> ```

### 4. `VinylPeerPlugin`

```ts
export interface VinylPeerPlugin {
  // Required Methods
  getCapabilities(): PluginCapabilities;
  initialize(context: PluginContext): Promise<boolean>;
  start(): Promise<void>;
  stop(): Promise<void>;
  setupProtocols(): void;
  handleProtocol(protocol: string, stream: any, peerId: string): Promise<void>;

  // Optional Hooks
  canHandleFile?(file: FileInfo): boolean;
  enhanceMetadata?(file: UploadFile): Promise<any>;
  onFileUploaded?(cid: string, fileInfo: FileInfo): void;
  onFileDownloaded?(cid: string): void;
  onPeerConnected?(peerId: string, peer: PeerInfo): void;
  onPeerDisconnected?(peerId: string, peer: PeerInfo): void;
  searchFiles?(query: any): Promise<NetworkFileInfo[]>;
  getRecommendations?(basedOnCid: string): Promise<NetworkFileInfo[]>;
  identifyPeer?(peerId: string): Promise<boolean>;

  // HTTP Hooks
  getHttpNamespace?(): string;
  getHttpRouter?(): Express | Router;
}
```

### 5. `BasePlugin`

```ts
export abstract class BasePlugin implements VinylPeerPlugin {
  protected context: PluginContext | null = null;
  protected isInitialized: boolean = false;
  protected isStarted: boolean = false;

  abstract getCapabilities(): PluginCapabilities;

  async initialize(context: PluginContext): Promise<boolean> {
    this.context = context;
    this.isInitialized = true;

    const requested = this.getCapabilities().permissions;
    const granted = context.getPermissions();
    for (const perm of Object.keys(requested) as (keyof PluginPermissions)[]) {
      if (requested[perm] && !granted[perm]) {
        console.error(`Plugin "${this.getCapabilities().name}" lacks permission: ${perm}`);
        return false;
      }
    }
    return true;
  }

  async start(): Promise<void> {
    if (!this.isInitialized) throw new Error("Plugin not initialized");
    this.setupProtocols();
    this.isStarted = true;
  }

  async stop(): Promise<void> {
    this.isStarted = false;
  }

  abstract setupProtocols(): void;
  abstract handleProtocol(protocol: string, stream: any, peerId: string): Promise<void>;

  protected emit(event: string, payload: any): void {
    if (!this.context) return;
    const pluginName = this.getCapabilities().name;
    this.context.emit(event, { source: pluginName, payload });
  }
}
```

> **Note**: If a requested permission is not granted, `initialize` returns `false`, preventing plugin registration.

---

## Creating a New Plugin Project

1. **Navigate** to the monorepo root (or your plugin workspace).
2. **Create a folder** under `packages/` (e.g., `vinyl-peer-video-plugin`).
3. **Initialize a `package.json`**:

   ```json
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

4. **Create a `tsconfig.json`** targeting ES2020, `module: esnext`, with output to `dist/`.
5. **Install dependencies** from the monorepo root:

   ```bash
   npm install
   # or
   yarn install
   ```

6. **Add a source file**, e.g., `src/VideoPlugin.ts`.

**Directory Structure**:

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

This section demonstrates implementing a “VideoPlugin” that:

- Uses a libp2p protocol (`/video-metadata/1.0.0`)
- Enhances file uploads with video metadata
- Supports search and recommendations
- Exposes HTTP endpoints under `/api/video` for metadata and search

### 1. Define Capabilities (Including Permissions)

In `VideoPlugin.ts`, declare the plugin’s capabilities and permissions:

```ts
import {
  BasePlugin,
  PluginCapabilities,
  PluginContext,
  VinylPeerPlugin,
} from "vinyl-peer-protocol";
import { FileInfo, UploadFile, NetworkFileInfo } from "vinyl-peer-protocol";
import express, { Request, Response, Router } from "express";

interface VideoMetadata {
  title?: string;
  resolution?: string;
  durationSeconds?: number;
}

export class VideoPlugin extends BasePlugin implements VinylPeerPlugin {
  private videoMetadataStore: Map<string, VideoMetadata> = new Map();

  getCapabilities(): PluginCapabilities {
    return {
      name: "vinyl-peer-video-plugin",
      version: "1.0.0",
      protocols: ["/video-metadata/1.0.0"],
      capabilities: ["metadata", "search", "video"],
      fileTypes: ["video/*"],
      permissions: {
        accessFiles: true,
        useNetwork: true,
        modifyPeers: false,
        exposeHttp: true, // Required to expose HTTP endpoints
      },
    };
  }

  // ... (continue with other methods)
}
```

> **Key**:
>
> - `permissions` must include `exposeHttp: true` to enable HTTP route exposure.

### 2. Initialization

Override `initialize` to store the context and verify permissions:

```ts
async initialize(context: PluginContext): Promise<boolean> {
  const ok = await super.initialize(context);
  if (!ok) return false;
  this.context = context;
  return true;
}
```

> **Note**: `super.initialize` handles permission verification and sets `isInitialized = true`.

### 3. Protocol Handlers (`setupProtocols` + `handleProtocol`)

- **`setupProtocols`**: Bind libp2p protocols if `useNetwork: true`.
- **`handleProtocol`**: Process incoming streams for registered protocols.

```ts
setupProtocols(): void {
  if (!this.context?.libp2p) return;
  this.context.libp2p.handle("/video-metadata/1.0.0", async ({ stream, connection }: any) => {
    await this.handleProtocol("/video-metadata/1.0.0", stream, connection.remotePeer.toString());
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
    const response = JSON.stringify({ type: "video-metadata-response", cid: req.cid, metadata: vidMd });
    await stream.sink([new TextEncoder().encode(response)]);
  }
}
```

### 4. Optional Hooks

Implement hooks to extend core behavior:

#### a) `canHandleFile(file: FileInfo): boolean`

```ts
canHandleFile(file: FileInfo): boolean {
  return file.type.startsWith("video/");
}
```

#### b) `enhanceMetadata(file: UploadFile): Promise<any>`

```ts
async enhanceMetadata(file: UploadFile): Promise<VideoMetadata> {
  return {
    title: file.name.replace(/\.[^/.]+$/, ""),
    resolution: "1920x1080",  // Placeholder
    durationSeconds: 120,
  };
}
```

#### c) `onFileUploaded(cid: string, fileInfo: FileInfo): void`

```ts
onFileUploaded(cid: string, fileInfo: FileInfo): void {
  if (this.canHandleFile(fileInfo) && file 示例Info.metadata) {
    this.videoMetadataStore.set(cid, fileInfo.metadata as VideoMetadata);
    this.emit("videoFileIndexed", { cid, metadata: fileInfo.metadata });
  }
}
```

### 5. HTTP Endpoints (If Applicable)

If `exposeHttp: true`, implement `getHttpNamespace` and `getHttpRouter` to define your plugin’s HTTP routes:

```ts
getHttpNamespace(): string {
  return "/api/video";
}

getHttpRouter(): Router {
  const router = express.Router();

  router.get("/metadata/:cid", (req: Request, res: Response) => {
    const { cid } = req.params;
    const md = this.videoMetadataStore.get(cid) || null;
    if (!md) return res.status(404).json({ error: `No metadata for CID ${cid}` });
    return res.json(md);
  });

  router.get("/search", async (req: Request, res: Response) => {
    const query = req.query;
    const results = await this.searchFiles(query);
    return res.json({ results });
  });

  return router;
}
```

> **Key Update**: The core `Vinyl` class mounts your router under the specified namespace (e.g., `/api/video`), applying global middleware like CORS and rate limiting. You no longer need to manage your own HTTP server.

---

## Registering & Running Your Plugin

1. **Build your plugin**:

   ```bash
   cd packages/vinyl-peer-video-plugin
   npm run build
   ```

2. **Register the plugin** in your node launcher (e.g., `run-vinyl.ts`):

   ```ts
   import { Vinyl } from "vinyl-peer-protocol";
   import { VideoPlugin } from "vinyl-peer-video-plugin";

   const vinyl = new Vinyl([new VideoPlugin()]);
   await vinyl.initialize();
   await vinyl.startHttp(3001); // Start the HTTP server with core and plugin routes
   ```

3. **Access plugin routes**: Once the server is running, plugin routes are available under their namespace (e.g., `http://localhost:3001/api/video/metadata/<cid>`).

---

## Testing & Debugging

- **Unit Tests**: Use Jest or Mocha to test plugin methods in isolation, mocking `PluginContext`.
- **Console Logging**: Add logs in `initialize`, `setupProtocols`, and hooks to verify execution.
- **HTTP Testing**: Use tools like `curl` or Postman to test plugin routes (e.g., `/api/video/search`).
- **Protocol Testing**: Manually dial protocols in a separate script to simulate peer interactions.

---

## Plugin Publishing & Versioning

1. **Bump version** in `package.json` (e.g., `"version": "1.1.0"`).
2. **Tag and push**:

   ```bash
   git tag v1.1.0
   git push --tags
   ```

3. **Publish to npm**:

   ```bash
   cd packages/vinyl-peer-video-plugin
   npm publish --access public
   ```

---

## Example: A “Video Discovery” Plugin

Below is a simplified version of `VideoPlugin.ts`:

```ts
import {
  BasePlugin,
  PluginCapabilities,
  PluginContext,
  VinylPeerPlugin,
} from "vinyl-peer-protocol";
import express, { Router } from "express";

export class VideoPlugin extends BasePlugin implements VinylPeerPlugin {
  getCapabilities(): PluginCapabilities {
    return {
      name: "vinyl-peer-video-plugin",
      version: "1.0.0",
      protocols: ["/video-metadata/1.0.0"],
      capabilities: ["metadata", "search"],
      permissions: { accessFiles: true, useNetwork: true, modifyPeers: false, exposeHttp: true },
    };
  }

  setupProtocols(): void {
    this.context!.libp2p.handle("/video-metadata/1.0.0", this.handleProtocol.bind(this));
  }

  async handleProtocol(protocol: string, stream: any, peerId: string): Promise<void> {
    // Protocol handling logic
  }

  getHttpNamespace(): string {
    return "/api/video";
  }

  getHttpRouter(): Router {
    const router = express.Router();
    router.get("/metadata", (req, res) => res.json({ message: "Video metadata" }));
    return router;
  }
}
```

---

## Best Practices & Tips

1. **Permissions**: Ensure `exposeHttp: true` if your plugin needs HTTP endpoints.
2. **Namespace Uniqueness**: Choose a unique `getHttpNamespace` to avoid conflicts (e.g., `/api/video`).
3. **Minimize HTTP Overhead**: Leverage core middleware; only add custom middleware if necessary.
4. **Event Emission**: Use `this.emit("event", payload)` to notify other plugins or the node.
5. **Graceful Shutdown**: Implement `stop()` to clean up resources like intervals or database connections.
