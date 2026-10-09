// Loaded into the debug app by the runner; all fixture behavior lives in scenarios.
window.__listCheck = { ready: false };
import('/src/test/list-scenarios.ts').then(({getListScenario, describeListScenario}) => {
  const scenario = getListScenario(window.__listCheckOptions.scenario);
  const fixture = window.__listCheck;
  fixture.scenario = scenario;
  fixture.description = describeListScenario(scenario);
  fixture.restore = scenario.install(window.__listCheckOptions.count, false);
  const navigation = document.querySelector(`a[href="${scenario.route}"]`);
  if (!navigation) throw new Error(`No navigation link for ${scenario.route}`);
  navigation.click();
  fixture.ready = true;
}).catch(error => { window.__listCheck.error = String(error); });
