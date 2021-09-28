const { getWorkflowRuns } = require('./actionsApi');
const pollFor = require('./pollFor');

async function getWorkflowResults(testConfig) {
  const results = {};
  for (const setup of testConfig.setups) {
    results[setup.name] = setup.tests.map(() => null);
  }
  await pollFor(getWorkflowRuns, (runs) =>
    testConfig.setups.every((setup) =>
      setup.tests.every((_, index) =>
        runs.some((run) => {
          results[setup.name][index] = run.conclusion;
          return run.head_branch == `tests/${setup.name}/${index}` && run.status === 'completed';
        }),
      ),
    ),
  );
  return results;
}
module.exports = getWorkflowResults;
