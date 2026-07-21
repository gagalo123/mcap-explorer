/**
 * Minimal, dependency-free H.264/H.265 (and best-effort VP9/AV1) bitstream
 * inspection: enough to tell keyframes from delta frames and to derive a
 * WebCodecs codec string from a keyframe's parameter sets. Runs host-side so
 * the webview can seek-to-keyframe and configure a VideoDecoder.
 *
 * Frames from foxglove.CompressedVideo are Annex-B (start-code delimited) and
 * contain exactly one coded picture; H.264/H.265 keyframes additionally carry
 * their parameter sets in-band, which is what we parse here.
 */

export type VideoCodec = "h264" | "h265" | "vp9" | "av1";

/** Map a foxglove.CompressedVideo `format` string to our codec union. */
export function normalizeCodec(format: string): VideoCodec | undefined {
  switch (format.trim().toLowerCase()) {
    case "h264":
    case "avc":
    case "avc1":
      return "h264";
    case "h265":
    case "hevc":
    case "hev1":
    case "hvc1":
      return "h265";
    case "vp9":
    case "vp09":
      return "vp9";
    case "av1":
    case "av01":
      return "av1";
    default:
      return undefined;
  }
}

/** True when this frame can be a decoder start point (IDR/IRAP/key). */
export function classifyFrame(data: Uint8Array, codec: VideoCodec): { keyframe: boolean } {
  switch (codec) {
    case "h264":
      return { keyframe: h264HasKeyframeNal(data) };
    case "h265":
      return { keyframe: h265HasKeyframeNal(data) };
    case "vp9":
      return { keyframe: vp9IsKeyframe(data) };
    case "av1":
      return { keyframe: av1HasSequenceHeader(data) };
  }
}

/**
 * Build a WebCodecs codec string. For H.264/H.265 the profile/level are parsed
 * from the SPS in `keyframeData`; when absent we fall back to a common default
 * and let VideoDecoder.isConfigSupported() gate it.
 */
export function codecStringFor(codec: VideoCodec, keyframeData?: Uint8Array): string {
  switch (codec) {
    case "h264":
      return (keyframeData && h264CodecString(keyframeData)) || "avc1.42E01E";
    case "h265":
      return (keyframeData && h265CodecString(keyframeData)) || "hev1.1.6.L93.B0";
    case "vp9":
      return "vp09.00.10.08";
    case "av1":
      return "av01.0.04M.08";
  }
}

// ---- NAL iteration (Annex-B) --------------------------------------------

/** Yields the offset of each NAL's first header byte (start code stripped). */
function* nalOffsets(data: Uint8Array): Generator<number> {
  const n = data.length;
  let i = 0;
  while (i + 3 <= n) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      yield i + 3;
      i += 3;
    } else {
      i += 1;
    }
  }
}

/** End offset (exclusive) of the NAL that starts at `start`: the next start code or EOF. */
function nalEnd(data: Uint8Array, start: number): number {
  const n = data.length;
  for (let i = start; i + 3 <= n; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      // A 4-byte start code (00 00 00 01) leaves a trailing zero before it.
      return i > start && data[i - 1] === 0 ? i - 1 : i;
    }
  }
  return n;
}

/** Strip emulation-prevention bytes (00 00 03 → 00 00) to recover the RBSP. */
function toRbsp(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < nal.length; i++) {
    const next = nal[i + 1];
    if (
      i >= 2 &&
      nal[i] === 0x03 &&
      nal[i - 1] === 0x00 &&
      nal[i - 2] === 0x00 &&
      (next === undefined || next <= 0x03)
    ) {
      continue; // drop emulation_prevention_three_byte
    }
    out.push(nal[i]!);
  }
  return new Uint8Array(out);
}

// ---- H.264 ---------------------------------------------------------------

const H264_NAL_IDR = 5;
const H264_NAL_SPS = 7;

function h264HasKeyframeNal(data: Uint8Array): boolean {
  for (const off of nalOffsets(data)) {
    if ((data[off]! & 0x1f) === H264_NAL_IDR) {
      return true;
    }
  }
  return false;
}

function h264CodecString(data: Uint8Array): string | undefined {
  for (const off of nalOffsets(data)) {
    if ((data[off]! & 0x1f) !== H264_NAL_SPS) {
      continue;
    }
    // SPS RBSP begins right after the 1-byte NAL header.
    const rbsp = toRbsp(data.subarray(off + 1, nalEnd(data, off)));
    if (rbsp.length < 3) {
      return undefined;
    }
    const profile = rbsp[0]!;
    const constraint = rbsp[1]!;
    const level = rbsp[2]!;
    return `avc1.${hex2(profile)}${hex2(constraint)}${hex2(level)}`;
  }
  return undefined;
}

// ---- H.265 ---------------------------------------------------------------

const H265_NAL_SPS = 33;

function h265NalType(firstHeaderByte: number): number {
  return (firstHeaderByte >> 1) & 0x3f;
}

function h265HasKeyframeNal(data: Uint8Array): boolean {
  // 16..21 = BLA_W_LP … CRA_NUT (IRAP pictures a decoder can start from).
  for (const off of nalOffsets(data)) {
    const t = h265NalType(data[off]!);
    if (t >= 16 && t <= 21) {
      return true;
    }
  }
  return false;
}

function h265CodecString(data: Uint8Array): string | undefined {
  for (const off of nalOffsets(data)) {
    if (h265NalType(data[off]!) !== H265_NAL_SPS) {
      continue;
    }
    // HEVC NAL header is 2 bytes; SPS RBSP follows.
    const rbsp = toRbsp(data.subarray(off + 2, nalEnd(data, off)));
    return parseHevcSpsCodecString(rbsp);
  }
  return undefined;
}

function parseHevcSpsCodecString(rbsp: Uint8Array): string | undefined {
  try {
    const r = new BitReader(rbsp);
    r.skip(4); // sps_video_parameter_set_id
    const maxSubLayersMinus1 = r.readBits(3);
    r.skip(1); // sps_temporal_id_nesting_flag
    // profile_tier_level( profilePresentFlag=1, maxSubLayersMinus1 )
    const profileSpace = r.readBits(2);
    const tierFlag = r.readBits(1);
    const profileIdc = r.readBits(5);
    let compat = 0;
    for (let i = 0; i < 32; i++) {
      compat = ((compat << 1) | r.readBits(1)) >>> 0;
    }
    const constraint: number[] = [];
    for (let i = 0; i < 6; i++) {
      constraint.push(r.readBits(8));
    }
    // sub-layer profile/level present flags would follow for maxSubLayersMinus1>0,
    // but general_level_idc comes right after the 6 constraint bytes.
    void maxSubLayersMinus1;
    const levelIdc = r.readBits(8);

    const spacePrefix = profileSpace === 0 ? "" : String.fromCharCode(0x40 + profileSpace); // 1→A …
    const compatHex = reverseBits32(compat).toString(16);
    let end = constraint.length;
    while (end > 0 && constraint[end - 1] === 0) {
      end -= 1;
    }
    const constraintHex = (end === 0 ? [0] : constraint.slice(0, end))
      .map((b) => hex2(b).toUpperCase())
      .join(".");
    return `hev1.${spacePrefix}${profileIdc}.${compatHex}.${tierFlag ? "H" : "L"}${levelIdc}.${constraintHex}`;
  } catch {
    return undefined;
  }
}

// ---- VP9 / AV1 (best-effort) --------------------------------------------

function vp9IsKeyframe(data: Uint8Array): boolean {
  try {
    const r = new BitReader(data);
    if (r.readBits(2) !== 2) {
      return false; // frame_marker
    }
    const profileLow = r.readBits(1);
    const profileHigh = r.readBits(1);
    const profile = (profileHigh << 1) | profileLow;
    if (profile === 3) {
      r.skip(1); // reserved_zero
    }
    if (r.readBits(1) === 1) {
      return false; // show_existing_frame
    }
    return r.readBits(1) === 0; // frame_type: 0 = KEY_FRAME
  } catch {
    return false;
  }
}

const AV1_OBU_SEQUENCE_HEADER = 1;

function av1HasSequenceHeader(data: Uint8Array): boolean {
  let i = 0;
  while (i < data.length) {
    const header = data[i]!;
    const type = (header >> 3) & 0x0f;
    const extFlag = (header >> 2) & 1;
    const hasSize = (header >> 1) & 1;
    i += 1;
    if (extFlag) {
      i += 1;
    }
    let size: number;
    if (hasSize) {
      const [value, read] = readLeb128(data, i);
      if (read === 0) {
        return type === AV1_OBU_SEQUENCE_HEADER;
      }
      size = value;
      i += read;
    } else {
      size = data.length - i;
    }
    if (type === AV1_OBU_SEQUENCE_HEADER) {
      return true;
    }
    i += size;
  }
  return false;
}

function readLeb128(data: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let read = 0;
  for (let i = 0; i < 8; i++) {
    const byte = data[offset + i];
    if (byte === undefined) {
      return [value, 0];
    }
    value |= (byte & 0x7f) << (i * 7);
    read += 1;
    if ((byte & 0x80) === 0) {
      return [value >>> 0, read];
    }
  }
  return [value >>> 0, read];
}

// ---- helpers -------------------------------------------------------------

class BitReader {
  #data: Uint8Array;
  #bytePos = 0;
  #bitPos = 0;

  constructor(data: Uint8Array) {
    this.#data = data;
  }

  readBits(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.#data[this.#bytePos];
      if (byte === undefined) {
        throw new Error("bit reader out of range");
      }
      const bit = (byte >> (7 - this.#bitPos)) & 1;
      value = (value << 1) | bit;
      this.#bitPos += 1;
      if (this.#bitPos === 8) {
        this.#bitPos = 0;
        this.#bytePos += 1;
      }
    }
    return value >>> 0;
  }

  skip(n: number): void {
    this.readBits(n);
  }
}

function hex2(b: number): string {
  return b.toString(16).padStart(2, "0");
}

function reverseBits32(value: number): number {
  let r = 0;
  for (let i = 0; i < 32; i++) {
    r = ((r << 1) | ((value >>> i) & 1)) >>> 0;
  }
  return r >>> 0;
}
