// Reads the files of a small zip in the browser, with the browser's own deflate (DecompressionStream): for the
// code panel, which compares the packages of two tutorial steps. Not for large or encrypted zips, nor ZIP64.

/**
 * The files of a zip: path → bytes. Folders are left out.
 *
 * @param {ArrayBuffer} buffer
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function readZip(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder();

  // The end of central directory record: signature 0x06054b50, within the last 64 KB (its comment).
  let end = -1;

  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }

  if (end < 0) {
    throw new Error('Not a zip file');
  }

  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const files = new Map();

  for (let entry = 0; entry < count; entry++) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('A damaged zip file');
    }

    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeader = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) {
      continue;
    }

    // The data follows the local header, whose name and extra field may differ in length from the central one's.
    const start = localHeader + 30 + view.getUint16(localHeader + 26, true) + view.getUint16(localHeader + 28, true);
    const data = bytes.subarray(start, start + compressedSize);

    if (method === 0) {
      files.set(name, data);
    } else if (method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));

      files.set(name, new Uint8Array(await new Response(stream).arrayBuffer()));
    } else {
      throw new Error(`${name}: compression method ${method} is not supported`);
    }
  }

  return files;
}
