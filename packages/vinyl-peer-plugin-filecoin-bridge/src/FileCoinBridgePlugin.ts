import {
  BasePlugin,
  PluginCapabilities,
  PluginContext,
  VinylPeerPlugin,
} from "vinyl-peer-protocol";
import { Web3Storage } from "web3.storage";
import { CarWriter } from "@ipld/car";
import { CID } from "multiformats/cid";
import { retry } from "ts-retry-promise";
import { FileInfo } from "vinyl-peer-protocol";
import { Buffer } from "buffer";
import { unixfs } from "@helia/unixfs";

/**
 * FilecoinBridgePlugin:
 *  1) Listens for “archiveRequested” (metadata CID) events.
 *  2) Uses UnixFS (fs = unixfs(this.context.helia)) to fetch metadata JSON.
 *  3) Parses out `storedCID` (the encrypted‐payload CID).
 *  4) Uses UnixFS again to stream the encrypted payload block.
 *  5) Wraps that block in a CAR and uploads to Web3.Storage.
 *  6) Updates LevelDB’s FileInfo.metadata with filecoinRoot + archivedAt.
 */
export class FilecoinBridgePlugin extends BasePlugin implements VinylPeerPlugin {
  protected context!: PluginContext;
  private client: Web3Storage;
  private defaultRetries = 3;
  private retryDelay = 2000; // ms

  constructor(token: string) {
    super();
    this.client = new Web3Storage({ token });
  }

  getCapabilities(): PluginCapabilities {
    return {
      name: "vinyl-peer-plugin-filecoin-bridge",
      version: "0.1.0",
      protocols: [], // No custom libp2p protocols
      capabilities: ["storage"],
      permissions: {
        accessFiles: true, // read/write to fileDb
        useNetwork: true, // dialing Helia/IPFS is allowed
        modifyPeers: false,
        exposeHttp: false,
      },
    };
  }

  async initialize(context: PluginContext): Promise<boolean> {
    const ok = await super.initialize(context);
    if (!ok) return false;
    this.context = context;

    // Subscribe to "archiveRequested". Expect `payload = { cid: string }`.
    this.context.onEvent((event, envelope) => {
      if (event === "archiveRequested") {
        const { cid } = envelope.payload as { cid: string };
        this.archiveToFilecoin(cid).catch((err) => {
          console.error(`[FilecoinBridge] archiveToFilecoin failed for ${cid}:`, err);
        });
      }
    });

    return true;
  }

  async start(): Promise<void> {
    // No startup logic needed
  }

  async stop(): Promise<void> {
    await super.stop();
  }

  setupProtocols(): void {
    // No libp2p protocols
  }

  async handleProtocol(_protocol: string, _stream: any, _peerId: string): Promise<void> {
    // Not used
  }

  private async archiveToFilecoin(metadataCid: string): Promise<void> {
    try {
      // Instantiate UnixFS against the Helia instance
      const fs = unixfs(this.context.helia);

      // ── Step 1: Fetch the metadata JSON from IPFS/Helia ──
      //
      //   The “metadata CID” points to a JSON blob that looks like:
      //     {
      //       name: string,
      //       size: number,
      //       type: string,
      //       uploadDate: ISOString,
      //       storageMode: "ipfs" | "p2p-stream",
      //       storedCID: "<cid-of-encrypted-bytes>",
      //       metadata: { … }
      //     }
      //
      const metaChunks: Uint8Array[] = [];
      const metadataCidObj = CID.parse(metadataCid);
      for await (const chunk of fs.cat(metadataCidObj)) {
        metaChunks.push(chunk);
      }
      const metaBuf = Buffer.concat(metaChunks.map((u) => Buffer.from(u)));
      const metaJson = metaBuf.toString("utf-8");

      let parsedMeta: any;
      try {
        parsedMeta = JSON.parse(metaJson);
      } catch (e) {
        console.error(`[FilecoinBridge] invalid JSON for metadataCID ${metadataCid}`, e);
        return;
      }

      const storedCID: string | undefined = parsedMeta.storedCID;
      if (!storedCID) {
        console.warn(`[FilecoinBridge] metadata JSON for ${metadataCid} lacks "storedCID"`);
        return;
      }

      // ── Step 2: Ensure storageMode is "ipfs" (otherwise, cannot archive p2p streams) ──
      if (parsedMeta.storageMode !== "ipfs") {
        console.warn(
          `[FilecoinBridge] cannot archive metadataCid ${metadataCid} because storageMode="${parsedMeta.storageMode}"`,
        );
        return;
      }

      // ── Step 3: Stream the encrypted payload bytes from IPFS/Helia ──
      const encryptedChunks: Uint8Array[] = [];
      const storedCidObj = CID.parse(storedCID);
      for await (const chunk of fs.cat(storedCidObj)) {
        encryptedChunks.push(chunk);
      }
      const encryptedBuffer = Buffer.concat(encryptedChunks.map((u) => Buffer.from(u)));

      // ── Step 4: Wrap that encrypted block into a CAR and upload to Web3.Storage ──
      const uploadCid = await retry(
        async () => {
          // Create a CAR writer containing exactly one block whose CID is `storedCID`,
          // and whose bytes are the encryptedBuffer.
          const blockCid = CID.parse(storedCID);
          const { writer, out } = await CarWriter.create([blockCid]);
          await writer.put({ cid: blockCid, bytes: encryptedBuffer });
          writer.close();

          // Collect all CAR chunks into one Buffer
          const carChunks: Uint8Array[] = [];
          for await (const c of out) {
            carChunks.push(c);
          }
          const fullCarBuf = Buffer.concat(carChunks.map((u) => Buffer.from(u)));

          // Convert that Buffer into a Blob, then into a File
          const carBlob = new Blob([fullCarBuf], { type: "application/car" });
          const carFile = new File([carBlob], `${metadataCid}.car`, { type: "application/car" });

          // Upload that single‐File CAR to Web3.Storage
          const rootCid = await this.client.put([carFile], {
            wrapWithDirectory: false,
          });
          console.log(`[FilecoinBridge] Archived ${storedCID} → Filecoin/IPFS CID ${rootCid}`);

          // ── Step 5: Annotate LevelDB’s FileInfo.metadata ──
          const existing: FileInfo | undefined = await this.context.fileDb
            .get(metadataCid)
            .catch(() => undefined);
          if (existing) {
            if (typeof existing.metadata !== "object" || existing.metadata === null) {
              existing.metadata = {};
            }
            existing.metadata.filecoinRoot = rootCid;
            existing.metadata.archivedAt = new Date().toISOString();
            await this.context.fileDb.put(metadataCid, existing);
          } else {
            console.warn(
              `[FilecoinBridge] no FileInfo found for metadataCid ${metadataCid}, skipping metadata update`,
            );
          }

          return rootCid;
        },
        {
          retries: this.defaultRetries,
          delay: this.retryDelay,
          backoff: "EXPONENTIAL",
        },
      ).catch((err) => {
        console.error(`[FilecoinBridge] final failure after retries for ${metadataCid}:`, err);
        return null;
      });

      if (!uploadCid) {
        console.error(`[FilecoinBridge] failed to archive ${metadataCid} after retries`);
      }
    } catch (err) {
      console.error(`[FilecoinBridge] unexpected error in archiveToFilecoin:`, err);
    }
  }
}
