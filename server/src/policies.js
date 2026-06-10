const { readAbout } = require("./releaseContent");

const defaults = {
  supportEmail: process.env.SUPPORT_EMAIL || "",
  privacyPolicyUrl: process.env.PRIVACY_POLICY_URL || "",
  termsUrl: process.env.TERMS_URL || "",
  publisherName: process.env.PUBLISHER_NAME || "Feigram Publisher",
  releaseUrl: process.env.RELEASE_URL || "https://github.com/g-star1024/Feigram-Public"
};

async function readPolicies() {
  const about = readAbout();
  return {
    ...defaults,
    supportEmail: about.supportEmail || defaults.supportEmail,
    privacyPolicyUrl: about.privacyPolicyUrl || defaults.privacyPolicyUrl,
    termsUrl: about.termsUrl || defaults.termsUrl,
    publisherName: about.publisherName || defaults.publisherName,
    releaseUrl: about.releaseUrl || defaults.releaseUrl
  };
}

module.exports = { readPolicies };
