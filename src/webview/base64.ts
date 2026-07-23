/** Decode a base64 string (frame/image payload from the host) to bytes. */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/** MIME type for a compressed-image format string ("jpeg" → "image/jpeg"). */
export function imageMime(format: string): string {
  const f = format.trim().toLowerCase();
  if (f === "jpg" || f === "jpeg") {
    return "image/jpeg";
  }
  if (f.startsWith("image/")) {
    return f;
  }
  return `image/${f || "png"}`;
}
