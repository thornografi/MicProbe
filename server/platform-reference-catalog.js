const { PLATFORM_TARGET_CATALOGS } = require('../js/modules/PlatformContext.js');

// Private, append-only releases. Codec/setting observations in Config are not
// calibrated quality ranges. Real platform + local-output validation must precede
// adding a reference here; see PLATFORM_REFERENCES.md for the admission contract.
const PLATFORM_REFERENCE_CATALOGS = Object.freeze({
  '2026-09-11.1': Object.freeze({ targets: PLATFORM_TARGET_CATALOGS['2026-09-11.1'], references: Object.freeze([]) })
});

module.exports = { PLATFORM_REFERENCE_CATALOGS };
