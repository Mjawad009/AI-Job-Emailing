function render(template, vars) {
  return template.replace(/{{\s*(\w+)\s*}}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : "";
  });
}

// After rendering, drop any "Label: " signature line that ended up empty —
// e.g. GitHub/Portfolio left blank in Settings — instead of sending an email
// with a dangling empty field. Also collapses any resulting run of 3+ blank
// lines back down to a single blank line, so removing a line doesn't leave
// an awkward gap.
function cleanupEmptyFields(text) {
  const withoutEmptyLabels = text
    .split("\n")
    .filter(line => !/^(LinkedIn|GitHub|Portfolio|Phone):\s*$/i.test(line.trim()))
    .join("\n");

  return withoutEmptyLabels.replace(/\n{3,}/g, "\n\n");
}

module.exports = { render, cleanupEmptyFields };
