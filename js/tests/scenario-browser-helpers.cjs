// Follow the same scenario route on desktop and mobile.
async function selectScenario(page, profile) {
  if (!await page.locator('#scenarioPicker').isVisible()) await page.locator('#changeScenarioBtn').click();
  await page.locator(`#scenarioChoices [data-profile="${profile}"]`).click();
}

// Audio/layout suites isolate account services. Quota behavior is exercised by
// test-access-browser-runner.cjs against the actual admission service instead.
async function allowTestAccess(page) {
  await page.route('**/api/tests/**', route => route.fulfill({ json: { ok: true } }));
}

module.exports = { selectScenario, allowTestAccess };
