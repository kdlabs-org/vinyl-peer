import { UploadFile } from "vinyl-peer-protocol";

/**
 * NodeFile: Adapts a Node.js Buffer into our UploadFile interface,
 * so that Vinyl.uploadFile(...) can accept it just like a browser File.
 */
export class NodeFile implements UploadFile {
  name: string;
  size: number;
  type: string;
  private buffer: Buffer;

  constructor(buffer: Buffer, name: string, type: string = "application/octet-stream") {
    this.buffer = buffer;
    this.name = name;
    this.type = type;
    this.size = buffer.length;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    // Copy the Buffer’s contents into a new ArrayBuffer:
    const ab = new ArrayBuffer(this.buffer.byteLength);
    const view = new Uint8Array(ab);
    view.set(this.buffer);
    return ab;
  }
}
