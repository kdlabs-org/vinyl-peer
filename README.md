# Vinyl Peer Monorepo

**Vinyl Peer** is a modular, peer-to-peer (P2P) media-sharing network built with TypeScript. It leverages **libp2p** for decentralized networking and optionally integrates **Helia/IPFS** for local storage and content addressing. This monorepo houses a collection of packages that work together to provide a robust, extensible platform for sharing, discovering, and managing media files in a decentralized environment.

The monorepo includes the following packages:

- **`vinyl-peer-protocol`** - Core P2P framework and plugin host.
- **`vinyl-peer-plugin-music`** - Music-specific functionality (metadata, search, recommendations).
- **`vinyl-peer-plugin-analytics`** - Analytics for nodes and files.
- **`vinyl-peer-plugin-replication`** - Automatic file replication (auto-pinning).
- **`vinyl-peer-plugin-sdk-generator`** - SDK generation for interacting with Vinyl nodes.
- **`vinyl-peer-plugin-v`** - V (peer to peer) Microblogging like X .
- **`vinyl-peer-plugin-rs`** - Reed-Solomon encoding for resilient file storage.
- **`vinyl-peer-cli`** - Command-line interface (CLI) and Express-based web server.

---

# Why Vinyl Peer?

**Vinyl Peer** is more than “just IPFS + libp2p.” It’s an end-to-end framework designed to take the boilerplate and complexity out of building a decentralized media-sharing application. Here’s what Vinyl Peer gives you, and why you might choose it over a raw IPFS or libp2p setup.

---

## 1. All-in-One, Batteries-Included Framework

### 1.1. Unified Networking & Storage

- **libp2p for P2P Transport**
  Vinyl Peer uses libp2p under the hood for peer discovery, connection multiplexing, NAT traversal, and pubsub. You get a battle-tested networking stack without wiring it up yourself.

- **Helia (In-Process IPFS) for Content Addressing**
  Instead of spawning a separate go-ipfs daemon or managing an external IPFS HTTP client, Vinyl Peer embeds an IPFS node (via Helia) directly in your application. That means:

  - One process, one libp2p instance, one configuration.
  - Synchronous, in-memory `helia.fs.add()` / `helia.fs.cat()` calls—no HTTP RPC round-trips.
  - Pinning, blockstore, and CID management all live in the same runtime.

### 1.2. Opinionated File Management

When you build on plain IPFS, you decide where and how to store metadata, how to handle uploads/downloads, and how to track pins. Vinyl Peer comes with:

- **Automatic AES-GCM Encryption**
  Every file upload is encrypted client-side with a rotating key. Each blob on IPFS begins with a 1-byte key version + 12-byte IV + ciphertext. You never need to sprinkle your own `crypto.subtle.encrypt()` calls throughout your code.

- **Daily Key Rotation & Key Versioning**
  Vinyl Peer rotates its AES-GCM key every 24 hours and retains the last three key versions in memory. That way, any file encrypted within the past three days is still decryptable—no manual key vault needed.

- **HMAC-Signed Audit Log**
  Every action that matters—“nodeStarted,” “keyRotation,” “fileUploaded,” “pluginRegistered,” “filePinned”—is appended to `vinyl-audit.log` as a JSON line signed with HMAC-SHA256. This gives you a tamper-evident history of everything your node has done.

- **LevelDB Index of FileInfo**
  Vinyl Peer maintains a local LevelDB (`fileDb`) mapping each metadata-CID → a `FileInfo` record:

  ```ts
  interface FileInfo {
    cid: string; // the metadata's IPFS/Helia CID
    name: string; // original filename
    size: number; // byte length
    type: string; // MIME type
    uploadDate: Date;
    encrypted: boolean;
    storageMode: "ipfs" | "p2p-stream";
    streamId?: string; // if streaming mode
    pinned: boolean;
    shareLink: string; // vinyl://ipfs/<cid> or vinyl://stream/<id>
    metadata?: any; // plugin-enhanced fields
  }
  ```

  With that index, you get:

  - **Fast lookups** for downloads and metadata queries.
  - **Searchable file names** via `/api/search?q=…`.
  - **Pin/unpin state** tracked alongside file info.

---

## 2. Plugin-Based Extensibility

Vinyl Peer’s true power lies in its **modular plugin system**. Out of the box, you get core file operations and a handful of HTTP endpoints. Anything beyond that—music discovery, analytics, replication, microblogging, Reed-Solomon encoding—is a plugin. Here’s why that matters:

### 2.1. Standardized Plugin Context

Every plugin gets a `PluginContext` with:

```ts
interface PluginContext {
  nodeId: string; // libp2p peer ID
  libp2p: Libp2p; // the libp2p instance
  files: Map<string, FileInfo>; // an async-iterator-backed view of fileDb
  peers: Map<string, PeerInfo>; // in-memory peer list
  networkFiles: Map<string, NetworkFileInfo>;
  emit: (event: string, envelope: { source: string; payload: any }) => void;
  pinFile: (cid: string) => Promise<void>;
  unpinFile: (cid: string) => Promise<void>;
  getPermissions: () => PluginPermissions;
}
```

Plugins can:

- **Listen** for events (`onPeerConnected`, `onFileUploaded`, etc.)
- **Enhance metadata** on upload (`enhanceMetadata`)
- **Define custom libp2p protocols** (`protocols: ["/music-discovery/1.0.0", …]`), automatically bound with size limits and optional peer authentication
- **Expose HTTP routes** under a namespace (`/api/music`, `/api/rs`, `/api/analytics`, etc.)

### 2.2. No Reinventing the Wheel

Without Vinyl Peer, each new feature would require:

- Wiring your own event emitter or callback system.
- Manually binding custom protocols in libp2p (with your own error handling and size limits).
- Mounting Express routers and applying CORS, Helmet, and rate limiting every time.
- Handling plugin-permission checks on each file or network operation.

Vinyl Peer centralizes all that. You simply implement `getCapabilities()`, `initialize()`, `start()`, `handleProtocol()`, and (optionally) `getHttpNamespace()` + `getHttpRouter()`. The rest is boilerplate that Vinyl Peer handles for you.

---

## 3. Unified HTTP API

When you run the Vinyl Peer CLI, you get one Express server that serves:

1. **Core Routes**

   - `GET /api/status` — Node health, peer counts, etc.
   - `GET /api/peers` — Snapshot of connected peers.
   - `GET /api/files` — List all local `FileInfo`.
   - `POST /api/upload` — Upload + encrypt + store + index.
   - `GET /api/download/:cid` — Fetch + decrypt + stream.
   - `GET /api/search?q=…` — Search on filename (and plugin results).
   - `POST /api/pin/:cid` — Pin in Helia/IPFS.
   - `DELETE /api/pin/:cid` — Unpin.
   - `GET /api/events` — SSE feed of recent node events.

2. **Plugin Routes**

   - `/api/music` (Music Plugin)
   - `/api/analytics` (Analytics Plugin)
   - `/api/replication` (Replication Plugin)
   - `/api/v` (Microblogging Plugin)
   - `/api/rs` (Reed-Solomon Plugin)
   - …and any others you install.

Because everything lives on the same Express app:

- **One port** (`3001` by default) and one CORS/Helmet/rate-limit configuration.
- **No need** to track multiple servers or route prefixes manually.
- **Consistent error handling** across core + plugins.

---

## 4. Audit Logging & Real-Time Event Streaming

Vinyl Peer provides two complementary ways to track node activity:

1. **HMAC-Signed Audit Log (`vinyl-audit.log`)**
   Every critical action is logged as a signed JSON line, e.g.:

   ```jsonc
   {
     "timestamp": "2023-08-21T14:23:01.123Z",
     "event": "fileUploaded",
     "plugin": "core",
     "details": { "cid": "QmXYZ…" },
     "signature": "a1b2c3…",
   }
   ```

   If you ever need to prove “which AES key version encrypted file X” or “when plugin Y registered,” you simply inspect this log.

2. **SSE Endpoint (`GET /api/events`)**

   - **Replays** the last 20 events (from an in-memory circular buffer).
   - **Pushes** new events live over Server-Sent Events (SSE), so a web UI or monitoring service can subscribe in real time:

     ```
     event: fileUploaded
     data: {"cid":"QmXYZ…","metadata":{…}}
     ```

   This built-in feed means you don’t have to add another WebSocket or polling mechanism—Vinyl Peer gives you a turnkey solution.

---

## 5. When to Choose Vinyl Peer vs. Raw IPFS/Helia/Libp2p

### 5.1. Choose Vinyl Peer If You Need…

- **Seamless AES-GCM encryption** on every upload, with rotating keys and built-in decryption.
- **Automatic audit logging** of node and plugin events, with HMAC signatures.
- **A plugin ecosystem** where you can drop in a Music Plugin, Analytics Plugin, Reed-Solomon Plugin, etc., with minimal boilerplate.
- **One HTTP API** that unifies core file operations and plugin routes—no juggling multiple servers or prefixes.
- **In-process IPFS** (Helia) that shares the same libp2p instance as your node, avoiding external daemons or RPC calls.
- **Built-in SSE** for streaming node events to a UI or monitoring tool.

### 5.2. Choose Raw IPFS/Helia/Libp2p If You…

- Only need **basic “put/get”** functionality without encryption or metadata indexing.
- Prefer to **craft your own** encryption/key-management system, your own metadata store, and your own protocol definitions.
- Don’t require a **modular plugin** architecture or a unified audit log.
- Want absolute control over your dependency graph, build process, and on-disk schema from scratch.
- Are building a very lightweight proof-of-concept where you only need a single IPFS-powered file upload endpoint.

---

## 6. A Real “Vinyl” Protocol

While Vinyl Peer reuses libp2p’s transport and Helia’s blockstore, it layers on a coherent, end-to-end application protocol:

1. **Wire-Level Conventions**

   - Every plugin uses protocol strings like `"/vinyl-network/1.0.0"`, `"/music-discovery/1.0.0"`, `"/analysis/1.0.0"`, `"/rs-shard/1.0.0"`.
   - Every encrypted payload is prefixed by `[keyVersion (1 byte) | IV (12 bytes) | ciphertext …]`. Any Vinyl Peer node can decrypt it if it holds that key version.

2. **On-Disk & In-Memory Schema**

   - **LevelDB** for `FileInfo` (mapping metadata CID → file metadata).
   - **In-Memory Maps** for connected peers, streamed shards, and network-advertised files.
   - **HMAC Audit Log** for tamper-evident event history.

3. **HTTP Conventions**

   - Core routes (`/api/status`, `/api/upload`, `/api/download/:cid`, `/api/search`, `/api/pin/:cid`).
   - Plugin routes mounted under `/api/<pluginNamespace>/*` (e.g. `/api/music/*`, `/api/analytics/*`, `/api/rs/*`).
   - SSE feed at `/api/events` that any client can subscribe to.

Any client or plugin that knows these conventions can interoperate with a Vinyl Peer node—upload, download, decrypt, pin, or subscribe to events. In this sense, **Vinyl Peer is a higher-level protocol** built on top of the generic libp2p transport stack, much like how HTTP is a protocol on top of TCP.

---

## 7. Conclusion

Vinyl Peer exists because building a full-featured P2P media-sharing app purely on IPFS or libp2p still requires months of wiring:

- AES-GCM encryption, key rotation, and HMAC auditing.
- Metadata indexing, LevelDB integration, and search.
- Unified HTTP server, CORS, Helmet, and rate limits.
- A clean plugin/event system to avoid monolithic code.
- Real-time SSE for monitoring node activity.

Vinyl Peer assembles all these pieces into a single, modular monorepo. You get:

- **Core Node** (libp2p + Helia)
- **File Operations** (encrypt, upload, index, download, pin)
- **Plugin Framework** (easy to add music, analytics, replication, RS, microblogging, etc.)
- **HTTP API** (core + plugin routes)
- **Audit & Events** (HMAC log + SSE)

By choosing Vinyl Peer, you focus on your application logic—your media app, your analytics dashboard, your resilient‐shard storage—rather than reinventing the foundational plumbing every time. If you need a production-ready, end-to-end P2P file-sharing stack, **Vinyl Peer is the far-faster, far-safer choice** over wiring up IPFS and libp2p from scratch.

---

## Table of Contents

1. [Overview](#overview)
2. [Use Cases](#use-cases)
3. [Design & Architecture](#design--architecture)
4. [Installation](#installation)
5. [Execution Commands](#execution-commands)
6. [Code Examples](#code-examples)
7. [Packages](#packages)
   - [vinyl-peer-protocol](#1-vinyl-peer-protocol-core)
   - [vinyl-peer-plugin-music](#2-vinyl-peer-plugin-music)
   - [vinyl-peer-plugin-analytics](#3-vinyl-peer-plugin-analytics)
   - [vinyl-peer-plugin-replication](#4-vinyl-peer-plugin-replication)
   - [vinyl-peer-plugin-sdk-generator](#5-vinyl-peer-plugin-sdk-generator)
   - [vinyl-peer-plugin-v](#6-vinyl-peer-plugin-v)
   - [vinyl-peer-plugin-rs](#7-vinyl-peer-plugin-rs)
   - [vinyl-peer-cli](#8-vinyl-peer-cli)
8. [Contributing](#contributing)
9. [Troubleshooting](#troubleshooting)
10. [License](#license)

---

## Overview

Vinyl Peer is designed to facilitate decentralized media sharing through a **plugin-based architecture**. At its heart, the `vinyl-peer-protocol` package provides a foundation that includes:

- A **libp2p** node for peer discovery, connection multiplexing, and NAT traversal.
- Optional **Helia/IPFS** integration for persistent local storage and content-addressed file management.
- A flexible plugin system that allows developers to extend functionality without altering the core.
- An HTTP server (via `vinyl-peer-cli`) for interacting with the node and its plugins through a web interface or API.

### Key Features

- **Decentralized Networking**: Connect peers without a central server using libp2p.
- **Extensibility**: Add new features via plugins that hook into the core system.
- **File Management**: Upload, download, pin, unpin, and search for files across the network.
- **HTTP Interface**: Access node functionality and plugin features via RESTful endpoints.

Plugins enhance the system by:

- Defining custom **libp2p protocols** for peer communication.
- Reacting to file events (e.g., uploads/downloads).
- Enriching file metadata (e.g., extracting ID3 tags for music files).
- Exposing custom HTTP endpoints under unique namespaces.
- Managing IPFS content identifiers (CIDs) for pinning and replication.

---

## Use Cases

Vinyl Peer supports a wide range of decentralized applications. Below are detailed use cases with examples:

1. **Decentralized Media Sharing**

   - **Description**: Share media files (e.g., music, videos) directly between peers.
   - **Example**: A user uploads a high-resolution music album, and peers download or stream it without relying on a central server.

2. **Music Discovery & Recommendations**

   - **Description**: Search and discover music based on metadata like artist, album, or genre.
   - **Example**: Query the network for "jazz albums from the 1960s" and receive recommendations from peers.

3. **Auto-Replication (Auto-Pinning)**

   - **Description**: Automatically replicate files to ensure availability across the network.
   - **Example**: A rare documentary is downloaded and pinned locally to keep it accessible even if the original uploader goes offline.

4. **Network Analytics**

   - **Description**: Monitor network health and file usage statistics.
   - **Example**: A node operator checks how many peers are active or which files are most popular.

5. **Microblogging**

   - **Description**: Share short posts or media updates in a decentralized social network.
   - **Example**: A musician posts a link to a new track, and followers see it in their timeline.

6. **Resilient File Storage**

   - **Description**: Use Reed-Solomon encoding to split files into recoverable shards.
   - **Example**: A video file is stored as shards across peers, allowing reconstruction even if some are lost.

7. **SDK Generation**
   - **Description**: Generate a TypeScript SDK for programmatic interaction with Vinyl nodes.
   - **Example**: A developer builds a custom web app to browse music using the generated SDK.

---

## Design & Architecture

### Modularity via Plugins

- **Purpose**: Keep the core lightweight while allowing unlimited extensibility.
- **Implementation**:
  - The `vinyl-peer-protocol` package provides a `PluginContext` with access to libp2p, file metadata, pinning APIs, and an event bus.
  - Plugins implement the `VinylPeerPlugin` interface, specifying their capabilities, libp2p protocols, and required permissions.
  - The `vinyl-peer-cli` package mounts plugin-specific HTTP routes under unique namespaces (e.g., `/api/music` for the Music Plugin).

### Core Components (`vinyl-peer-protocol`)

- **libp2p Node**: Handles peer discovery, connection management, and protocol multiplexing.
- **Helia/IPFS (Optional)**: Provides content-addressed storage and retrieval.
- **File Operations**: Manages uploads, downloads, and metadata.
- **Plugin System**: Registers and coordinates plugins.

### PluginContext

- **Description**: A shared interface for plugins to interact with the node.
- **Capabilities**:
  - Access to the libp2p instance for custom protocol handling.
  - File metadata storage and retrieval.
  - Pinning/unpinning APIs for IPFS content.
  - Event bus for subscribing to and emitting events (e.g., file uploaded).

### HTTP Server

- **Hosted By**: `vinyl-peer-cli`.
- **Functionality**: Exposes core routes (e.g., `/upload`, `/search`) and plugin routes (e.g., `/api/analytics/stats`).

---

## Installation

Follow these steps to set up the Vinyl Peer Monorepo locally:

1. **Clone the Repository**

   ```bash
   git clone https://github.com/your-org/vinyl-peer-monorepo.git
   cd vinyl-peer-monorepo
   ```

2. **Install Dependencies**

   - Vinyl Peer uses `pnpm` as its package manager for efficient monorepo management.

   ```bash
   pnpm install
   ```

3. **Build All Packages**

   - Compile TypeScript code across all packages.

   ```bash
   pnpm run build
   ```

4. **Verify Installation**
   - Ensure the build completes without errors. If issues arise, see [Troubleshooting](#troubleshooting).

---

## Execution Commands

Run these commands from the monorepo root using `pnpm`. They interact with the `vinyl-peer-cli` package.

### General Commands

- **Start the Node**
  - Launches the Vinyl node and HTTP server.
  ```bash
  pnpm run start --workspace=vinyl-peer-cli
  ```

### File Management Commands

- **Upload a File**

  - Uploads a file to the network with an optional storage mode (`ipfs` or local).

  ```bash
  pnpm run cli -- upload <file-path> --storage-mode ipfs
  ```

- **Download a File**

  - Retrieves a file by its CID and saves it to a specified path.

  ```bash
  pnpm run cli -- download <cid> <output-path>
  ```

- **Search for Files**

  - Queries the network for files matching a search term.

  ```bash
  pnpm run cli -- search <query>
  ```

- **Pin a File**

  - Pins a file by CID to ensure local availability (requires IPFS mode).

  ```bash
  pnpm run cli -- pin <cid>
  ```

- **Unpin a File**
  - Removes a file from the local pin set.
  ```bash
  pnpm run cli -- unpin <cid>
  ```

### Plugin-Specific Commands

- **Analytics Stats**
  ```bash
  pnpm run cli -- analytics stats
  ```
- **Post a Microblog Update**
  ```bash
  pnpm run cli -- v post "Hello from Vinyl Peer!"
  ```

---

## Code Examples

Below are detailed examples demonstrating how to use Vinyl Peer programmatically.

### Uploading a File

```typescript
import { Vinyl } from "vinyl-peer-protocol";
import { NodeFile } from "vinyl-peer-cli";
import fs from "fs/promises";

// Initialize the Vinyl node with IPFS support
const vinyl = new Vinyl();
await vinyl.initialize(true); // true enables Helia/IPFS

// Read and prepare the file
const fileBuffer = await fs.readFile("path/to/song.mp3");
const nodeFile = new NodeFile(fileBuffer, "song.mp3", "audio/mpeg");

// Upload the file
const cid = await vinyl.uploadFile(nodeFile, "ipfs");
console.log(`File uploaded with CID: ${cid}`);
```

### Downloading a File

```typescript
import { Vinyl } from "vinyl-peer-protocol";
import fs from "fs/promises";

const vinyl = new Vinyl();
await vinyl.initialize(true);

const cid = "Qm..."; // Replace with actual CID
const data = await vinyl.downloadFile(cid);
if (data) {
  await fs.writeFile("downloaded-song.mp3", data);
  console.log("File downloaded successfully");
}
```

### Searching for Files

```typescript
import { Vinyl } from "vinyl-peer-protocol";

const vinyl = new Vinyl();
await vinyl.initialize(true);

const results = await vinyl.searchFiles("genre:jazz year:1960");
console.log("Search results:", results);
```

### Using the Generated SDK

```typescript
import { createSdkClient } from "generated-sdk/sdk";

const client = createSdkClient("http://localhost:3001");

// Search for music
const musicResults = await client.post("/api/music/search", { genre: "rock" });
console.log("Rock music results:", musicResults);

// Get analytics
const stats = await client.get("/api/analytics/stats");
console.log("Network stats:", stats);
```

### Posting a Microblog Update

```typescript
import { Vinyl } from "vinyl-peer-protocol";

const vinyl = new Vinyl();
await vinyl.initialize(true);

await vinyl.plugins["v"].post("Check out my new track!");
console.log("Microblog post created");
```

---

## Packages

### 1. `vinyl-peer-protocol` (Core)

- **Purpose**: Foundation of the Vinyl Peer system.
- **Features**:
  - Initializes and manages the libp2p node.
  - Optional Helia/IPFS integration for storage.
  - File upload, download, pinning, and search APIs.
  - Plugin registration and lifecycle management.
- **Dependencies**: `libp2p`, `@helia/ipfs`.

### 2. `vinyl-peer-plugin-music`

- **Purpose**: Enhances music file handling.
- **Features**:
  - Extracts ID3 tags (artist, album, genre).
  - Search by metadata fields.
  - Basic recommendation engine based on shared files.
- **HTTP Routes**: `/api/music/search`, `/api/music/recommend`.

### 3. `vinyl-peer-plugin-analytics`

- **Purpose**: Provides network and file insights.
- **Features**:
  - Tracks active peers, file downloads, and pinned CIDs.
  - Exposes statistics via HTTP.
- **HTTP Routes**: `/api/analytics/stats`.

### 4. `vinyl-peer-plugin-replication`

- **Purpose**: Ensures file availability.
- **Features**:
  - Auto-pins files on download (configurable).
  - Toggle replication via CLI or HTTP.
- **HTTP Routes**: `/api/replication/config`.

### 5. `vinyl-peer-plugin-sdk-generator`

- **Purpose**: Simplifies client development.
- **Features**:
  - Generates a TypeScript SDK based on core and plugin HTTP routes.
  - Outputs typed client methods (e.g., `client.post("/api/music/search")`).
- **Output**: `generated-sdk/sdk.ts`.

### 6. `vinyl-peer-plugin-v`

- **Purpose**: Adds decentralized microblogging.
- **Features**:
  - Post short messages or media links.
  - Follow peers and view timelines via libp2p PubSub.
- **HTTP Routes**: `/api/v/post`, `/api/v/timeline`.

### 7. `vinyl-peer-plugin-rs`

- **Purpose**: Enhances file resilience.
- **Features**:
  - Splits files into Reed-Solomon encoded shards.
  - Reconstructs files from partial shard sets.
- **HTTP Routes**: `/api/rs/shard`, `/api/rs/recover`.

### 8. `vinyl-peer-cli`

- **Purpose**: Provides user interaction tools.
- **Features**:
  - CLI for node management (upload, download, etc.).
  - Express-based HTTP server hosting core and plugin routes.
- **Default Port**: `3001`.

---

## Contributing

Contributions are welcome! To get started:

1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/my-feature`).
3. Commit changes (`git commit -m "Add my feature"`).
4. Push to your fork (`git push origin feature/my-feature`).
5. Open a pull request.

See [Contributing Guidelines](CONTRIBUTING.md) for more details.

---

## Troubleshooting

- **Build Fails**: Ensure `pnpm` is installed (`npm install -g pnpm`) and run `pnpm install` again.
- **Node Won’t Start**: Check for port conflicts (default: `3001`) and ensure dependencies are built (`pnpm run build`).
- **IPFS Issues**: Verify Helia/IPFS is enabled and properly configured in `vinyl-peer-protocol`.

---

## License

This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for details.
