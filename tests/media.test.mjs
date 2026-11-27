import test from "node:test";
import assert from "node:assert";
import { HlsParser } from "../src/media/hls.mjs";
import { DashParser } from "../src/media/dash.mjs";

test("HlsParser parses Master Playlist with bandwidth & resolution", () => {
  const masterContent = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p.m3u8`;

  const parsed = HlsParser.parse(masterContent, "https://cdn.example.com/live/master.m3u8");
  assert.strictEqual(parsed.type, "master");
  assert.strictEqual(parsed.variants.length, 2);
  assert.strictEqual(parsed.variants[0].bandwidth, 1280000);
  assert.strictEqual(parsed.variants[0].resolution, "1280x720");
  assert.strictEqual(parsed.variants[1].uri, "https://cdn.example.com/live/1080p.m3u8");
});

test("DashParser parses MPD XML representations", () => {
  const mpdContent = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period id="0">
    <AdaptationSet mimeType="video/mp4" width="1920" height="1080">
      <SegmentTemplate initialization="init-v.mp4" media="seg-v-$Number$.m4s" />
      <Representation id="v1080" bandwidth="4500000" codecs="avc1.640028" />
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4">
      <SegmentTemplate initialization="init-a.mp4" media="seg-a-$Number$.m4s" />
      <Representation id="a128" bandwidth="128000" codecs="mp4a.40.2" />
    </AdaptationSet>
  </Period>
</MPD>`;

  const manifest = DashParser.parseMpd(mpdContent, "https://cdn.example.com/dash/manifest.mpd");
  assert.strictEqual(manifest.videoRepresentations.length, 1);
  assert.strictEqual(manifest.videoRepresentations[0].id, "v1080");
  assert.strictEqual(manifest.videoRepresentations[0].bandwidth, 4500000);
  assert.strictEqual(manifest.audioRepresentations.length, 1);
  assert.strictEqual(manifest.audioRepresentations[0].id, "a128");
});
