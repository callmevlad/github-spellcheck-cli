#!/usr/bin/env node
const chalk = require('chalk');
const dotenv = require('dotenv');
const commandLineArgs = require('command-line-args');
const getUsage = require('command-line-usage');
const fs = require('fs-extra');
const glob = require('globby');
const _ = require('lodash');
const {
  Cred, Index, Remote, Repository, Reset,
} = require('nodegit');
const opn = require('opn');
const decode = require('parse-entities');
const path = require('path');
const prompt = require('prompt-promise');
const userHome = require('user-home');

const { addByUserSelection } = require('./lib/add-by-user-selection');
const {
  createPullRequest,
  deleteRepo,
  findForkOfRepo,
  forkRepo,
  getAllReposForAuthenticatedUser,
} = require('./lib/github');
const { cloneWithRetry } = require('./lib/retry');
const { getMisspellings } = require('./lib/spellcheck');
const { respondToUserInput } = require('./lib/user-input');

let isNewFork = false;
let repoUser;
let repoName;
let clonePath;

function parseRepo(repo) {
  if (!repo) {
    return Promise.reject(new Error('No repository name specified.'));
  }

  const regexes = [
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([-\w]+)\/([-_\w.]+)(?:\/[^/]+)*$/,
    /^([-\w]+)\/([-_\w.]+)$/,
  ];
  const matchingRegex = _.find(regexes, re => re.test(repo));
  if (matchingRegex) {
    const result = matchingRegex.exec(repo);
    return Promise.resolve([result[1], result[2]]);
  }
  return Promise.reject(new Error('Repository name is invalid.'));
}

async function findGithubFile(name) {
  return _.first(await glob(
    `{${name}*,{.github,docs}/${name}*}`,
    { cwd: clonePath, gitignore: true, nocase: true }
  ));
}

const optionDefinitions = [
  {
    name: 'help', alias: 'h', type: Boolean, description: 'Print this usage guide.',
  },
  {
    name: 'token', alias: 't', typeLabel: '<token>', description: 'GitHub personal access token. You only need to provide the token when you start using github-spellcheck, and again if you have a new token.',
  },
  {
    name: 'repository', alias: 'r', typeLabel: '<username/repository or URL>', description: 'The repository to spellcheck.',
  },
  {
    name: 'branch', defaultValue: 'fix-typos', typeLabel: '<branch name>', description: 'The name of the branch to commit corrections to.',
  },
  {
    name: 'base', defaultValue: 'master', typeLabel: '<branch name>', description: 'The name of the branch to create the pull request against.',
  },
  {
    name: 'extensions', alias: 'e', multiple: true, defaultValue: ['md', 'txt'], typeLabel: '<extension> [<extension>] ...', description: 'Only spellcheck files with these extensions for spelling mistakes.',
  },
  {
    name: 'include', multiple: true, defaultValue: [], typeLabel: '<glob> ...', description: 'Only spellcheck files that match at least one of these globs.',
  },
  {
    name: 'exclude', multiple: true, defaultValue: [], typeLabel: '<glob> ...', description: 'Do not spellcheck files that match one of these globs.',
  },
  {
    name: 'quiet', alias: 'q', type: Boolean, description: 'Do not open CONTRIBUTING.md or the new pull request in a browser.',
  },
];

const usageSections = [
  {
    header: 'github-spellcheck',
    content: 'A tool for checking GitHub repositories for spelling errors and submitting PRs to fix them.',
  },
  {
    header: 'Options',
    optionList: optionDefinitions,
  },
];

function printUsage() {
  console.log(getUsage(usageSections));
}

async function go() {
  let commandLineArguments;

  try {
    commandLineArguments = commandLineArgs(optionDefinitions);
  } catch (error) {
    if (error.name === 'UNKNOWN_OPTION') {
      console.error(chalk.red(error.message));
      printUsage();
    } else {
      console.error(chalk.red('An unknown error occurred.'));
    }

    process.exit(1);
  }

  const {
    help,
    token,
    repository,
    branch: branchName,
    base: baseBranchName,
    extensions,
    include,
    exclude,
    quiet,
  } = commandLineArguments;

  if (help) {
    printUsage();
    process.exit(0);
  }

  if (extensions.length === 0) {
    console.error(chalk.red('Provide at least one extension.'));
    printUsage();
    process.exit(1);
  }

  if (token) {
    await fs.writeFile('.env', `GITHUB_TOKEN=${token}`);
  }
  dotenv.config();

  [repoUser, repoName] = await parseRepo(repository).catch((error) => {
    console.error(chalk.red(error));
    printUsage();
    process.exit(1);
  });
  const userAndRepo = `${repoUser}/${repoName}`;
  const extensionRegex = new RegExp(`\\.(${extensions.join('|')})$`);

  console.log('Getting a list of all GitHub repos that you have access to...');
  const userRepos = await getAllReposForAuthenticatedUser();

  const repoWithSameFullName = _.find(userRepos, { full_name: userAndRepo });
  if (repoWithSameFullName) {
    console.log(`You already have access to ${userAndRepo}.`);
  } else {
    console.log(`You don't have access to ${userAndRepo}.`);
    console.log(`Looking for a fork of ${userAndRepo} that you have access to...`);
    const fork = await findForkOfRepo(userAndRepo, userRepos);
    if (fork) {
      console.log(`You have access to ${fork.full_name}, which is a fork of ${userAndRepo}.`);
      repoUser = fork.owner.login;
      repoName = fork.name;
    } else {
      console.log(`You don't have access to ${userAndRepo} or any of its forks.`);
      console.log(`Forking ${userAndRepo} using your GitHub credentials...`);
      const newFork = await forkRepo(repoUser, repoName);
      console.log(`Forked ${userAndRepo} to ${newFork.full_name}.`);
      isNewFork = true;
      repoUser = newFork.owner.login;
      repoName = newFork.name;
    }
  }

  const githubCredentialsOptions = {
    callbacks: {
      credentials: () => Cred.userpassPlaintextNew(process.env.GITHUB_TOKEN, 'x-oauth-basic'),
    },
  };

  clonePath = path.join(userHome, `/.github-spellcheck/${repoUser}/${repoName}`);

  let exists;
  if (isNewFork) {
    console.log(`Making sure the temporary directory for ${repoUser}/${repoName} doesn't already exist...`);
    await fs.remove(clonePath);
    exists = false;
  } else {
    console.log(`Checking if ${repoUser}/${repoName} has already been cloned...`);
    exists = (await fs.pathExists(clonePath)) && (await fs.pathExists(path.join(clonePath, '/.git')));
  }

  let repo;
  if (exists) {
    repo = await Repository.open(clonePath);
  } else {
    console.log('Creating a temporary directory...');
    await fs.ensureDir(clonePath);

    const url = `https://github.com/${repoUser}/${repoName}.git`;
    console.log(`Cloning ${url} into the temporary directory...`);
    repo = await cloneWithRetry(url, clonePath, githubCredentialsOptions);
  }

  console.log(`Fetching the latest on the branch '${baseBranchName}' from the parent repository...`);
  if (!await Remote.lookup(repo, 'parent').catch(() => false)) {
    await Remote.create(repo, 'parent', `https://github.com/${userAndRepo}`);
  }
  await repo.fetchAll(githubCredentialsOptions);

  console.log(`Merging the latest from the parent repository into '${baseBranchName}'...`);
  await repo.mergeBranches(baseBranchName, `parent/${baseBranchName}`);

  console.log(`Getting the last commit from the branch '${baseBranchName}'...`);
  const commit = await repo.getBranchCommit(baseBranchName);

  console.log('Resetting local repository...');
  await Reset.reset(repo, commit, Reset.TYPE.HARD);

  console.log('Getting the state of the working tree...');
  const tree = await commit.getTree();

  console.log('Getting a list of files in the working tree...');
  let treeEntries = await new Promise((resolve, reject) => {
    const walker = tree.walk(true);
    walker.on('end', resolve);
    walker.on('error', reject);
    walker.start();
  });

  treeEntries = _.sortBy(treeEntries, treeEntry => treeEntry.path());

  function getPathsToIncludeOrExclude(includeOrExclude) {
    return glob(includeOrExclude, { cwd: clonePath, gitignore: true });
  }

  function includesPath(pathsToTestAgainst) {
    return treeEntry => _.includes(pathsToTestAgainst, treeEntry.path().replace(/\\/g, '/'));
  }

  if (!_.isEmpty(include)) {
    console.log('Filtering the list to only include files that match the regexes specified with the --include option...');
    const pathsToInclude = await getPathsToIncludeOrExclude(include);
    treeEntries = _.filter(treeEntries, includesPath(pathsToInclude));
  }

  if (!_.isEmpty(exclude)) {
    console.log('Excluding files that match the regexes specified with the --exclude option...');
    const pathsToExclude = await getPathsToIncludeOrExclude(exclude);
    treeEntries = _.reject(treeEntries, includesPath(pathsToExclude));
  }

  console.log(`Filtering the list to only include files with extensions '${extensions.join(', ')}'...`);
  treeEntries = _.filter(treeEntries, treeEntry => extensionRegex.test(treeEntry.path()));

  console.log('Spell-checking the remaining files...');
  const misspellingsByFile = await Promise.all(_.map(treeEntries, async (entry) => {
    const blob = await entry.getBlob();
    const misspellings = await getMisspellings(decode(blob.toString().replace(/\r\n/g, '\n')), entry.path());
    return _.map(misspellings, misspelling => _.assign({}, misspelling, {
      path: entry.path(),
    }));
  }));

  const { changeCount, finalDiff } = await addByUserSelection(_.flatten(misspellingsByFile), repo);

  console.log();

  if (changeCount > 0) {
    const contributingGuidelines = await findGithubFile('CONTRIBUTING');
    if (!quiet && contributingGuidelines) {
      console.log('Opening CONTRIBUTING.md...');
      await opn(`https://github.com/${repoUser}/${repoName}/blob/${baseBranchName}/${contributingGuidelines}`);
      console.log();
    }

    console.log();
    console.log();
    console.log(chalk.yellow('Overview of corrections'));
    console.log(chalk.yellow('-----------------------'));
    console.log();
    console.log(finalDiff);
    console.log();

    await respondToUserInput(
      'Are you sure you want to create a pull request with these corrections?',
      [
        {
          command: 'y',
          meaning: 'yes',
          description: 'Create a pull request with the specified changes.',
          responseFunction: async () => {
            console.log(`Creating a new branch "${branchName}"...`);
            const newBranchRef = await repo.createBranch('fix-typos', commit, false);

            console.log(`Checking out "${branchName}"...`);
            await repo.checkoutBranch(newBranchRef);

            const index = await repo.refreshIndex();

            console.log('Adding all changes to the index...');
            await index.addAll(['*'], Index.ADD_OPTION.ADD_DEFAULT);
            await index.write();
            const indexOid = await index.writeTree();

            const signature = repo.defaultSignature();
            console.log('Committing all changes...');
            const newCommit = await repo.createCommit(
              'HEAD',
              signature,
              signature,
              `docs: fix typo${changeCount === 1 ? '' : 's'}`,
              indexOid,
              [commit]
            );

            console.log(`Commit ${newCommit} created.`);
            console.log('Pushing to remote "origin"...');
            const remote = await Remote.lookup(repo, 'origin');
            await remote.push([`refs/heads/${branchName}`], githubCredentialsOptions);

            if (await findGithubFile('PULL_REQUEST_TEMPLATE') && !quiet) {
              console.log('Opening the pull request creation page...');
              await opn(`https://github.com/${userAndRepo}/compare/${baseBranchName}...${repoUser}:${branchName}`);
            } else {
              console.log('Creating a pull request...');
              const [parentRepoUser, parentRepoName] = await parseRepo(userAndRepo);
              const pullRequest = await createPullRequest(
                parentRepoUser,
                parentRepoName,
                `${repoUser}:${branchName}`,
                baseBranchName,
                `Fix typo${changeCount === 1 ? '' : 's'}`,
                'PR created using https://github.com/tbroadley/github-spellcheck-cli.'
              );

              if (quiet) {
                console.log(`Pull request #${pullRequest.number} created.`);
              } else {
                console.log(`Pull request #${pullRequest.number} created. Opening in your browser...`);
                await opn(pullRequest.html_url);
              }
            }
          },
        },
        {
          command: 'n',
          meaning: 'no',
          description: 'Exit the program.',
          responseFunction: _.noop,
        },
      ]
    );
  } else if (isNewFork) {
    console.log(chalk.red('No corrections added.'));
    console.log(chalk.red(`Deleting ${repoUser}/${repoName}...`));
    await deleteRepo(repoUser, repoName);
    console.log(chalk.red('Exiting...'));
  } else {
    console.log(chalk.red('No corrections added. Exiting...'));
  }

  prompt.finish();
}

go().catch(async (error) => {
  console.error(chalk.red(`Error: ${error}`));

  if (isNewFork && repoUser && repoName) {
    console.log(chalk.red(`Deleting ${repoUser}/${repoName}...`));
    await deleteRepo(repoUser, repoName);
  }

  console.log(chalk.red('Exiting...'));
  process.exit(1);
});
