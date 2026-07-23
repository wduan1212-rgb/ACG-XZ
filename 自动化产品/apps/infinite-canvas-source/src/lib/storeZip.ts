const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

export function buildStoreZip(entries: Array<{ name: string; blob: Blob }>) {
  const encoder = new TextEncoder();
  return Promise.all(
    entries.map(async (entry) => ({
      name: encoder.encode(entry.name),
      bytes: new Uint8Array(await entry.blob.arrayBuffer()),
    })),
  ).then((files) => {
    const localParts: Uint8Array[] = [];
    const centralParts: Uint8Array[] = [];
    let offset = 0;

    files.forEach(({ name, bytes }) => {
      const checksum = crc32(bytes);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);
      local.setUint32(14, checksum, true);
      local.setUint32(18, bytes.length, true);
      local.setUint32(22, bytes.length, true);
      local.setUint16(26, name.length, true);
      localParts.push(new Uint8Array(local.buffer), name, bytes);

      const central = new DataView(new ArrayBuffer(46));
      central.setUint32(0, 0x02014b50, true);
      central.setUint16(4, 20, true);
      central.setUint16(6, 20, true);
      central.setUint16(8, 0x0800, true);
      central.setUint32(16, checksum, true);
      central.setUint32(20, bytes.length, true);
      central.setUint32(24, bytes.length, true);
      central.setUint16(28, name.length, true);
      central.setUint32(42, offset, true);
      centralParts.push(new Uint8Array(central.buffer), name);
      offset += 30 + name.length + bytes.length;
    });

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    const blobParts = [...localParts, ...centralParts, new Uint8Array(end.buffer)].map(
      (part) => Uint8Array.from(part).buffer,
    );
    return new Blob(blobParts, {
      type: "application/zip",
    });
  });
}
