/**
 * HLS Stream Parser
 * Parses Master and Media M3U8 playlists into structured variants and segments.
 */

export class HlsParser {
  static parse(m3u8Content, baseUrl) {
    const lines = m3u8Content.split(/\r?\n/).map((l) => l.trim());
    if (lines[0] !== "#EXTM3U") {
      throw new Error("Invalid HLS playlist: missing #EXTM3U header");
    }

    const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));
    const base = new URL(baseUrl);

    if (isMaster) {
      const variants = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith("#EXT-X-STREAM-INF:")) {
          const attributes = parseAttributes(line.slice(18));
          const uri = lines[i + 1];
          if (uri && !uri.startsWith("#")) {
            variants.push({
              uri: new URL(uri, base).toString(),
              bandwidth: attributes.BANDWIDTH ? parseInt(attributes.BANDWIDTH, 10) : 0,
              resolution: attributes.RESOLUTION || null,
              codecs: attributes.CODECS || null,
            });
          }
        }
      }
      return { type: "master", variants };
    } else {
      const segments = [];
      let currentInit = null;
      let currentKey = null;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.startsWith("#EXT-X-MAP:")) {
          const attrs = parseAttributes(line.slice(11));
          if (attrs.URI) {
            currentInit = new URL(attrs.URI.replace(/^["']|["']$/g, ""), base).toString();
          }
        } else if (line.startsWith("#EXT-X-KEY:")) {
          const attrs = parseAttributes(line.slice(11));
          if (attrs.URI) {
            currentKey = new URL(attrs.URI.replace(/^["']|["']$/g, ""), base).toString();
          }
        } else if (line.startsWith("#EXTINF:")) {
          const durationMatch = line.slice(8).match(/^([\d.]+)/);
          const duration = durationMatch ? parseFloat(durationMatch[1]) : 0;
          const uri = lines[i + 1];
          if (uri && !uri.startsWith("#")) {
            segments.push({
              uri: new URL(uri, base).toString(),
              duration,
              initUri: currentInit,
              keyUri: currentKey,
            });
          }
        }
      }
      return { type: "media", segments };
    }
  }
}

function parseAttributes(attrString) {
  const result = {};
  const regex = /([A-Z0-9_-]+)=(?:"([^"]*)"|([^,]*))/g;
  let match;
  while ((match = regex.exec(attrString)) !== null) {
    result[match[1]] = match[2] !== undefined ? match[2] : match[3];
  }
  return result;
}
