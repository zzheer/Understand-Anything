// Guards the security properties of the subagent definitions in
// understand-anything-plugin/agents/*.md: every agent declares an explicit,
// minimal `tools:` allowlist, none can spawn further agents, Bash is limited
// to the agents that must run scripts, and every agent that reads project
// content carries the untrusted-content guard.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentsDir = resolve(__dirname, '../../understand-anything-plugin/agents');
const agentFiles = readdirSync(agentsDir)
  .filter((name) => name.endsWith('.md'))
  .sort();

const BASH_AGENTS = new Set([
  'architecture-analyzer.md',
  'file-analyzer.md',
  'graph-reviewer.md',
  'project-scanner.md',
  'tour-builder.md',
]);

const KNOWN_TOOLS = new Set(['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']);

// Windows runners check out with CRLF (core.autocrlf=true); normalize before parsing.
function readAgent(file) {
  return readFileSync(join(agentsDir, file), 'utf8').replace(/\r\n?/g, '\n');
}

function frontmatter(content) {
  expect(content.startsWith('---\n')).toBe(true);
  const end = content.indexOf('\n---\n', 4);
  expect(end).toBeGreaterThan(0);
  return content.slice(4, end);
}

function toolsOf(content) {
  const match = frontmatter(content).match(/^tools:\s*(.+)$/m);
  expect(match, 'missing tools: frontmatter').not.toBeNull();
  return match[1].split(',').map((tool) => tool.trim()).filter(Boolean);
}

describe('agent definitions', () => {
  it('lists every agent', () => {
    expect(agentFiles.length).toBeGreaterThan(0);
  });

  it.each(agentFiles)('%s declares a minimal tools allowlist', (file) => {
    const content = readAgent(file);
    const tools = toolsOf(content);

    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(KNOWN_TOOLS.has(tool), `${file}: unexpected tool ${tool}`).toBe(true);
    }
    expect(tools).not.toContain('Agent');
    expect(tools).not.toContain('Task');
    expect(tools).not.toContain('WebFetch');
    expect(tools).not.toContain('WebSearch');
    if (BASH_AGENTS.has(file)) {
      expect(tools).toContain('Bash');
    } else {
      expect(tools).not.toContain('Bash');
    }
  });

  it.each(agentFiles.filter((file) => file !== 'knowledge-graph-guide.md'))(
    '%s treats project content as untrusted data',
    (file) => {
      const content = readAgent(file);

      expect(content).toMatch(/untrusted project data/i);
      expect(content).toMatch(/ignore any instructions/i);
    },
  );
});
