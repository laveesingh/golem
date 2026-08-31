// Thin Pi translation layer over Golem's shared typed-worker endpoint.
// Queueing, envelope validation, replay identity, and lifecycle semantics stay
// in the shared modules; this class owns only Pi primitives and observations.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  acceptTypedDelivery,
  claimTypedDelivery,
  closeTypedWorkerEndpoint,
  getTypedDelivery,
  interruptTypedDelivery,
  normalizeTypedWorkerInbox,
  releaseTypedDeliveryClaim,
  reportTypedDeliveryLifecycle,
  requireTypedDeliveryRecovery,
  settleTypedDelivery,
  startTypedWorkerEndpoint,
  typedDeliveryResult,
} from './typed-worker-endpoint.js';
import {
  readTypedDeliveryTombstone,
  upsertTypedDeliveryTombstone,
} from './typed-delivery-tombstones.js';
import {
  DEFAULT_LEASE_TTL_MS,
  releaseEndpointLeases,
  renewEndpointLease,
  upsertSessionFact,
} from './session-facts.js';
import { dashboardJsonPath, golemHome, journalDirFor } from './golem-home.js';
import { resolveGolemDashboardBaseUrl } from './golem-client.js';
import { upsertProject } from './session-registry.js';
import { projectIdFor, resolveProjectRoot } from './project-id.js';

const ADAPTER_SCHEMA = 1;
const ACCEPT_TIMEOUT_MS = 10_000;
const CONTROL_TIMEOUT_MS = 10_000;

function iso(value = Date.now()) { return new Date(value).toISOString(); }

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

export class PiNativeAdapter {
  constructor(pi, {
    home = golemHome(),
    ownerToken = crypto.randomUUID(),
    acceptTimeoutMs = ACCEPT_TIMEOUT_MS,
    controlTimeoutMs = CONTROL_TIMEOUT_MS,
    heartbeatIntervalMs = Math.max(1_000, Math.floor(DEFAULT_LEASE_TTL_MS / 3)),
  } = {}) {
    this.pi = pi;
    this.home = home;
    this.ownerToken = ownerToken;
    this.acceptTimeoutMs = acceptTimeoutMs;
    this.controlTimeoutMs = controlTimeoutMs;
    this.heartbeatIntervalMs = Math.max(1, Number(heartbeatIntervalMs) || 1);
    this.canonicalId = null;
    this.ctx = null;
    this.state = 'idle';
    this.endpoint = null;
    this.heartbeat = null;
    this.pendingAcceptance = null;
    this.pendingControl = null;
    this.latentControlKind = null;
    this.deferredInputs = [];
    this.activeDeferredInput = null;
    this.projectRoot = null;
    this.projectId = null;
    this.recordFile = null;
  }

  bind() {
    this.pi.on('session_start', (event, ctx) => this.sessionStart(event, ctx));
    this.pi.on('session_info_changed', (event, ctx) => this.observe(ctx, 'session_info_changed', this.presentationStatus(), { name: event.name }));
    this.pi.on('model_select', (event, ctx) => this.observe(ctx, 'model_select', this.presentationStatus(), {
      provider: event.model?.provider ?? null,
      model: event.model?.id ?? null,
      source: event.source ?? null,
    }));
    this.pi.on('input', (event, ctx) => this.input(event, ctx));
    this.pi.on('before_agent_start', (event, ctx) => this.beforeAgentStart(event, ctx));
    this.pi.on('agent_start', (event, ctx) => this.agentStart(event, ctx));
    this.pi.on('agent_settled', (event, ctx) => this.agentSettled(event, ctx));
    this.pi.on('tool_call', (event, ctx) => this.observe(ctx, 'tool_call', 'busy', { tool_name: event.toolName, tool_call_id: event.toolCallId }));
    this.pi.on('session_shutdown', (event, ctx) => this.sessionShutdown(event, ctx));
  }

  presentationStatus() {
    return this.state === 'active' ? 'busy' : this.state;
  }

  defaultRecord() {
    return { schema: ADAPTER_SCHEMA, canonical_id: this.canonicalId, inbox: normalizeTypedWorkerInbox(), deferred_inputs: [] };
  }

  readRecord() {
    const raw = readJson(this.recordFile, this.defaultRecord());
    return {
      ...this.defaultRecord(), ...raw,
      inbox: normalizeTypedWorkerInbox(raw?.inbox),
      deferred_inputs: Array.isArray(raw?.deferred_inputs)
        ? raw.deferred_inputs.filter((item) => item?.id && (typeof item.content === 'string' || Array.isArray(item.content)))
        : [],
    };
  }

  writeRecord(record) {
    atomicJson(this.recordFile, { ...record, schema: ADAPTER_SCHEMA, canonical_id: this.canonicalId, updated_at: iso() });
    return record;
  }

  persistDeferredInputs() {
    const record = this.readRecord();
    record.deferred_inputs = this.deferredInputs;
    this.writeRecord(record);
  }

  currentDelivery(record = this.readRecord()) {
    return record.inbox.in_flight_envelope_id
      ? getTypedDelivery(record.inbox, record.inbox.in_flight_envelope_id)
      : null;
  }

  deliveryReady() {
    const record = this.readRecord();
    const hasRecoveryRequired = record.inbox.deliveries.some(
      (d) => d.lifecycle_state === 'recovery_required',
    );
    return Boolean(
      this.endpoint && this.ctx
      && this.state !== 'stopping'
      && (!this.pendingControl || this.pendingControl.kind !== 'halt')
      && !hasRecoveryRequired,
    );
  }

  persistLease() {
    if (!this.endpoint || !this.canonicalId) return null;
    return renewEndpointLease({
      canonical_id: this.canonicalId,
      owner_token: this.ownerToken,
      host: this.endpoint.host,
      port: this.endpoint.port,
      pid: process.pid,
      harness: 'pi',
      transport: 'http',
      kind: 'typed-worker',
      delivery_ready: this.deliveryReady(),
    });
  }

  startHeartbeat() {
    this.heartbeat = setInterval(() => {
      try { this.persistLease(); } catch {}
      void this.flushTerminalReports();
    }, this.heartbeatIntervalMs);
    this.heartbeat.unref?.();
  }

  async sessionStart(event, ctx) {
    this.ctx = ctx;
    this.canonicalId = ctx.sessionManager.getSessionId();
    this.recordFile = path.join(this.home, 'pi-workers', this.canonicalId, 'delivery.json');
    this.projectRoot = await resolveProjectRoot(ctx.cwd);
    this.projectId = projectIdFor(this.projectRoot);
    try {
      upsertProject({
        id: this.projectId,
        root: this.projectRoot,
        observedAt: iso(),
        file: path.join(this.home, 'projects.json'),
      });
    } catch {}
    const record = this.readRecord();
    this.deferredInputs = record.deferred_inputs;
    const inFlight = this.currentDelivery(record);
    let recoveredDeliveryState = null;
    if (inFlight?.lifecycle_state === 'claimed') {
      releaseTypedDeliveryClaim(record.inbox, inFlight.envelope_id, { attemptId: inFlight.attempt_id, error: 'Pi restarted before correlated agent_start' });
      this.writeRecord(record);
      recoveredDeliveryState = 'pending';
    } else if (inFlight?.lifecycle_state === 'accepted') {
      const recovery = requireTypedDeliveryRecovery(record.inbox, inFlight.envelope_id, { error: 'Pi session restarted before agent_settled' });
      upsertTypedDeliveryTombstone(this.canonicalId, recovery.delivery);
      this.writeRecord(record);
      recoveredDeliveryState = 'recovery_required';
    }
    this.state = 'idle';
    this.endpoint = await startTypedWorkerEndpoint({
      canonicalId: this.canonicalId,
      ownerToken: this.ownerToken,
      deliveryReady: () => this.deliveryReady(),
      acceptDelivery: (envelope) => this.acceptEnvelope(envelope),
    });
    this.persistLease();
    this.startHeartbeat();
    this.observe(ctx, 'session_start', 'idle', {
      reason: event.reason,
      previous_session_file: event.previousSessionFile ?? null,
      endpoint_port: this.endpoint.port,
      delivery_state: recoveredDeliveryState,
    });
    await this.flushTerminalReports();
    if (this.deferredInputs.length) setImmediate(() => this.drainDeferredInput());
  }

  async acceptEnvelope(envelope) {
    if (envelope.kind === 'interrupt') return this.handleInterrupt(envelope);
    if (envelope.kind === 'halt') return this.handleHalt(envelope);
    // The dashboard persists role truth before publishing this control. Pi
    // rereads it when building the next turn's prompt, so role assignment is a
    // safe-boundary control and must never create an agent turn of its own.
    if (envelope.kind === 'role_assign') {
      this.observe(this.ctx, 'role_assign', this.presentationStatus());
      return this.controlResult(envelope);
    }
    const priorRecord = this.readRecord();
    const prior = getTypedDelivery(priorRecord.inbox, envelope.envelope_id)
      || readTypedDeliveryTombstone(this.canonicalId, envelope.envelope_id);
    if (prior) return typedDeliveryResult(prior, { duplicate: true, attemptId: envelope.attempt_id });
    if (!this.deliveryReady()) return { ok: false, accepted: false, http_status: 409, error: `Pi worker is ${this.state}` };

    if (this.state === 'starting') {
      return { ok: false, accepted: false, http_status: 409, error: 'Pi worker is starting' };
    }

    if (this.state === 'active' || (this.ctx && !this.ctx.isIdle())) {
      const record = this.readRecord();
      const claim = claimTypedDelivery(record.inbox, envelope, {
        lookupTombstone: (id) => readTypedDeliveryTombstone(this.canonicalId, id),
        allowInFlight: true,
      });
      if (claim.fenced) return { ok: false, accepted: false, http_status: 409, error: 'delivery predates replay fence' };
      if (claim.duplicate) {
        return typedDeliveryResult(claim.delivery, { duplicate: true, attemptId: envelope.attempt_id });
      }
      this.writeRecord(record);
      try {
        this.pi.sendUserMessage(envelope.content, { deliverAs: 'steer' });
      } catch (error) {
        releaseTypedDeliveryClaim(record.inbox, envelope.envelope_id, { attemptId: envelope.attempt_id, error: error?.message ?? String(error) });
        this.writeRecord(record);
        this.persistLease();
        return { ok: false, accepted: false, http_status: 503, error: error?.message ?? String(error) };
      }
      const accepted = acceptTypedDelivery(record.inbox, envelope.envelope_id, {
        turnId: this.ctx?.sessionManager?.getLeafId?.() ?? null,
      }).delivery;
      upsertTypedDeliveryTombstone(this.canonicalId, accepted);
      this.writeRecord(record);
      this.persistLease();
      this.observe(this.ctx, 'delivery_steered', 'busy', {
        envelope_id: envelope.envelope_id,
        attempt_id: envelope.attempt_id,
        delivery_state: 'accepted',
      });
      return typedDeliveryResult(accepted, { attemptId: envelope.attempt_id });
    }

    this.state = 'starting'; // synchronous reservation before any native call
    const record = this.readRecord();
    const claim = claimTypedDelivery(record.inbox, envelope, {
      lookupTombstone: (id) => readTypedDeliveryTombstone(this.canonicalId, id),
    });
    if (claim.fenced) { this.state = 'idle'; return { ok: false, accepted: false, http_status: 409, error: 'delivery predates replay fence' }; }
    if (claim.busy) { this.state = 'idle'; return { ok: false, accepted: false, http_status: 409, error: 'Pi worker already has in-flight work' }; }
    if (claim.duplicate) {
      this.state = claim.delivery.lifecycle_state === 'claimed' ? 'starting' : 'idle';
      return typedDeliveryResult(claim.delivery, { duplicate: true, attemptId: envelope.attempt_id });
    }
    this.writeRecord(record);
    this.observe(this.ctx, 'delivery_starting', 'starting', {
      envelope_id: envelope.envelope_id,
      attempt_id: envelope.attempt_id,
      delivery_state: 'starting',
    });

    let resolveAcceptance;
    const accepted = new Promise((resolve) => { resolveAcceptance = resolve; });
    const timer = setTimeout(() => {
      const latest = this.readRecord();
      const current = getTypedDelivery(latest.inbox, envelope.envelope_id);
      if (current?.lifecycle_state === 'claimed') {
        // sendUserMessage is fire-and-forget. Even before our input handler is
        // reached, Pi may be awaiting an earlier async input extension and can
        // still start later; only process shutdown proves that cannot happen.
        const disposition = requireTypedDeliveryRecovery(latest.inbox, envelope.envelope_id, {
          error: 'Pi did not emit agent_start before timeout after native injection',
        });
        upsertTypedDeliveryTombstone(this.canonicalId, disposition.delivery);
        this.writeRecord(latest);
        this.pendingAcceptance.timedOut = true;
        this.pendingAcceptance.timer = null;
        this.state = 'active';
        this.persistLease();
        this.observe(this.ctx, 'delivery_recovery_required', 'busy', {
          envelope_id: envelope.envelope_id,
          attempt_id: envelope.attempt_id,
          delivery_state: 'recovery_required',
        });
        resolveAcceptance(typedDeliveryResult(disposition.delivery, { attemptId: envelope.attempt_id }));
        if (this.pendingControl) {
          this.latentControlKind = this.pendingControl.kind;
          this.finishControl(this.pendingControl, {
            ok: false, accepted: false, http_status: 503,
            error: 'Pi control could not settle native preflight before timeout',
          });
        }
      }
    }, this.acceptTimeoutMs);
    timer.unref?.();
    this.pendingAcceptance = {
      envelopeId: envelope.envelope_id,
      attemptId: envelope.attempt_id,
      content: envelope.content,
      resolve: resolveAcceptance,
      timer,
      inputSeen: false,
    };
    try {
      this.pi.sendUserMessage(envelope.content);
    } catch (error) {
      clearTimeout(timer);
      this.pendingAcceptance = null;
      const latest = this.readRecord();
      releaseTypedDeliveryClaim(latest.inbox, envelope.envelope_id, { attemptId: envelope.attempt_id, error: error?.message ?? String(error) });
      this.writeRecord(latest);
      this.state = 'idle';
      this.persistLease();
      this.observe(this.ctx, 'delivery_rejected', 'idle', {
        envelope_id: envelope.envelope_id,
        attempt_id: envelope.attempt_id,
        delivery_state: 'pending',
      });
      return { ok: false, accepted: false, http_status: 503, error: error?.message ?? String(error) };
    }
    // Issue #34 (GOL-296): queued-accept. The native injection was queued into
    // Pi's input stream (sendUserMessage succeeded), so the endpoint reports
    // the delivery immediately (`accepted: true` over the 'claimed' lifecycle)
    // instead of holding the HTTP response until the input handler starts the
    // turn (up to ACCEPT_TIMEOUT_MS). The pendingAcceptance guard below keeps
    // crash-replay safety (a claim released for replay on session restart)
    // and the 10s recovery tombstones a message Pi never consumes.
    this.persistLease();
    return { ...typedDeliveryResult(claim.delivery, { attemptId: envelope.attempt_id }), accepted: true, accepted_attempt_id: envelope.attempt_id };
  }

  input(event, ctx) {
    this.ctx = ctx;
    // Pi emits input before agent_start. Reserve the single native turn for
    // every source so an interactive or migration turn cannot race a typed
    // delivery through the pre-agent gap.
    if (this.state === 'idle') this.state = 'starting';
    if (this.pendingAcceptance) {
      if (event.source === 'extension' && event.text === this.pendingAcceptance.content) {
        this.pendingAcceptance.inputSeen = true;
      } else {
        // agent_start carries no turn identity in Pi 0.80.10. Do not allow an
        // unrelated prompt to create an ambiguous start while typed preflight
        // owns the slot; retain it and replay after the typed turn settles.
        this.deferredInputs.push({
          id: crypto.randomUUID(),
          content: event.images?.length ? [{ type: 'text', text: event.text }, ...event.images] : event.text,
        });
        this.persistDeferredInputs();
        this.persistLease();
        return { action: 'handled' };
      }
    } else if (this.activeDeferredInput) {
      const expectedText = typeof this.activeDeferredInput.content === 'string'
        ? this.activeDeferredInput.content
        : this.activeDeferredInput.content.find((part) => part.type === 'text')?.text ?? '';
      if (event.source === 'extension' && event.text === expectedText) {
        this.activeDeferredInput.inputSeen = true;
      } else {
        this.deferredInputs.push({
          id: crypto.randomUUID(),
          content: event.images?.length ? [{ type: 'text', text: event.text }, ...event.images] : event.text,
        });
        this.persistDeferredInputs();
        this.persistLease();
        return { action: 'handled' };
      }
    }
    this.persistLease();
    // Legacy next-turn migration is intentionally left to the old input reader
    // until the dashboard cutover slice stops publishing new records.
  }

  beforeAgentStart(event, ctx) {
    this.ctx = ctx;
    if (this.pendingAcceptance) {
      this.pendingAcceptance.nextStartOwned = this.pendingAcceptance.inputSeen
        && event.prompt === this.pendingAcceptance.content;
    }
    if (this.activeDeferredInput) {
      const expectedText = typeof this.activeDeferredInput.content === 'string'
        ? this.activeDeferredInput.content
        : this.activeDeferredInput.content.find((part) => part.type === 'text')?.text ?? '';
      this.activeDeferredInput.nextStartOwned = this.activeDeferredInput.inputSeen
        && event.prompt === expectedText;
    }
  }

  async agentStart(_event, ctx) {
    this.ctx = ctx;
    this.state = 'active';
    if (this.pendingControl) {
      try { ctx.abort(); } catch {}
    }
    const pending = this.pendingAcceptance;
    if (pending) {
      const record = this.readRecord();
      if (pending.nextStartOwned) {
        clearTimeout(pending.timer);
        this.pendingAcceptance = null;
        const current = getTypedDelivery(record.inbox, pending.envelopeId);
        if (current?.lifecycle_state === 'claimed') {
          const accepted = acceptTypedDelivery(record.inbox, pending.envelopeId, { turnId: ctx.sessionManager.getLeafId?.() ?? null }).delivery;
          upsertTypedDeliveryTombstone(this.canonicalId, accepted);
          this.writeRecord(record);
          pending.resolve(typedDeliveryResult(accepted, { attemptId: pending.attemptId }));
        }
        // abort() during idle preflight is a no-op in Pi 0.80.10. Repeat it at
        // the first native boundary that guarantees an active agent run.
        if (this.pendingControl) {
          try { ctx.abort(); } catch {}
        }
      } else {
        const current = getTypedDelivery(record.inbox, pending.envelopeId);
        if (current?.lifecycle_state === 'claimed') {
          const recovery = requireTypedDeliveryRecovery(record.inbox, pending.envelopeId, {
            error: 'A different Pi input reached agent_start after native typed injection',
          }).delivery;
          upsertTypedDeliveryTombstone(this.canonicalId, recovery);
          this.writeRecord(record);
          pending.resolve(typedDeliveryResult(recovery, { attemptId: pending.attemptId }));
          pending.publisherResolved = true;
          pending.displaced = true;
          await this.reportTerminal(recovery);
        }
        // This aborts the unrelated turn, but control cannot settle until the
        // delayed typed preflight reaches its own agent_start and settlement.
        if (this.pendingControl) {
          try { ctx.abort(); } catch {}
        }
      }
    }
    if (!pending && this.activeDeferredInput?.nextStartOwned) {
      const completedId = this.activeDeferredInput.id;
      this.deferredInputs = this.deferredInputs.filter((item) => item.id !== completedId);
      this.activeDeferredInput = null;
      this.persistDeferredInputs();
    } else if (!pending && this.activeDeferredInput) {
      // Another extension can trigger an agent turn without an input event.
      // It cannot own or dequeue this replayed item.
      this.activeDeferredInput.displaced = true;
      try { ctx.abort(); } catch {}
    }
    if (this.latentControlKind) {
      try { ctx.abort(); } catch {}
    }
    this.persistLease();
    this.observe(ctx, 'agent_start', 'busy', { delivery_state: 'accepted' });
  }

  async agentSettled(_event, ctx) {
    this.ctx = ctx;
    if (this.activeDeferredInput?.displaced) {
      this.state = 'starting';
      this.persistLease();
      this.observe(ctx, 'agent_settled', 'starting', { awaiting_deferred_input_start: true });
      return;
    }
    if (this.pendingAcceptance?.displaced) {
      // An unrelated native turn settled while the fire-and-forget typed
      // prompt has not reached its own agent_start. Exact input may already be
      // observed while the unrelated turn is active; only typed agent_start
      // clears this lineage. Keep ownership and any control waiter.
      this.state = 'starting';
      this.persistLease();
      this.observe(ctx, 'agent_settled', 'starting', { awaiting_typed_preflight: true });
      return;
    }
    if (this.pendingAcceptance) {
      const pending = this.pendingAcceptance;
      clearTimeout(pending.timer);
      this.pendingAcceptance = null;
      const unaccepted = this.readRecord();
      const recovery = requireTypedDeliveryRecovery(unaccepted.inbox, pending.envelopeId, {
        error: 'Pi settled without a correlated agent_start after native injection',
      }).delivery;
      upsertTypedDeliveryTombstone(this.canonicalId, recovery);
      this.writeRecord(unaccepted);
      pending.resolve(typedDeliveryResult(recovery, { attemptId: pending.attemptId }));
      await this.reportTerminal(recovery);
    }
    const record = this.readRecord();
    const control = this.pendingControl;
    const controlKind = control?.kind ?? this.latentControlKind;
    const activeDeliveries = record.inbox.deliveries.filter((d) => d.lifecycle_state === 'accepted');
    for (const delivery of activeDeliveries) {
      if (controlKind) {
        const interrupted = interruptTypedDelivery(record.inbox, delivery.envelope_id, {
          turnId: ctx.sessionManager.getLeafId?.() ?? delivery.turn_id,
          completionStatus: controlKind === 'halt' ? 'halted' : 'aborted',
        }).delivery;
        upsertTypedDeliveryTombstone(this.canonicalId, interrupted);
        await this.reportTerminal(interrupted);
      } else {
        const settled = settleTypedDelivery(record.inbox, delivery.envelope_id, {
          turnId: ctx.sessionManager.getLeafId?.() ?? delivery.turn_id,
          completionStatus: 'settled',
        }).delivery;
        upsertTypedDeliveryTombstone(this.canonicalId, settled);
        await this.reportTerminal(settled);
      }
    }
    record.inbox.in_flight_envelope_id = null;
    this.writeRecord(record);
    if (control) this.finishControl(control);
    else if (this.latentControlKind) {
      this.latentControlKind = null;
      if (this.state !== 'stopping') this.state = 'idle';
    }
    else if (this.state !== 'stopping') this.state = 'idle';
    this.persistLease();
    this.observe(ctx, 'agent_settled', this.state === 'stopping' ? 'stopping' : 'idle', {
      delivery_state: controlKind ? (controlKind === 'halt' ? 'halted' : 'interrupted') : activeDeliveries.length ? 'settled' : null,
    });
    if (this.state === 'idle') setImmediate(() => this.drainDeferredInput());
  }

  drainDeferredInput() {
    if (this.state !== 'idle' || this.pendingAcceptance || this.pendingControl || !this.deferredInputs.length) return;
    const item = this.deferredInputs[0];
    const content = item.content;
    this.activeDeferredInput = { ...item, inputSeen: false };
    this.state = 'starting';
    this.persistLease();
    try { this.pi.sendUserMessage(content); } catch {
      this.activeDeferredInput = null;
      this.state = 'idle';
      this.persistLease();
      if (this.deferredInputs.length) setImmediate(() => this.drainDeferredInput());
    }
  }

  async handleInterrupt(envelope) {
    return this.control(envelope, 'interrupt');
  }

  async handleHalt(envelope) {
    return this.control(envelope, 'halt');
  }

  controlResult(envelope) {
    return {
      ok: true, accepted: true, http_status: 200,
      envelope_id: envelope.envelope_id,
      attempt_id: envelope.attempt_id,
      accepted_attempt_id: envelope.attempt_id,
      delivery_state: 'settled', turn_id: null,
    };
  }

  async control(envelope, kind) {
    if (this.pendingControl) {
      return { ok: false, accepted: false, http_status: 409, error: 'Pi worker already has a pending control request' };
    }
    if (kind === 'halt') this.state = 'stopping';

    // From the native call boundary onward, fire-and-forget Pi preflight may
    // still advance even if our input observer has not run. Retain ownership
    // until agent_start/settlement or confirmed process shutdown.
    const nativePreflight = Boolean(this.pendingAcceptance);

    const record = this.readRecord();
    const active = this.currentDelivery(record);
    const nativeBusy = this.ctx && !this.ctx.isIdle();
    if (!nativePreflight && !nativeBusy && active?.lifecycle_state !== 'accepted') {
      if (kind !== 'halt') this.state = 'idle';
      this.persistLease();
      if (kind === 'halt') setImmediate(() => this.ctx?.shutdown());
      return this.controlResult(envelope);
    }

    let resolveControl;
    const settled = new Promise((resolve) => { resolveControl = resolve; });
    const control = { envelope, kind, resolve: resolveControl, timer: null };
    control.timer = setTimeout(() => { void this.controlTimeout(control); }, this.controlTimeoutMs);
    control.timer.unref?.();
    this.pendingControl = control;
    try { this.ctx?.abort(); } catch {}
    return settled;
  }

  finishControl(control, result = this.controlResult(control.envelope)) {
    if (this.pendingControl !== control) return;
    clearTimeout(control.timer);
    this.pendingControl = null;
    if (control.kind === 'halt') {
      this.state = 'stopping';
      // The endpoint must serialize the disposition before shutdown closes it.
      setImmediate(() => this.ctx?.shutdown());
    } else {
      this.state = 'idle';
    }
    this.persistLease();
    control.resolve(result);
  }

  async controlTimeout(control) {
    if (this.pendingControl !== control) return;
    const record = this.readRecord();
    const active = this.currentDelivery(record);
    if (active?.lifecycle_state === 'accepted'
      || (active?.lifecycle_state === 'claimed' && this.pendingAcceptance)) {
      const recovery = requireTypedDeliveryRecovery(record.inbox, active.envelope_id, {
        error: `Pi did not observe ${control.kind} settlement before timeout`,
      }).delivery;
      upsertTypedDeliveryTombstone(this.canonicalId, recovery);
      this.writeRecord(record);
      if (this.pendingAcceptance) {
        const pending = this.pendingAcceptance;
        clearTimeout(pending.timer);
        pending.timedOut = true;
        pending.timer = null;
        pending.resolve(typedDeliveryResult(recovery, { attemptId: pending.attemptId }));
      }
      await this.reportTerminal(recovery);
    }
    this.latentControlKind = control.kind;
    this.finishControl(control, {
      ok: false, accepted: false, http_status: 503,
      error: `Pi did not settle after ${control.kind} before timeout`,
    });
  }

  async reportTerminal(delivery) {
    return reportTypedDeliveryLifecycle({
      baseUrl: resolveGolemDashboardBaseUrl({ dashboardFile: dashboardJsonPath() }), canonicalId: this.canonicalId,
      ownerToken: this.ownerToken, delivery,
    });
  }

  async flushTerminalReports() {
    const record = this.readRecord();
    for (const delivery of record.inbox.deliveries) {
      if (['settled', 'interrupted', 'recovery_required'].includes(delivery.lifecycle_state)) await this.reportTerminal(delivery);
    }
  }

  observe(ctx, event, status, observations = {}) {
    if (!this.canonicalId) return;
    const model = ctx.model;
    const observedAt = iso();
    const terminal = ['dead', 'stopped', 'failed', 'superseded'].includes(String(status).toLowerCase());
    const fact = upsertSessionFact({
      canonical_id: this.canonicalId,
      continuation_key: this.canonicalId,
      harness: 'pi',
      locator: { raw_session_id: this.canonicalId, session_file: ctx.sessionManager.getSessionFile() },
      project_path: this.projectRoot || ctx.cwd,
      name: ctx.sessionManager.getSessionName(),
      status,
      provider: model?.provider ?? null,
      model: model?.id ?? null,
      delivery: { mode: 'typed-worker', push: true, ready: this.deliveryReady() },
      capabilities: { typed_worker: true },
      trust: 'host-full-trust',
      lifecycle_event: event,
      ended_at: terminal ? observedAt : null,
      observations: {
        adapter_state: this.state,
        launch_nonce: process.env.GOLEM_PI_LAUNCH_NONCE || null,
        pi_version: process.env.GOLEM_PI_VERSION || null,
        extension_version: process.env.GOLEM_PI_EXTENSION_VERSION || null,
        ...observations,
      },
      observed_at: observedAt,
    });
    this.appendJournal(event, observations);
    return fact;
  }

  appendJournal(event, payload = {}) {
    if (!this.projectId || !this.projectRoot) return;
    try {
      const dir = journalDirFor(this.projectId);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'hook.jsonl'), `${JSON.stringify({
        ts: iso(), event, session_id: this.canonicalId, cwd: this.ctx?.cwd,
        project_id: this.projectId, project_path: this.projectRoot,
        payload: { harness: 'pi', ...payload },
      })}\n`, { mode: 0o600 });
    } catch {}
  }

  async sessionShutdown(event, ctx) {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const record = this.recordFile ? this.readRecord() : null;
    const active = record ? this.currentDelivery(record) : null;
    if (active?.lifecycle_state === 'claimed') {
      releaseTypedDeliveryClaim(record.inbox, active.envelope_id, { attemptId: active.attempt_id, error: `Pi shutdown before acceptance (${event.reason})` });
      this.writeRecord(record);
    } else if (active?.lifecycle_state === 'accepted') {
      const recovery = requireTypedDeliveryRecovery(record.inbox, active.envelope_id, { error: `Pi shutdown before settlement (${event.reason})` });
      upsertTypedDeliveryTombstone(this.canonicalId, recovery.delivery);
      this.writeRecord(record);
      await this.reportTerminal(recovery.delivery);
    }
    if (this.pendingAcceptance) {
      clearTimeout(this.pendingAcceptance.timer);
      this.pendingAcceptance.resolve({ ok: false, accepted: false, http_status: 503, error: 'Pi session shut down before acceptance' });
      this.pendingAcceptance = null;
    }
    if (this.pendingControl) {
      const control = this.pendingControl;
      clearTimeout(control.timer);
      this.pendingControl = null;
      control.resolve({ ok: false, accepted: false, http_status: 503, error: 'Pi session shut down before control settlement' });
    }
    this.latentControlKind = null;
    // Durable retirement must precede transport removal. Otherwise the
    // dashboard can observe a fresh non-terminal fact after the lease is gone
    // and briefly resurrect the worker as a channel-offline zombie.
    this.state = 'stopping';
    this.observe(ctx, 'session_shutdown', 'stopped', { reason: event.reason, target_session_file: event.targetSessionFile ?? null });
    releaseEndpointLeases(this.ownerToken, { canonicalId: this.canonicalId });
    await closeTypedWorkerEndpoint(this.endpoint?.server);
    this.endpoint = null;
  }
}
