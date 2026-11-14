import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDuckDuckGo } from '../src/tools/websearch';
import { buildTools, type ProfileContext } from '../src/tools/profiles';
import { discoverSkills, skillsSection } from '../src/prompt/skills';
import type { ShellInfo } from '../src/tools/shell';

describe('web search results', () => {
  const html = `
    <div class="result results_links results_links_deep result--ad "><div class="links_main">
      <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=x">Sponsored</a></div></div>
    <div class="result results_links results_links_deep web-result "><div class="links_main links_deep result__body">
      <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvite.dev%2Fconfig%2Fserver%2Doptions&amp;rut=abc">Server Options | <b>Vite</b></a></h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Configure <b>proxy</b> rules &amp; &#x27;ws&#x27; for the dev server.</a>
    </div></div>
    <div class="result results_links web-result "><div class="links_main">
      <a class="result__a" href="https://stackoverflow.com/q/1">Proxy websockets</a>
    </div></div>`;

  it('reads titles, real links and snippets, and drops ads', () => {
    expect(parseDuckDuckGo(html)).toEqual([
      { title: 'Server Options | Vite', url: 'https://vite.dev/config/server-options', snippet: "Configure proxy rules & 'ws' for the dev server." },
      { title: 'Proxy websockets', url: 'https://stackoverflow.com/q/1', snippet: '' },
    ]);
  });
});

describe('tool surfaces', () => {
  const shell: ShellInfo = { kind: 'bash', path: 'bash', label: 'bash' } as ShellInfo;
  const base: ProfileContext = { shell, cwd: '.', timeoutMs: 1000, vision: true, role: 'main', search: 'off', screenshot: false };
  const names = (profile: 'claude' | 'codex', pc: Partial<ProfileContext>) => buildTools(profile, { ...base, ...pc }).map((b) => b.spec.name);

  it('offers Favilla\'s own search only where the provider has none', () => {
    expect(names('claude', { search: 'client' })).toContain('WebSearch');
    expect(names('claude', { search: 'hosted' })).not.toContain('WebSearch');
    expect(names('codex', { search: 'client' })).toContain('web_search');
    expect(names('codex', { search: 'hosted' })).not.toContain('web_search');
  });

  it('gives GPT models view_image and every surface the browser when one is installed', () => {
    expect(names('codex', {})).toContain('view_image');
    expect(names('codex', { vision: false })).not.toContain('view_image');
    expect(names('claude', { screenshot: true })).toContain('browser');
    expect(names('codex', { screenshot: true, role: 'explore' })).toEqual(expect.arrayContaining(['browser', 'read_file']));
  });
});

describe('skills', () => {
  it('lists skills with a description from the project folders, first name wins', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-skills-'));
    fs.mkdirSync(path.join(root, '.git'));
    const write = (dir: string, body: string) => {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, dir, 'SKILL.md'), body);
    };
    write('.favilla/skills/release', '---\nname: release\ndescription: Cut a release:\n  tag, changelog, publish.\n---\nSteps…');
    write('.claude/skills/release', '---\nname: release\ndescription: An older copy.\n---\n');
    write('.agents/skills/no-description', '---\nname: quiet\n---\n');
    try {
      const fwd = root.replace(/\\/g, '/');
      const found = discoverSkills(root).filter((s) => s.path.startsWith(fwd));
      expect(found).toEqual([
        { name: 'release', description: 'Cut a release: tag, changelog, publish.', path: `${fwd}/.favilla/skills/release/SKILL.md`, root: `${fwd}/.favilla/skills`, folder: 'release', project: true },
      ]);
      const section = skillsSection(found, 'Read');
      expect(section).toContain(`In ${fwd}/.favilla/skills (a skill's file is <skill>/SKILL.md there):\n- release: Cut a release: tag, changelog, publish.`);
      // An opening that only says when to use a skill goes, so the line says what it is for.
      expect(skillsSection([{ ...found[0], description: 'Use when the user asks for text-to-speech narration or voiceover.' }], 'Read')).toContain('- release: text-to-speech narration or voiceover.');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
