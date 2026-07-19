import {
  isProvenDisappearanceObservation,
  isSafeCandidateObservation,
} from './candidate.mjs';

const VERIFICATION_WINDOW_MS = 30_000;
const CONTINUATION_SIGNATURE = 'continuation_signature';

export class ContinueWatcher {
  constructor({ mode, maxContinueClicks = 3, now = Date.now, clickCandidate, logger }) {
    if (mode !== 'dry-run' && mode !== 'live') {
      throw new TypeError('Watcher mode must be dry-run or live');
    }
    if (!Number.isSafeInteger(maxContinueClicks) || maxContinueClicks < 1 || maxContinueClicks > 3) {
      throw new TypeError('maxContinueClicks must be between 1 and 3');
    }
    if (typeof clickCandidate !== 'function') throw new TypeError('clickCandidate is required');
    if (typeof logger?.event !== 'function') throw new TypeError('logger.event is required');

    this.mode = mode;
    this.maxContinueClicks = maxContinueClicks;
    this.now = now;
    this.clickCandidate = clickCandidate;
    this.logger = logger;
    this.state = {
      sessionLedgers: new Map(),
      stableCandidate: undefined,
      invokedCandidateKeys: new Set(),
      inFlight: undefined,
      blockedContinuation: new Map(),
    };
  }

  ledger(sessionKey) {
    if (!this.state.sessionLedgers.has(sessionKey)) {
      this.state.sessionLedgers.set(sessionKey, {
        continueClicks: 0,
        exhaustedReported: false,
      });
    }
    return this.state.sessionLedgers.get(sessionKey);
  }

  async emit(event, identity, reason) {
    const ledger = identity?.sessionKey
      ? this.state.sessionLedgers.get(identity.sessionKey)
      : undefined;
    await this.logger.event({
      event,
      sessionKey: identity?.sessionKey,
      candidateKey: identity?.candidateKey,
      reason,
      continueClicks: ledger?.continueClicks ?? 0,
      maxContinueClicks: this.maxContinueClicks,
    });
  }

  resetStability() {
    this.state.stableCandidate = undefined;
  }

  get verificationSessionKey() {
    return this.state.inFlight?.sessionKey;
  }

  async failVerification(reason) {
    const inFlight = this.state.inFlight;
    this.state.inFlight = undefined;
    this.resetStability();

    const existing = this.state.blockedContinuation.get(inFlight.sessionKey);
    const reported = existing?.reported === true;
    this.state.blockedContinuation.set(inFlight.sessionKey, {
      signature: CONTINUATION_SIGNATURE,
      reason,
      reported: true,
    });
    if (!reported) {
      await this.emit('manual_intervention_required', inFlight, reason);
      return 'manual_intervention_required';
    }
    return 'blocked';
  }

  async succeedVerification(inFlight) {
    this.state.inFlight = undefined;
    this.state.blockedContinuation.delete(inFlight.sessionKey);
    this.resetStability();
    await this.emit('verification_succeeded', inFlight);
    return 'verification_succeeded';
  }

  async verifyInFlight(observation) {
    const inFlight = this.state.inFlight;

    if (observation?.kind === 'unsafe') {
      return this.failVerification('verification_unsafe');
    }
    const safeCandidate = isSafeCandidateObservation(observation);
    if (safeCandidate && observation.sessionKey !== inFlight.sessionKey) {
      return this.failVerification('verification_confirmation_lost');
    }
    if (observation?.kind === 'candidate' && !safeCandidate) {
      return this.failVerification('verification_confirmation_lost');
    }
    if (observation?.kind !== 'candidate' && observation?.kind !== 'none') {
      return this.failVerification('verification_confirmation_lost');
    }
    if (this.now() >= inFlight.deadlineMs) {
      return this.failVerification('verification_timeout');
    }

    if (safeCandidate) return 'waiting';

    if (isProvenDisappearanceObservation(observation)
      && observation.sessionKey === inFlight.sessionKey) {
      return this.succeedVerification(inFlight);
    }

    if (observation?.kind === 'none') return 'waiting';
    return this.failVerification('verification_confirmation_lost');
  }

  async processDryRun(observation) {
    if (!isSafeCandidateObservation(observation)) {
      this.resetStability();
      return 'waiting';
    }

    if (this.state.stableCandidate?.candidateKey === observation.candidateKey) {
      this.state.stableCandidate.consecutiveScans += 1;
      return 'waiting';
    }

    this.state.stableCandidate = {
      candidateKey: observation.candidateKey,
      consecutiveScans: 1,
    };
    await this.emit('candidate_observed', observation);
    await this.emit('would_continue', observation);
    return 'would_continue';
  }

  async processLive(observation) {
    if (!isSafeCandidateObservation(observation)) {
      if (isProvenDisappearanceObservation(observation)) {
        this.state.blockedContinuation.delete(observation.sessionKey);
      }
      this.resetStability();
      return 'waiting';
    }

    const ledger = this.ledger(observation.sessionKey);
    if (this.state.blockedContinuation.has(observation.sessionKey)) {
      this.resetStability();
      return 'blocked';
    }

    if (ledger.continueClicks >= this.maxContinueClicks) {
      this.resetStability();
      if (this.state.invokedCandidateKeys.has(observation.candidateKey)) return 'blocked';
      if (!ledger.exhaustedReported) {
        ledger.exhaustedReported = true;
        await this.emit('manual_intervention_required', observation, 'click_cap_exhausted');
        return 'manual_intervention_required';
      }
      return 'blocked';
    }

    if (this.state.stableCandidate?.candidateKey !== observation.candidateKey) {
      this.state.stableCandidate = {
        candidateKey: observation.candidateKey,
        consecutiveScans: 1,
      };
      await this.emit('candidate_observed', observation);
      return 'waiting';
    }

    this.state.stableCandidate.consecutiveScans += 1;
    if (this.state.stableCandidate.consecutiveScans < 2) return 'waiting';
    this.resetStability();

    if (this.state.invokedCandidateKeys.has(observation.candidateKey)) return 'blocked';

    const inFlight = {
      sessionKey: observation.sessionKey,
      candidateKey: observation.candidateKey,
      originalPromptBackendId: observation.prompt.backendNodeId,
      deadlineMs: undefined,
    };
    this.state.blockedContinuation.set(observation.sessionKey, {
      signature: CONTINUATION_SIGNATURE,
      reason: 'verification_pending',
      reported: false,
    });
    this.state.inFlight = inFlight;
    this.state.invokedCandidateKeys.add(observation.candidateKey);

    try {
      await this.clickCandidate({
        candidateKey: observation.candidateKey,
        backendNodeId: observation.continueButton.backendNodeId,
      });
    } catch {
      return this.failVerification('click_failed');
    }

    inFlight.deadlineMs = this.now() + VERIFICATION_WINDOW_MS;
    ledger.continueClicks += 1;
    await this.emit('click_invoked', observation);
    return 'click_invoked';
  }

  async processObservation(observation) {
    if (this.state.inFlight) return this.verifyInFlight(observation);
    if (this.mode === 'dry-run') return this.processDryRun(observation);
    return this.processLive(observation);
  }
}
