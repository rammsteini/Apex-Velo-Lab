/**
 * APEX VELO // LAB - minimal ZIP reader for archives on disk (a File or Blob), no library.
 *
 * Reads only the central directory up front, then each entry on demand with Blob.slice, so even a
 * multi-gigabyte Strava export is never loaded into memory as a whole. Supports stored (0) and
 * deflate (8) entries and ZIP64 (archives over 4 GB or with more than 65535 entries).
 * Decompression uses the browser's DecompressionStream ('deflate-raw' / 'gzip').
 */
class VeloZip {
  /** True when this browser can unpack deflate data (Chrome/Edge 103+, Firefox 113+, Safari 16.4+). */
  static supported() {
    if (typeof DecompressionStream === 'undefined') return false;
    try { new DecompressionStream('deflate-raw'); return true; } catch (e) { return false; }
  }

  static async bytes(blob, start, end) {
    return new Uint8Array(await blob.slice(start, end).arrayBuffer());
  }

  /** Lists the entries of a ZIP: [{ name, method, compSize, size, offset }]. Throws on a file that is not a ZIP. */
  static async list(blob) {
    const size = blob.size;
    // End of central directory: 22 bytes plus a comment of up to 64 KB, at the very end.
    const tailStart = Math.max(0, size - (22 + 65535 + 20));
    const tail = await VeloZip.bytes(blob, tailStart, size);
    const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('This is not a ZIP file (no central directory found).');
    let count = dv.getUint16(eocd + 10, true);
    let cdSize = dv.getUint32(eocd + 12, true);
    let cdOffset = dv.getUint32(eocd + 16, true);
    // ZIP64: the locator sits right before the classic record and points at the ZIP64 record.
    const loc = eocd - 20;
    if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
      const z64Off = VeloZip.u64(dv, loc + 8);
      const z = await VeloZip.bytes(blob, z64Off, z64Off + 56);
      const zv = new DataView(z.buffer, z.byteOffset, z.byteLength);
      if (zv.getUint32(0, true) === 0x06064b50) {
        count = VeloZip.u64(zv, 32);
        cdSize = VeloZip.u64(zv, 40);
        cdOffset = VeloZip.u64(zv, 48);
      }
    }
    const cd = await VeloZip.bytes(blob, cdOffset, cdOffset + cdSize);
    const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    const utf8 = new TextDecoder('utf-8');
    const entries = [];
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cv.getUint32(p, true) !== 0x02014b50) throw new Error('The ZIP directory is damaged.');
      const method = cv.getUint16(p + 10, true);
      let compSize = cv.getUint32(p + 20, true);
      let usize = cv.getUint32(p + 24, true);
      const nameLen = cv.getUint16(p + 28, true);
      const extraLen = cv.getUint16(p + 30, true);
      const commentLen = cv.getUint16(p + 32, true);
      let offset = cv.getUint32(p + 42, true);
      const name = utf8.decode(cd.subarray(p + 46, p + 46 + nameLen));
      // ZIP64 extra field (0x0001): the 64-bit values, in this order, for each 32-bit field that is 0xFFFFFFFF.
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = cv.getUint16(e, true), len = cv.getUint16(e + 2, true);
        if (id === 0x0001) {
          let q = e + 4;
          if (usize === 0xFFFFFFFF) { usize = VeloZip.u64(cv, q); q += 8; }
          if (compSize === 0xFFFFFFFF) { compSize = VeloZip.u64(cv, q); q += 8; }
          if (offset === 0xFFFFFFFF) { offset = VeloZip.u64(cv, q); q += 8; }
        }
        e += 4 + len;
      }
      if (!name.endsWith('/')) entries.push({ name, method, compSize, size: usize, offset });
      p = eEnd + commentLen;
    }
    return entries;
  }

  static u64(dv, off) {
    return dv.getUint32(off, true) + dv.getUint32(off + 4, true) * 0x100000000;
  }

  /** The unpacked contents of one entry as an ArrayBuffer. */
  static async read(blob, entry) {
    const head = await VeloZip.bytes(blob, entry.offset, entry.offset + 30);
    const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (hv.getUint32(0, true) !== 0x04034b50) throw new Error(`ZIP entry ${entry.name} is damaged.`);
    const start = entry.offset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
    const data = blob.slice(start, start + entry.compSize);
    if (entry.method === 0) return data.arrayBuffer();
    if (entry.method !== 8) throw new Error(`ZIP entry ${entry.name} uses an unsupported compression method (${entry.method}).`);
    return new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
  }

  /** Unpacks gzip data (a .fit.gz / .gpx.gz / .tcx.gz inside the archive). */
  static async gunzip(buf) {
    return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
}

if (typeof window !== 'undefined') window.VeloZip = VeloZip;
if (typeof module !== 'undefined') module.exports = VeloZip;
