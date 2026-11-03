// Shared by the local network probe and its offline response-validation tests.
export async function readBounded(response, maximum, expectedRange = null) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing response body");
  const chunks = [];
  let length = 0, firstByteAt = null;
  try {
    if (expectedRange) {
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") || "");
      if (response.status !== 206 || !match || Number(match[1]) !== expectedRange.start
        || Number(match[2]) !== expectedRange.end || Number(match[3]) <= expectedRange.end) throw new Error("invalid 206 Content-Range");
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteAt === null && value.byteLength) firstByteAt = performance.now();
      length += value.byteLength;
      if (length > maximum) throw new Error("response exceeded byte limit");
      chunks.push(value);
    }
    if (expectedRange && length !== expectedRange.end - expectedRange.start + 1) throw new Error("truncated Range response");
    return { body: Buffer.concat(chunks, length), firstByteAt };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
