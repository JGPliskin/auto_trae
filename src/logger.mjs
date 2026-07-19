import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const EVENT_CODES = new Set([
  'candidate_observed',
  'would_continue',
  'click_invoked',
  'verification_succeeded',
  'manual_intervention_required',
  'connection_state_changed',
]);

const STATE_EVENTS = new Set([
  'candidate_observed',
  'connection_state_changed',
]);

const MANUAL_REASON_CODES = new Set([
  'click_cap_exhausted',
  'click_failed',
  'verification_confirmation_lost',
  'verification_timeout',
  'verification_unsafe',
]);

const CONNECTION_STATES = new Set([
  'connected',
  'disconnected',
  'reconnecting',
  'unavailable',
]);

const CONNECTION_REASON_CODES = new Set([
  'aborted',
  'connection_failed',
  'discovery_failed',
  'request_timeout',
  'socket_closed',
  'target_ambiguous',
  'target_unavailable',
]);

function opaqueId(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const digest = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24);
  return `sha256:${digest}`;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function definedEntries(entries) {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

export class JsonlLogger {
  constructor({ file, mode, now = Date.now }) {
    if (typeof file !== 'string' || file.length === 0) throw new TypeError('Log file is required');
    if (mode !== 'dry-run' && mode !== 'live') throw new TypeError('Log mode must be dry-run or live');
    this.file = file;
    this.mode = mode;
    this.now = now;
    this.lastStateFingerprint = new Map();
    this.pendingWrite = Promise.resolve();
  }

  event(payload) {
    if (!EVENT_CODES.has(payload?.event)) {
      return Promise.reject(new TypeError('Unsupported log event'));
    }
    if (payload.event === 'manual_intervention_required') {
      if (!MANUAL_REASON_CODES.has(payload.reason)) {
        return Promise.reject(new TypeError('Unsupported reason code'));
      }
    } else if (payload.reason !== undefined && (
      payload.event !== 'connection_state_changed'
      || !CONNECTION_REASON_CODES.has(payload.reason)
    )) {
      return Promise.reject(new TypeError('Unsupported reason code'));
    }
    if (payload.connectionState !== undefined && (
      payload.event !== 'connection_state_changed'
      || !CONNECTION_STATES.has(payload.connectionState)
    )) {
      return Promise.reject(new TypeError('Unsupported connection state'));
    }

    const candidateEvent = payload.event !== 'connection_state_changed';
    const entry = definedEntries([
      ['timestamp', new Date(this.now()).toISOString()],
      ['event', payload.event],
      ['mode', this.mode],
      ['target_id', opaqueId(payload.targetId)],
      ['session_id', opaqueId(payload.sessionKey)],
      ['candidate_id', opaqueId(payload.candidateKey)],
      ['continuation_signature', candidateEvent ? 'continuation_signature' : undefined],
      ['connection_state', payload.connectionState],
      ['reason', payload.reason],
      ['continue_clicks', count(payload.continueClicks)],
      ['max_continue_clicks', count(payload.maxContinueClicks)],
    ]);

    if (STATE_EVENTS.has(payload.event)) {
      const fingerprint = JSON.stringify({ ...entry, timestamp: undefined });
      if (this.lastStateFingerprint.get(payload.event) === fingerprint) return Promise.resolve(false);
      this.lastStateFingerprint.set(payload.event, fingerprint);
    }

    const write = async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
      return true;
    };
    this.pendingWrite = this.pendingWrite.then(write);
    return this.pendingWrite;
  }
}
