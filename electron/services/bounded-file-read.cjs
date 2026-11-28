const fsp = require("fs/promises");

// Reject oversized files before reading. Limit the read on this same handle
// as well, in case a writer extends the file after the size check.
const readFileUpTo = async (absolutePath, maxBytes) => {
  const handle = await fsp.open(absolutePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const chunks = [];
    let size = 0;
    while (size <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      size += bytesRead;
    }
    if (size > maxBytes) return null;
    return Buffer.concat(chunks, size);
  } finally {
    await handle.close();
  }
};

module.exports = { readFileUpTo };
