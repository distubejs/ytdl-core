import type { VideoFormat } from "../../../src/index.ts";

export const formatKey = (format: VideoFormat) => `${format.itag}-${format.isDrc}`;

export function formatLabel(format: VideoFormat): string {
  const codec = format.videoCodec ?? format.audioCodec ?? format.codecs;
  const quality = format.qualityLabel ?? `${format.audioBitrate} kbps${format.isDrc ? " stable volume" : ""}`;
  return `${format.container} ${codec.split(".")[0]} · ${quality}`;
}

export const megabytes = (format: VideoFormat) =>
  format.contentLength === undefined ? "size unknown" : `${(format.contentLength / 1e6).toFixed(1)} MB`;
