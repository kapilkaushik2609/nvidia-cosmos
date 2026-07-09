const fs = require("fs");
const path = require("path");

const PROMPTS_DIR = path.join(__dirname, "..", "..", "prompts");

// Loads prompts/<mode>_<version>.txt and substitutes {{KEY}} placeholders with
// vars[key]. Throws if the file is missing or a placeholder has no matching
// var — a silent wrong/missing substitution would go straight into a prompt
// sent to a model, which is worse than failing loudly here.
function loadPrompt(mode, version, vars) {
  const file = path.join(PROMPTS_DIR, `${mode}_${version}.txt`);
  let template;
  try {
    template = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`Prompt template not found: ${file} (${err.message})`);
  }
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!(key in vars)) {
      throw new Error(`Missing prompt variable "${key}" for ${mode}_${version}.txt`);
    }
    return vars[key];
  });
}

module.exports = { loadPrompt };
