/**
 * Remote ZIP Central Directory Inspector (with ZIP64 >4GB Archive Support)
 * Fetches only the tail 64 KB of a remote archive to parse and display its internal file structure
 * without downloading the entire archive.
 */

import { ProtocolHandler } from "./protocol.mjs";

export class RemoteZipInspector {
  constructor() {
    this.protocol = new ProtocolHandler();
  }

  async inspectRemoteZip(url, fileSize) {
    if (!fileSize || fileSize < 22) {
      throw new Error("File is too small to be a valid ZIP archive");
    }

    const tailBytes = Math.min(fileSize, 65536);
    const startOffset = fileSize - tailBytes;
    const endOffset = fileSize - 1;

    const stream = await this.protocol.openRangeStream(url, startOffset, endOffset);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    let eocdOffset = -1;
    for (let i = buffer.length - 22; i >= 0; i--) {
      if (
        buffer[i] === 0x50 &&
        buffer[i + 1] === 0x4b &&
        buffer[i + 2] === 0x05 &&
        buffer[i + 3] === 0x06
      ) {
        eocdOffset = i;
        break;
      }
    }

    if (eocdOffset === -1) {
      throw new Error("End of Central Directory record (EOCD) not found in tail buffer");
    }

    let cdSize = buffer.readUInt32LE(eocdOffset + 12);
    let cdOffset = buffer.readUInt32LE(eocdOffset + 16);

    // ZIP64 EOCD Locator check (0x07064b50) for archives > 4 GB
    if ((cdOffset === 0xffffffff || cdSize === 0xffffffff) && eocdOffset >= 20) {
      const locOffset = eocdOffset - 20;
      if (
        buffer[locOffset] === 0x50 &&
        buffer[locOffset + 1] === 0x4b &&
        buffer[locOffset + 2] === 0x06 &&
        buffer[locOffset + 3] === 0x07
      ) {
        const zip64EocdPos = Number(buffer.readBigUInt64LE(locOffset + 8));
        if (zip64EocdPos >= startOffset) {
          const z64 = zip64EocdPos - startOffset;
          if (z64 + 56 <= buffer.length) {
            cdSize = Number(buffer.readBigUInt64LE(z64 + 40));
            cdOffset = Number(buffer.readBigUInt64LE(z64 + 48));
          }
        }
      }
    }

    let cdBuffer = null;
    if (cdOffset >= startOffset && cdOffset - startOffset + cdSize <= buffer.length) {
      const offsetInBuf = cdOffset - startOffset;
      cdBuffer = buffer.subarray(offsetInBuf, offsetInBuf + cdSize);
    } else {
      const fetchLen = Math.min(cdSize, 4 * 1024 * 1024);
      const cdStream = await this.protocol.openRangeStream(
        url,
        cdOffset,
        cdOffset + fetchLen - 1
      );
      const cdChunks = [];
      for await (const c of cdStream) {
        cdChunks.push(c);
      }
      cdBuffer = Buffer.concat(cdChunks);
    }

    const entries = [];
    let cursor = 0;

    while (cursor + 46 <= cdBuffer.length) {
      if (
        cdBuffer[cursor] !== 0x50 ||
        cdBuffer[cursor + 1] !== 0x4b ||
        cdBuffer[cursor + 2] !== 0x01 ||
        cdBuffer[cursor + 3] !== 0x02
      ) {
        break;
      }

      const compMethod = cdBuffer.readUInt16LE(cursor + 10);
      const crc32 = cdBuffer.readUInt32LE(cursor + 16);
      const compSize = cdBuffer.readUInt32LE(cursor + 20);
      const uncompSize = cdBuffer.readUInt32LE(cursor + 24);

      const fnameLen = cdBuffer.readUInt16LE(cursor + 28);
      const extraLen = cdBuffer.readUInt16LE(cursor + 30);
      const commentLen = cdBuffer.readUInt16LE(cursor + 32);

      const fnameStart = cursor + 46;
      const fnameEnd = fnameStart + fnameLen;

      if (fnameEnd > cdBuffer.length) break;

      const filename = cdBuffer.toString("utf8", fnameStart, fnameEnd);
      const isDirectory = filename.endsWith("/") || filename.endsWith("\\");

      entries.push({
        filename,
        uncompressedSize: uncompSize,
        compressedSize: compSize,
        compressionMethod: compMethod,
        crc32: crc32.toString(16),
        isDirectory,
      });

      cursor = fnameEnd + extraLen + commentLen;
    }

    return entries;
  }
}
