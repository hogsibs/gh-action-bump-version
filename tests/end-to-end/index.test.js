const dotenv = require('dotenv');
const setupTestRepo = require('./setupTestRepo');
const yaml = require('js-yaml');
const { writeFile, readFile, mkdir } = require('fs/promises');
const { join } = require('path');
const { env } = require('process');
const git = require('./git');
const { getMostRecentWorkflowRun, getWorkflowRun } = require('./actionsApi');
const copyDirectory = require('./copyDirectory');
const getTestConfig = require('./getTestConfig');
const pollFor = require('./pollFor');
const getWorkflowResults = require('./getWorkflowResults');

dotenv.config();

const testConfig = getTestConfig();
const testRepoPath = join(env.RUNNER_TEMP, 'main');

const workflowResults = (async () => {
  await setupTestRepo(testConfig.actionFiles, testRepoPath);
  await Promise.all(
    testConfig.setups.map(async (setup) => {
      const setupYaml = yaml.dump(setup.yaml);
      const setupDirectory = join(env.RUNNER_TEMP, setup.name);
      await mkdir(setupDirectory);
      await Promise.all(
        setup.tests.map(async (test, index) => {
          const testDirectory = join(setupDirectory, `${index}`);
          await copyDirectory(testRepoPath, testDirectory);
          const pushYamlPath = join('.github', 'workflows', 'push.yml');
          await mkdir(join(testDirectory, '.github', 'workflows'), { recursive: true });
          await writeFile(join(testDirectory, pushYamlPath), setupYaml);
          await git({ cwd: testDirectory }, 'add', pushYamlPath);
          await setPackageJsonVersion(test.startingVersion, testDirectory);
          await git({ cwd: testDirectory }, 'add', 'package.json');
          await git({ cwd: testDirectory }, 'checkout', '-b', `tests/${setup.name}/${index}`);

          await generateReadMe(test, setupYaml, testDirectory);
          await git({ cwd: testDirectory }, 'commit', '--message', test.message);

          await git({ cwd: testDirectory }, 'push', '-u', 'origin', 'HEAD');
        }),
      );
    }),
  );
  return await getWorkflowResults(testConfig);
})();

beforeAll(() => workflowResults);

testConfig.setups.forEach((setup) => {
  describe(setup.name, () => {
    setup.tests.forEach((commit, index) => {
      const testDirectory = join(env.RUNNER_TEMP, setup.name, `${index}`);
      test(commit.message, async () => {
        const results = await workflowResults;
        const conclusion = results[setup.name][index];
        expect(conclusion).toBe('success');

        await assertExpectation(commit.expected, testDirectory);

        expect(1).toBe(1);
      });
    });
  });
});

async function generateReadMe(test, setupYaml, directory) {
  const readmePath = 'README.md';
  const readMeContents = [
    '# Test Details',
    '## .github/workflows/push.yml',
    '```YAML',
    setupYaml,
    '```',
    '## Message',
    test.message,
    '## Starting Version',
    test.startingVersion,
    '## Expectation',
    generateExpectationText(test.expected),
  ].join('\n');
  await writeFile(join(directory, readmePath), readMeContents);
  await git({ cwd: directory }, 'add', readmePath);
}

async function getCompletedRunAfter(date) {
  const run = await pollFor(getMostRecentWorkflowRun, (run) => run !== null && new Date(run.created_at) > date);
  const completedRun = await pollFor(
    () => getWorkflowRun(run.id),
    (run) => run.status === 'completed',
  );
  return completedRun;
}

async function getMostRecentWorkflowRunDate() {
  const run = await getMostRecentWorkflowRun();
  const date = run === null ? new Date(0) : new Date(run.created_at);
  return date;
}

function generateExpectationText({ version: expectedVersion, tag: expectedTag, branch: expectedBranch }) {
  const results = [`- **Version:** ${expectedVersion}`];
  if (expectedTag) {
    results.push(`- **Tag:** ${expectedTag}`);
  }
  if (expectedBranch) {
    results.push(`- **Branch:** ${expectedBranch}`);
  }
  return results.join('\n');
}

async function assertExpectation(
  { version: expectedVersion, tag: expectedTag, branch: expectedBranch, skipTagCheck },
  directory,
) {
  if (expectedTag === undefined) {
    expectedTag = expectedVersion;
  }
  if (expectedBranch) {
    await git({ cwd: directory }, 'fetch', 'origin', expectedBranch);
    await git({ cwd: directory }, 'checkout', expectedBranch);
  }
  await git({ cwd: directory }, 'pull');
  const [packageVersion, latestTag] = await Promise.all([getPackageJsonVersion(directory), getLatestTag(directory)]);
  expect(packageVersion).toBe(expectedVersion);
  if (!skipTagCheck) {
    expect(latestTag).toBe(expectedTag);
  }
}

async function getPackageJsonVersion(directory) {
  const path = join(directory, 'package.json');
  const contents = await readFile(path);
  const json = JSON.parse(contents);
  return json.version;
}

async function setPackageJsonVersion(version, directory) {
  const path = join(directory, 'package.json');
  const contents = await readFile(path);
  const json = JSON.parse(contents);
  json.version = version;
  const newContents = JSON.stringify(json);
  await writeFile(path, newContents);
}

async function getLatestTag(directory) {
  const result = await git({ suppressOutput: true, cwd: directory }, 'describe', '--tags', '--abbrev=0', '--always');
  return result.stdout;
}
