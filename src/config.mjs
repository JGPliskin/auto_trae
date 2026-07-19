const DEFAULT_PORT = 39240;
const DEFAULT_POLL_MS = 1500;
const DEFAULT_MAX_CONTINUE_CLICKS = 3;
const DEFAULT_LOG_FILE = 'logs/trae-auto-continue.jsonl';

export const usage = `Usage: node src/cli.mjs [options]

Options:
  --enable
  --once
  --port <1..65535>
  --poll-ms <250..60000>
  --max-continue-clicks <1..3>
  --log-file <path>
  --help`;

function usageError(message) {
  return new Error(`Usage: ${message}`);
}

function integerValue(value, name, minimum, maximum) {
  if (!/^\d+$/.test(value)) {
    throw usageError(`${name} must be an integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw usageError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

export function endpointFor(port) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw usageError('port must be a valid TCP port');
  }
  return `http://127.0.0.1:${port}`;
}

export function parseArgs(argv) {
  let port = DEFAULT_PORT;
  let enable = false;
  let maxContinueClicks = DEFAULT_MAX_CONTINUE_CLICKS;
  let pollMs = DEFAULT_POLL_MS;
  let once = false;
  let logFile = DEFAULT_LOG_FILE;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--enable') {
      enable = true;
    } else if (flag === '--once') {
      once = true;
    } else if (flag === '--port' || flag === '--poll-ms' || flag === '--max-continue-clicks' || flag === '--log-file') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw usageError(`${flag} requires a value`);
      }
      index += 1;
      if (flag === '--port') port = integerValue(value, 'port', 1, 65535);
      if (flag === '--poll-ms') pollMs = integerValue(value, 'poll interval', 250, 60000);
      if (flag === '--max-continue-clicks') maxContinueClicks = integerValue(value, 'max continue clicks', 1, 3);
      if (flag === '--log-file') {
        if (value.length === 0) throw usageError('log file must not be empty');
        logFile = value;
      }
    } else {
      throw usageError(`unknown option: ${flag}`);
    }
  }

  return { endpoint: endpointFor(port), enable, maxContinueClicks, pollMs, once, logFile };
}
