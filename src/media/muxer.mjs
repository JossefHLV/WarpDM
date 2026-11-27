/**
 * Media Muxer
 * Fast lossless remuxing of separated video and audio tracks or HLS/DASH segments into MP4/MKV.
 */

import { spawn } from "node:child_process";
import path from "node:path";

export class MediaMuxer {
  constructor(ffmpegPath = "C:\\ffmpeg\\bin\\ffmpeg.exe") {
    this.ffmpegPath = ffmpegPath;
  }

  /**
   * Losslessly merges video track + audio track into single MP4/MKV container.
   */
  async remuxVideoAndAudio(videoPath, audioPath, outputPath) {
    return new Promise((resolve, reject) => {
      const args = [
        "-y",
        "-i",
        path.resolve(videoPath),
        "-i",
        path.resolve(audioPath),
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        path.resolve(outputPath),
      ];

      const proc = spawn(this.ffmpegPath, args, { stdio: "inherit" });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(outputPath);
        } else {
          reject(new Error(`FFmpeg remux failed with exit code ${code}`));
        }
      });

      proc.on("error", (err) => {
        reject(err);
      });
    });
  }

  /**
   * Losslessly concatenates an ordered list of TS or fMP4 segments.
   */
  async concatSegments(segmentListFile, outputPath) {
    return new Promise((resolve, reject) => {
      const args = [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        path.resolve(segmentListFile),
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        path.resolve(outputPath),
      ];

      const proc = spawn(this.ffmpegPath, args, { stdio: "inherit" });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(outputPath);
        } else {
          reject(new Error(`FFmpeg concat failed with exit code ${code}`));
        }
      });

      proc.on("error", (err) => {
        reject(err);
      });
    });
  }
}
