import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../scripts/start-watcher-supervisor.ps1', import.meta.url));

function psQuote(value) {
  return value.replaceAll("'", "''");
}

test('watcher supervisor launcher parses without starting anything', () => {
  const command =
    "$ErrorActionPreference = 'Stop'; " +
    "$source = [System.IO.File]::ReadAllText('" + psQuote(scriptPath) + "'); " +
    '[void][ScriptBlock]::Create($source)';

  const output = execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8' },
  );

  assert.equal(output, '');
});

test('watcher supervisor launcher starts only a hidden supervisor and never stops Trae', () => {
  const source = readFileSync(scriptPath, 'utf8');

  assert.match(source, /src[\\/]supervisor\.mjs/);
  assert.match(source, /Start-Process/);
  assert.match(source, /-WindowStyle\s+Hidden/);
  assert.doesNotMatch(source, /--remote-debugging/);
  assert.doesNotMatch(source, /\b(?:Stop-Process|Restart-Computer|taskkill|kill)\b/i);
});

test('watcher supervisor launcher defaults to seven clicks and a thirty-second poll', () => {
  const source = readFileSync(scriptPath, 'utf8');

  assert.match(source, /\[int\]\$PollMs\s*=\s*30000/);
  assert.match(source, /\[int\]\$MaxContinueClicks\s*=\s*7/);
  assert.doesNotMatch(source, /ValidateRange\(250,\s*60000\)/);
  assert.doesNotMatch(source, /ValidateRange\(1,\s*3\)/);
});
