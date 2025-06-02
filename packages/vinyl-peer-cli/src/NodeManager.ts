import { Vinyl, NodeStats, PeerInfo, StorageMode, NetworkFileInfo } from "vinyl-peer-protocol";
import * as fs from "fs";
import * as path from "path";
import { NodeFile } from "./Node.js"; // <-- Use NodeFile instead of browser File

export class NodeManager {
  private nodeService: Vinyl;
  private isRunning: boolean = false;

  /**
   * Now we expect a Vinyl instance to be passed in.
   */
  constructor(vinylInstance: Vinyl) {
    this.nodeService = vinylInstance;
  }

  async start(enableLocalStorage: boolean = true): Promise<void> {
    if (this.isRunning) {
      throw new Error("Node is already running");
    }

    const success = await this.nodeService.initialize(enableLocalStorage);
    if (!success) {
      throw new Error("Failed to initialize node");
    }

    this.isRunning = true;
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    await this.nodeService.stop();
    this.isRunning = false;
  }

  getNodeId(): string {
    return this.nodeService.getNodeStats().id;
  }

  getStats(): NodeStats {
    return this.nodeService.getNodeStats();
  }

  getPeers(): PeerInfo[] {
    return this.nodeService.getPeers();
  }

  async uploadFile(filePath: string, storageMode: StorageMode = "ipfs"): Promise<string> {
    if (!this.isRunning) {
      throw new Error("Node is not running. Start the node first with: npm run cli start");
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    // Wrap raw Buffer into our NodeFile abstraction:
    const mimeType = this.getMimeType(fileName);
    const nodeFile = new NodeFile(fileBuffer, fileName, mimeType);

    return await this.nodeService.uploadFile(nodeFile, storageMode);
  }

  async downloadFile(cid: string, outputPath: string): Promise<void> {
    if (!this.isRunning) {
      throw new Error("Node is not running. Start the node first with: npm run cli start");
    }

    const data = await this.nodeService.downloadFile(cid);
    if (!data) {
      throw new Error("Failed to download file");
    }

    fs.writeFileSync(outputPath, data);
  }

  async searchFiles(query: string): Promise<NetworkFileInfo[]> {
    if (!this.isRunning) {
      throw new Error("Node is not running. Start the node first with: npm run cli start");
    }

    return await this.nodeService.searchFiles(query);
  }

  async pinFile(cid: string): Promise<void> {
    if (!this.isRunning) {
      throw new Error("Node is not running. Start the node first with: npm run cli start");
    }

    await this.nodeService.pinFile(cid);
  }

  async unpinFile(cid: string): Promise<void> {
    if (!this.isRunning) {
      throw new Error("Node is not running. Start the node first with: npm run cli start");
    }

    await this.nodeService.unpinFile(cid);
  }

  private getMimeType(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase();
    const mimeTypes: { [key: string]: string } = {
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".flac": "audio/flac",
      ".ogg": "audio/ogg",
      ".m4a": "audio/mp4",
      ".txt": "text/plain",
      ".json": "application/json",
      ".pdf": "application/pdf",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
    };
    return mimeTypes[ext] || "application/octet-stream";
  }

  isNodeRunning(): boolean {
    return this.isRunning;
  }
}
