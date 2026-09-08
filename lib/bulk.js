const XLSX = require("xlsx");

const MAX_ROWS = 50;

const COLUMN_ALIASES = {
  to: ["email", "to", "contactemail", "workemail", "emailaddress"],
  company: ["company", "companyname", "organization", "account"],
  contactName: ["name", "contact", "contactname", "fullname"],
  notes: ["notes", "context", "details", "description", "about"],
  raw: ["content", "post", "raw", "text", "pasted", "linkedinpost", "message", "bio"]
};

function normalizeKey(key) {
  return String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function buildKeyMap(headers) {
  const map = {};
  for (const header of headers) {
    const normalized = normalizeKey(header);
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (aliases.includes(normalized) && !map[field]) {
        map[field] = header;
      }
    }
  }
  return map;
}

// Parses a CSV or XLSX buffer into normalized rows: { to, company,
// contactName, notes, raw }. Column names are matched flexibly and case
// insensitively — see COLUMN_ALIASES. Returns { rows, truncated, totalRows }.
function parseFile(buffer, filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const workbook =
    ext === "csv"
      ? XLSX.read(buffer.toString("utf-8"), { type: "string" })
      : XLSX.read(buffer, { type: "buffer" });

  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return { rows: [], truncated: false, totalRows: 0 };

  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  if (!rawRows.length) return { rows: [], truncated: false, totalRows: 0 };

  const headers = Object.keys(rawRows[0]);
  const keyMap = buildKeyMap(headers);

  const totalRows = rawRows.length;
  const truncated = totalRows > MAX_ROWS;
  const limited = rawRows.slice(0, MAX_ROWS);

  const rows = limited.map((raw, i) => {
    const get = field => (keyMap[field] ? String(raw[keyMap[field]] || "").trim() : "");
    return {
      rowIndex: i,
      to: get("to"),
      company: get("company"),
      contactName: get("contactName"),
      notes: get("notes"),
      raw: get("raw")
    };
  });

  return { rows, truncated, totalRows };
}

module.exports = { parseFile, MAX_ROWS };
