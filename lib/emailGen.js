const store = require("./store");
const openrouter = require("./openrouter");
const { render, cleanupEmptyFields } = require("./template");
const { textToHtml, injectTracking } = require("./tracking");

// Generates the text body only (no tracking baked in yet — that happens at
// send time once we have a tracking_id). Throws on failure.
async function generateForProspect(userId, { company, contactName, notes, collateralId, settings, collateral, stepInstructions, subjectOverride }) {
  const s = settings || (await store.load(userId));
  const resolvedCollateral = collateral !== undefined ? collateral : await store.getCollateral(userId, collateralId);

  const linksBlock = (s.links || [])
    .filter(l => l.label && l.url)
    .map(l => `${l.label}: ${l.url}`)
    .join("\n");

  const vars = {
    company: company || "your company",
    contactName: contactName || "",
    name: s.name || "",
    companyName: s.companyName || "",
    phone: s.phone || "",
    links: linksBlock
  };

  const rawBody = await openrouter.generateEmail(userId, {
    company,
    contactName,
    notes,
    format: s.emailFormat,
    collateralText: resolvedCollateral ? resolvedCollateral.text : "",
    extraInfo: s.extraInfo,
    stepInstructions
  });

  const textBody = cleanupEmptyFields(render(rawBody, vars)).trimEnd();
  const subject = render(subjectOverride || s.subjectTemplate, vars);

  return { subject, textBody };
}

// Wraps a generated text body into the final HTML + tracked version, ready
// to hand to the mailer. Called at send time once a tracking_id exists.
function buildTrackedVersion(textBody, { trackingId, baseUrl, trackOpens, trackClicks }) {
  const html = textToHtml(textBody);
  const htmlBody = injectTracking(html, { trackingId, baseUrl, trackOpens, trackClicks });
  return htmlBody;
}

module.exports = { generateForProspect, buildTrackedVersion };
