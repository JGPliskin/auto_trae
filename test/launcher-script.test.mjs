import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
