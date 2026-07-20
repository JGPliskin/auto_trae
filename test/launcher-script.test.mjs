import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../scripts/start-trae-cdp.ps1', import.meta.url));

function psQuote(value) {
  return value.replaceAll("'", "''");
}

test('launcher source parses without running the launcher', () => {
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

test('launcher source refuses the exact executable path and only starts loopback CDP without process disruption', () => {
  const source = readFileSync(scriptPath, 'utf8');

  assert.match(source, /Resolve-Path\s+-LiteralPath\s+\$TraePath/);
  assert.match(source, /\$_\.ExecutablePath[\s\S]*\$resolvedPath[\s\S]*OrdinalIgnoreCase/);
  assert.match(source, /if\s*\(\$existingProcess\)[\s\S]*exit\s+1/);
  assert.match(source, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(source, /--remote-debugging-port=\$Port/);
  assert.doesNotMatch(source, /\b(?:Stop-Process|Restart-Computer|taskkill|kill)\b/i);
});
