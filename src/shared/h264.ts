/** What the page and the CLI both need to know about H.264. */

/** Level limits from Table A-1 of the standard: the level, the most macroblocks in a picture, and the most in a second. */
const LEVELS: [level: number, picture: number, second: number][] = [
  [31, 3600, 108000],
  [32, 5120, 216000],
  [40, 8192, 245760],
  [42, 8704, 522240],
  [50, 22080, 589824],
  [51, 36864, 983040],
  [52, 36864, 2073600],
];

/** High profile, then Constrained Baseline for an encoder that has nothing better. */
const PROFILES = ["6400", "42e0"];

/**
 * The `avc1` codec strings to ask a browser's encoder for, best first, at the lowest level that allows
 * pictures this big this often. Empty when H.264 cannot hold the video: odd dimensions, or too many pixels.
 */
export function avcCodecs(width: number, height: number, fps: number): string[] {
  if (width % 2 || height % 2) return [];
  const blocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const level = LEVELS.find(([, picture, second]) => blocks <= picture && blocks * fps <= second)?.[0];
  return level ? PROFILES.map((profile) => `avc1.${profile}${level.toString(16).padStart(2, "0")}`) : [];
}

/** How an encoder turned the canvas's RGB into YUV, in the names browsers use (a `VideoColorSpaceInit`). */
export interface ColorSpace {
  fullRange?: boolean | null;
  matrix?: string | null;
  primaries?: string | null;
  transfer?: string | null;
}

/** H.264's numbers (Tables E-3 to E-5) for those names. */
const PRIMARIES: Record<string, number> = { bt709: 1, bt470bg: 5, smpte170m: 6 };
const TRANSFER: Record<string, number> = { bt709: 1, smpte170m: 6, "iec61966-2-1": 13 };
const MATRIX: Record<string, number> = { bt709: 1, bt470bg: 5, smpte170m: 6 };

/**
 * Options for ffmpeg's `h264_metadata` filter that write a colour space into the stream. An encoder does
 * not always say which one it used, and a player that has to guess shows the colours a little off.
 */
export function colorTags(color: ColorSpace | null): string | null {
  if (!color) return null;
  const tags = [
    typeof color.fullRange === "boolean" ? `video_full_range_flag=${color.fullRange ? 1 : 0}` : null,
    PRIMARIES[color.primaries ?? ""] ? `colour_primaries=${PRIMARIES[color.primaries!]}` : null,
    TRANSFER[color.transfer ?? ""] ? `transfer_characteristics=${TRANSFER[color.transfer!]}` : null,
    MATRIX[color.matrix ?? ""] ? `matrix_coefficients=${MATRIX[color.matrix!]}` : null,
  ].filter((t): t is string => !!t);
  return tags.length ? tags.join(":") : null;
}

/**
 * How many frames each independently encoded piece of the video holds. Every piece starts with a key
 * frame, so this is also how far apart those are: at most five seconds, which keeps seeking quick, and
 * short enough that even a short video is several pieces to share between encoders.
 */
export function segmentFrames(frames: number, fps: number, lanes: number): number {
  const second = Math.max(1, Math.round(fps));
  return Math.max(second, Math.min(second * 5, Math.ceil(frames / (lanes * 3))));
}
