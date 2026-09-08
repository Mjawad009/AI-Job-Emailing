// A minimal 1x1 transparent PNG, served at the open-tracking endpoint.
const TRACKING_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

const URL_REGEX = /\bhttps?:\/\/[^\s<>"')]+/g;
const TRAILING_PUNCT_REGEX = /[.,;:!?)\]}]+$/;

function linkify(text) {
  return text.replace(URL_REGEX, rawUrl => {
    const trailingMatch = rawUrl.match(TRAILING_PUNCT_REGEX);
    const trailing = trailingMatch ? trailingMatch[0] : "";
    const url = trailing ? rawUrl.slice(0, -trailing.length) : rawUrl;
    return `<a href="${url}">${url}</a>${trailing}`;
  });
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Turns plain-text email body (with \n paragraph breaks) into simple HTML:
// each blank-line-separated block becomes a <p>, single newlines within a
// block become <br>. Bare URLs become real links.
function textToHtml(text) {
  const blocks = text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const htmlBlocks = blocks.map(block => {
    const escaped = escapeHtml(block).replace(/\n/g, "<br>");
    const linked = linkify(escaped);
    return `<p style="margin:0 0 16px;">${linked}</p>`;
  });
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.5;">${htmlBlocks.join("\n")}</div>`;
}

// Rewrites every <a href="..."> to route through the click-tracking
// redirect, and appends an invisible open-tracking pixel at the end.
function injectTracking(html, { trackingId, baseUrl, trackOpens, trackClicks }) {
  let result = html;

  if (trackClicks) {
    result = result.replace(/href="([^"]+)"/g, (match, url) => {
      if (!/^https?:\/\//i.test(url)) return match; // leave mailto:, anchors, etc. alone
      const redirectUrl = `${baseUrl}/t/click/${trackingId}?u=${encodeURIComponent(url)}`;
      return `href="${redirectUrl}"`;
    });
  }

  if (trackOpens) {
    const pixel = `<img src="${baseUrl}/t/open/${trackingId}.png" width="1" height="1" alt="" style="display:none;border:0;" />`;
    result += `\n${pixel}`;
  }

  return result;
}

module.exports = { TRACKING_PIXEL_PNG, textToHtml, injectTracking };
