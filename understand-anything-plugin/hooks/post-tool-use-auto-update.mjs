// PostToolUse hook: after a graph-changing git command, remind the agent
// that the knowledge graph may be stale.
//
// The reminder is advisory. It is only emitted when BOTH the user-level
// config (~/.understand-anything/config.json) and the project-level config
// (<project>/.ua/config.json or .understand-anything/config.json) opt in
// with `"autoUpdate": true`. The project config is repo-controlled data —
// anyone who can commit to the repository can set it — so it must never be
// sufficient on its own to steer the agent into running the update
// pipeline. The user-level file is the human's own opt-in.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const COMMIT_COMMAND = /git\s+(commit|merge|cherry-pick|rebase)/;

function findDataDir() {
  return existsSync('.understand-anything') ? '.understand-anything' : '.ua';
}

function readAutoUpdateFlag(configPath) {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    return config !== null && typeof config === 'object' && config.autoUpdate === true;
  } catch {
    return false;
  }
}

function userConfigPath() {
  return join(homedir(), '.understand-anything', 'config.json');
}

function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function autoUpdateEnabled(dataDir) {
  const userConfig = userConfigPath();
  const projectConfig = `${dataDir}/config.json`;
  // When the analyzed project is $HOME itself, the legacy data dir
  // `.understand-anything/config.json` IS the user-level file. One
  // repo-controlled write would then satisfy both opt-ins, so treat the
  // user opt-in as absent in that case.
  if (canonicalPath(userConfig) === canonicalPath(projectConfig)) return false;
  return readAutoUpdateFlag(userConfig) && readAutoUpdateFlag(projectConfig);
}

async function readStdin() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return;
  }

  const command = payload?.tool_input?.command;
  if (typeof command !== 'string' || !COMMIT_COMMAND.test(command)) return;

  const dataDir = findDataDir();
  if (!autoUpdateEnabled(dataDir)) return;
  if (!existsSync(`${dataDir}/knowledge-graph.json`)) return;

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? '';
  const additionalContext =
    `[understand-anything] Commit detected and auto-update is enabled in both ` +
    `the user and project config, so the knowledge graph may now be stale. ` +
    `Ask the user whether they want to update it (re-running /understand performs ` +
    `an incremental update). Only if the user agrees, follow the procedure in ` +
    `${pluginRoot}/hooks/auto-update-prompt.md. Do not start the update on your own.`;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext,
      },
    }),
  );
}

await main();
