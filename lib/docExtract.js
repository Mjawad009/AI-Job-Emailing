const MAX_CHARS = 6000; // keep prompt size/cost reasonable

function truncate(text) {
  const trimmed = (text || "").trim();
  return trimmed.length > MAX_CHARS ? trimmed.slice(0, MAX_CHARS) + "\n[...truncated]" : trimmed;
}

// `ext` is the lowercase file extension including the dot, e.g. ".pdf".
async function extractTextFromBuffer(buffer, ext) {
  const normalizedExt = (ext || "").toLowerCase();

  try {
    if (normalizedExt === ".pdf") {
      const { extractText } = require("unpdf");
      const result = await extractText(new Uint8Array(buffer));
      return truncate(result.text.join("\n"));
    }

    if (normalizedExt === ".docx") {
      const mammoth = require("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      return truncate(result.value);
    }

    // Legacy .doc (binary Word format) isn't reliably parseable without extra
    // native tooling — skip extraction rather than return garbage text.
    return "";
  } catch (e) {
    console.error(`CV text extraction failed (${normalizedExt}):`, e.message);
    return "";
  }
}

module.exports = { extractTextFromBuffer };
