import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const hookScript = join(
  repoRoot,
  'understand-anything-plugin',
  'hooks',
  'post-tool-use-auto-update.mjs',
);
const hooksConfig = JSON.parse(
  readFileSync(
    join(repoRoot, 'understand-anything-plugin', 'hooks', 'hooks.json'),
    'utf8',
  ),
);

// Every run gets a throwaway HOME so the hook never reads the developer's
// real ~/.understand-anything/config.json.
function makeHome({ userAutoUpdate = true, userConfigContents, createUserConfig = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ua-hook-home-'));
  if (createUserConfig) {
    const userDir = join(home, '.understand-anything');
    mkdirSync(userDir);
    writeFileSync(
      join(userDir, 'config.json'),
      userConfigContents ?? JSON.stringify({ autoUpdate: userAutoUpdate }),
    );
  }
  return home;
}

// Pin `node` on PATH to the binary running the tests so the SessionStart
// one-liner does not pick up a version-manager shim that depends on HOME.
// Reuse the existing PATH key name (Windows spells it `Path`).
const PATH_KEY = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';

function homeEnv(home) {
  return {
    HOME: home,
    USERPROFILE: home,
    [PATH_KEY]: `${dirname(process.execPath)}${delimiter}${process.env[PATH_KEY] ?? ''}`,
  };
}

function runHook({
  command = 'git commit -m "test"',
  autoUpdate = true,
  configContents,
  createConfig = true,
  createGraph = true,
  createUserConfig = true,
  dataDirName = '.understand-anything',
  input,
  pluginRoot,
  userAutoUpdate = true,
  userConfigContents,
} = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ua-post-tool-use-'));
  const home = makeHome({ userAutoUpdate, userConfigContents, createUserConfig });
  const dataDir = join(projectRoot, dataDirName);
  mkdirSync(dataDir);
  if (createConfig) {
    writeFileSync(
      join(dataDir, 'config.json'),
      configContents ?? JSON.stringify({ autoUpdate }),
    );
  }
  if (createGraph) writeFileSync(join(dataDir, 'knowledge-graph.json'), '{}');

  const resolvedPluginRoot = pluginRoot ?? join(projectRoot, 'plugin root');
  const result = spawnSync(process.execPath, [hookScript], {
    cwd: projectRoot,
    input:
      input ??
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command },
      }),
    env: {
      ...process.env,
      ...homeEnv(home),
      CLAUDE_PLUGIN_ROOT: resolvedPluginRoot,
    },
    encoding: 'utf8',
  });

  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  return { ...result, pluginRoot: resolvedPluginRoot };
}

/**
 * Run the SessionStart shell one-liner from hooks.json inside a temporary git
 * repository. Returns the hook's stdout.
 */
function runSessionStart({
  autoUpdate = true,
  createUserConfig = true,
  staleGraph = true,
  userAutoUpdate = true,
  userConfigContents,
} = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ua-session-start-'));
  const home = makeHome({ userAutoUpdate, createUserConfig, userConfigContents });
  const git = (...args) =>
    execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'hook-tests@example.com');
  git('config', 'user.name', 'Hook Tests');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(projectRoot, 'README.md'), 'hello\n');
  git('add', '--all');
  git('commit', '-q', '-m', 'baseline');
  const head = git('rev-parse', 'HEAD');

  const dataDir = join(projectRoot, '.ua');
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ autoUpdate }));
  writeFileSync(join(dataDir, 'knowledge-graph.json'), '{}');
  writeFileSync(
    join(dataDir, 'meta.json'),
    JSON.stringify({ gitCommitHash: staleGraph ? '0000000' : head }),
  );

  const pluginRoot = join(projectRoot, 'plugin root');
  const command = hooksConfig.hooks.SessionStart[0].hooks[0].command;
  const result = spawnSync('sh', ['-c', command], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...homeEnv(home),
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    },
    encoding: 'utf8',
  });

  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  return { ...result, pluginRoot };
}

describe('PostToolUse auto-update hook', () => {
  it('is registered as the Bash PostToolUse handler', () => {
    const registration = hooksConfig.hooks.PostToolUse[0];

    expect(registration.matcher).toBe('Bash');
    expect(registration.hooks).toEqual([
      {
        type: 'command',
        command:
          'node "${CLAUDE_PLUGIN_ROOT}/hooks/post-tool-use-auto-update.mjs"',
      },
    ]);
  });

  it('injects an advisory stale-graph notice as PostToolUse additional context', () => {
    const result = runHook();
    const output = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: expect.stringContaining(
          '[understand-anything] Commit detected',
        ),
      },
    });
    const context = output.hookSpecificOutput.additionalContext;
    expect(context).toContain(`${result.pluginRoot}/hooks/auto-update-prompt.md`);
    expect(context).toMatch(/ask the user/i);
    expect(context).toMatch(/only if the user agrees/i);
    expect(context).not.toMatch(/you must/i);
    expect(context).not.toMatch(/do not ask the user/i);
    expect(context).not.toMatch(/just do it/i);
  });

  it('requires the user-level opt-in, not just the repo config', () => {
    for (const options of [
      { createUserConfig: false },
      { userAutoUpdate: false },
      { userConfigContents: '{not-json' },
      { userConfigContents: JSON.stringify({ autoUpdate: 'true' }) },
    ]) {
      const result = runHook(options);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('');
    }
  });

  it('ignores the user opt-in when the project data dir is the user config dir', () => {
    // Project root == $HOME: `.understand-anything/config.json` is both the
    // repo-controlled project config and the user-level file. A single
    // write must not satisfy both opt-ins.
    const home = makeHome({ userAutoUpdate: true });
    writeFileSync(join(home, '.understand-anything', 'knowledge-graph.json'), '{}');
    const result = spawnSync(process.execPath, [hookScript], {
      cwd: home,
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }),
      env: { ...process.env, ...homeEnv(home), CLAUDE_PLUGIN_ROOT: join(home, 'plugin root') },
      encoding: 'utf8',
    });
    rmSync(home, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('');
  });

  it('requires the project-level opt-in, not just the user config', () => {
    const result = runHook({ autoUpdate: false, userAutoUpdate: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it.each(['commit', 'merge', 'cherry-pick', 'rebase'])(
    'recognizes git %s as a graph-changing operation',
    (operation) => {
      const result = runHook({ command: `git ${operation} example` });

      expect(result.status).toBe(0);
      expect(
        JSON.parse(result.stdout).hookSpecificOutput.hookEventName,
      ).toBe('PostToolUse');
    },
  );

  it('preserves Windows-style plugin paths as valid JSON', () => {
    const pluginRoot = 'C:\\Users\\Example Person\\understand-anything';
    const result = runHook({ pluginRoot });
    const output = JSON.parse(result.stdout);

    expect(output.hookSpecificOutput.additionalContext).toContain(
      `${pluginRoot}/hooks/auto-update-prompt.md`,
    );
  });

  it('supports the legacy .ua data directory', () => {
    const result = runHook({ dataDirName: '.ua' });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.hookEventName).toBe(
      'PostToolUse',
    );
  });

  it('stays silent for unrelated Bash commands', () => {
    const result = runHook({ command: 'git status --short' });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('stays silent when automatic updates are disabled', () => {
    const result = runHook({ autoUpdate: false });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it.each([
    ['malformed stdin', { input: '{not-json' }],
    ['a missing config', { createConfig: false }],
    ['a malformed config', { configContents: '{not-json' }],
    ['a missing graph', { createGraph: false }],
  ])('stays silent for %s', (_scenario, options) => {
    const result = runHook(options);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('');
  });
});

describe('SessionStart stale-graph hook', () => {
  // The one-liner is a POSIX shell snippet (Claude Code runs it through
  // sh); exercising it end to end needs a POSIX shell and POSIX paths.
  const posix = process.platform !== 'win32';

  it('is registered without a matcher', () => {
    const registration = hooksConfig.hooks.SessionStart[0];

    expect(registration.matcher).toBeUndefined();
    expect(registration.hooks).toHaveLength(1);
    expect(registration.hooks[0].type).toBe('command');
  });

  it('is advisory and references the user-level config', () => {
    const command = hooksConfig.hooks.SessionStart[0].hooks[0].command;

    expect(command).toContain('$HOME/.understand-anything/config.json');
    expect(command).toMatch(/ask the user/i);
    expect(command).not.toMatch(/you must/i);
    expect(command).not.toMatch(/do not ask the user/i);
    expect(command).not.toMatch(/just do it/i);
  });

  it.skipIf(!posix)('emits the notice only when both configs opt in and the graph is stale', () => {
    const enabled = runSessionStart();
    expect(enabled.status).toBe(0);
    expect(enabled.stdout).toContain('[understand-anything]');
    expect(enabled.stdout).toContain(`${enabled.pluginRoot}/hooks/auto-update-prompt.md`);

    for (const options of [
      { createUserConfig: false },
      { userAutoUpdate: false },
      { userConfigContents: '{not-json' },
      // Only a top-level `autoUpdate: true` counts; nested keys must not.
      { userConfigContents: JSON.stringify({ autoUpdate: false, other: { autoUpdate: true } }) },
      { autoUpdate: false },
      { staleGraph: false },
    ]) {
      const result = runSessionStart(options);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    }
  });
});
