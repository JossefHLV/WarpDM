/**
 * MPEG-DASH MPD Parser
 * Parses XML manifests to extract video and audio representations and segment templates.
 */

export class DashParser {
  static parseMpd(mpdXml, baseUrl) {
    const base = new URL(baseUrl);
    const videoRepresentations = [];
    const audioRepresentations = [];

    // Parse AdaptationSets using Regex for robust zero-dependency XML parsing
    const adaptationSetRegex = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi;
    let adaptMatch;

    while ((adaptMatch = adaptationSetRegex.exec(mpdXml)) !== null) {
      const adaptAttrs = parseXmlAttrs(adaptMatch[1]);
      const adaptContent = adaptMatch[2];
      const mimeType = adaptAttrs.mimeType || adaptAttrs.contentType || "";

      // Look for SegmentTemplate inside AdaptationSet
      let initTemplate = null;
      let mediaTemplate = null;
      const segTemplateMatch = adaptContent.match(/<SegmentTemplate\b([^>]*)\/?>/i);
      if (segTemplateMatch) {
        const segAttrs = parseXmlAttrs(segTemplateMatch[1]);
        initTemplate = segAttrs.initialization || null;
        mediaTemplate = segAttrs.media || null;
      }

      // Look for Representations
      const repRegex = /<Representation\b([^>]*)\/?>/gi;
      let repMatch;

      while ((repMatch = repRegex.exec(adaptContent)) !== null) {
        const repAttrs = parseXmlAttrs(repMatch[1]);
        const id = repAttrs.id || "";
        const bandwidth = parseInt(repAttrs.bandwidth || "0", 10);
        const width = repAttrs.width ? parseInt(repAttrs.width, 10) : null;
        const height = repAttrs.height ? parseInt(repAttrs.height, 10) : null;
        const codecs = repAttrs.codecs || null;
        const repMime = repAttrs.mimeType || mimeType;

        const rep = {
          id,
          mimeType: repMime,
          bandwidth,
          width,
          height,
          codecs,
          initializationTemplate: initTemplate,
          mediaTemplate: mediaTemplate,
        };

        if (repMime.includes("video") || width !== null) {
          videoRepresentations.push(rep);
        } else if (repMime.includes("audio")) {
          audioRepresentations.push(rep);
        }
      }
    }

    return {
      baseUrl: base.toString(),
      videoRepresentations,
      audioRepresentations,
    };
  }
}

function parseXmlAttrs(attrString) {
  const result = {};
  const regex = /([a-zA-Z0-9_:-]+)=["']([^"']*)["']/g;
  let match;
  while ((match = regex.exec(attrString)) !== null) {
    result[match[1]] = match[2];
  }
  return result;
}
