import fs from "fs";
import zlib from "zlib";

/**
 * Minimal zero-dependency ZIP archive creator using Node.js Buffer and zlib.deflateRawSync.
 * Produces standard PKZIP 2.0 archives fully compliant with dotLottie (.lottie) spec.
 */
export interface ZipFileEntry {
  name: string;
  data: string | Buffer;
}

export function createZipArchive(files: ZipFileEntry[]): Buffer {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const file of files) {
    const filenameBuf = Buffer.from(file.name, "utf-8");
    const rawData = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf-8");
    const compressedData = zlib.deflateRawSync(rawData);
    const useDeflate = compressedData.length < rawData.length;
    const finalData = useDeflate ? compressedData : rawData;
    const compressionMethod = useDeflate ? 8 : 0; // 8 = Deflate, 0 = Store
    const crc = crc32(rawData);

    // Local file header (30 bytes + name + data)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local header signature
    localHeader.writeUInt16LE(20, 4);         // Version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6);     // Flags (UTF-8)
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(0, 10);        // Mod time
    localHeader.writeUInt16LE(0, 12);        // Mod date
    localHeader.writeUInt32LE(crc, 14);      // CRC-32
    localHeader.writeUInt32LE(finalData.length, 18); // Compressed size
    localHeader.writeUInt32LE(rawData.length, 22);   // Uncompressed size
    localHeader.writeUInt16LE(filenameBuf.length, 26); // Filename length
    localHeader.writeUInt16LE(0, 28);        // Extra field length

    localHeaders.push(localHeader, filenameBuf, finalData);

    // Central directory header (46 bytes + name)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Central header signature
    centralHeader.writeUInt16LE(20, 4);          // Version made by
    centralHeader.writeUInt16LE(20, 6);          // Version needed
    centralHeader.writeUInt16LE(0x0800, 8);      // Flags
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt16LE(0, 12);         // Mod time
    centralHeader.writeUInt16LE(0, 14);         // Mod date
    centralHeader.writeUInt32LE(crc, 16);       // CRC-32
    centralHeader.writeUInt32LE(finalData.length, 20); // Compressed size
    centralHeader.writeUInt32LE(rawData.length, 24);   // Uncompressed size
    centralHeader.writeUInt16LE(filenameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);         // Extra field length
    centralHeader.writeUInt16LE(0, 32);         // File comment length
    centralHeader.writeUInt16LE(0, 34);         // Disk number start
    centralHeader.writeUInt16LE(0, 36);         // Internal file attributes
    centralHeader.writeUInt32LE(0, 38);         // External file attributes
    centralHeader.writeUInt32LE(offset, 42);    // Relative offset of local header

    centralHeaders.push(centralHeader, filenameBuf);
    offset += localHeader.length + filenameBuf.length + finalData.length;
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const buf of centralHeaders) {
    centralDirSize += buf.length;
  }

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4);          // Number of this disk
  eocd.writeUInt16LE(0, 6);          // Disk with start of central directory
  eocd.writeUInt16LE(files.length, 8); // Total entries on this disk
  eocd.writeUInt16LE(files.length, 10); // Total entries in central directory
  eocd.writeUInt32LE(centralDirSize, 12); // Size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16); // Offset of start of central directory
  eocd.writeUInt16LE(0, 20);         // Comment length

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

// CRC-32 table calculation
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
