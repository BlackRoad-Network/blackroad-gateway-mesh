import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertNoSecrets, sha256 } from "./store.mjs";

const AGENT = /^(connector-orchestrator|agent-instance-[1-6])$/;
const MUTATING = new Set(["WRITE", "COMMUNICATE", "DEPLOY", "ADMIN", "SECRET", "PUBLIC_EXPOSE"]);
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMEOUT_UNKNOWN", "CANCELLED"]);

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${randomUUID()}`;
const clone = (value) => JSON.parse(JSON.stringify(value));

function requireAgent(agentId) {
  if (!AGENT.test(agentId ?? "")) throw new Error("invalid-agent-id");
}

function substitute(value, parameters) {
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, parameters));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substitute(entry, parameters)]));
  }
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([a-zA-Z0-9_.-]+)\}/g, (_, key) => {
    if (!(key in parameters)) throw new Error(`missing-template-parameter:${key}`);
    return String(parameters[key]);
  });
}

export class CollaborationBroker {
  constructor({ store, templatesPath, heartbeatTtlSeconds = 180 }) {
    this.store = store;
    this.templatesPath = templatesPath;
    this.heartbeatTtlMs = heartbeatTtlSeconds * 1000;
  }

  async templates() {
    const raw = JSON.parse(await readFile(resolve(this.templatesPath), "utf8"));
    return raw.templates ?? [];
  }

  async status() {
    const state = await this.store.read();
    const sessions = Object.values(state.sessions ?? {});
    const online = sessions.filter((session) => this.#sessionIsLive(session));
    return {
      schema: state.schema,
      generation: state.generation,
      eventHead: state.eventHead,
      counts: {
        sessions: sessions.length,
        onlineSessions: online.length,
        workflows: Object.keys(state.workflows ?? {}).length,
        workItems: Object.keys(state.workItems ?? {}).length,
        delegations: Object.keys(state.delegations ?? {}).length,
        notifications: Object.keys(state.notifications ?? {}).length
      }
    };
  }

  async heartbeat({ agentId, sessionRef, runtime = "claude-workspace", provider = "anthropic" }) {
    requireAgent(agentId);
    if (!sessionRef) throw new Error("session-ref-required");
    return (await this.store.transact(
      { actor: agentId, type: "session.heartbeat", data: { sessionRef, runtime, provider } },
      (state) => {
        const previous = state.sessions[sessionRef];
        if (previous && previous.agentId !== agentId) throw new Error("session-ref-owned-by-another-agent");
        const at = now();
        state.sessions[sessionRef] = {
          agentId,
          sessionRef,
          runtime,
          provider,
          state: "ONLINE",
          startedAt: previous?.startedAt ?? at,
          lastSeenAt: at,
          closedAt: null
        };
        return clone(state.sessions[sessionRef]);
      }
    )).result;
  }

  async closeSession({ agentId, sessionRef }) {
    this.#requireIdentity(agentId, sessionRef);
    return (await this.store.transact(
      { actor: agentId, type: "session.close", data: { sessionRef } },
      (state) => {
        const session = this.#requireLiveSession(state, agentId, sessionRef);
        const active = Object.values(state.workItems).find(
          (item) => item.sessionRef === sessionRef && ["CLAIMED", "RUNNING", "VERIFYING"].includes(item.state)
        );
        if (active) throw new Error(`session-has-active-work:${active.id}`);
        session.state = "CLOSED";
        session.closedAt = now();
        session.lastSeenAt = now();
        return clone(session);
      }
    )).result;
  }

  async instantiateWorkflow({
    agentId,
    sessionRef,
    templateId,
    workflowId,
    idempotencyKey,
    parameters = {},
    connectorBindings = {},
    delegationContractRef = null
  }) {
    this.#requireIdentity(agentId, sessionRef);
    assertNoSecrets({ parameters, connectorBindings });
    const templates = await this.templates();
    const template = templates.find((entry) => entry.id === templateId);
    if (!template) throw new Error("workflow-template-not-found");
    const requestHash = sha256({ templateId, parameters, connectorBindings, delegationContractRef });
    const finalWorkflowId = workflowId ?? `wf_${templateId}_${randomUUID()}`;
    const semanticKey = idempotencyKey ?? `workflow:${finalWorkflowId}`;

    return (await this.store.transact(
      {
        actor: agentId,
        type: "workflow.instantiate",
        data: { templateId, workflowId: finalWorkflowId, idempotencyKey: semanticKey, requestHash }
      },
      (state) => {
        this.#requireLiveSession(state, agentId, sessionRef);
        const existing = Object.values(state.workflows).find((entry) => entry.idempotencyKey === semanticKey);
        if (existing) {
          if (existing.requestHash !== requestHash) throw new Error("workflow-idempotency-conflict");
          return {
            workflow: clone(existing),
            workItems: Object.values(state.workItems)
              .filter((item) => item.workflowId === existing.id)
              .map(clone)
          };
        }
        if (state.workflows[finalWorkflowId]) throw new Error("workflow-id-conflict");
        const rendered = substitute(template, parameters);
        const at = now();
        const workflow = {
          id: finalWorkflowId,
          templateId,
          integrationOwnerAgent: rendered.integrationOwnerAgent,
          participants: rendered.participants,
          idempotencyKey: semanticKey,
          requestHash,
          delegationContractRef,
          parametersHash: sha256(parameters),
          state: "ACTIVE",
          createdByAgentId: agentId,
          createdBySessionRef: sessionRef,
          createdAt: at,
          updatedAt: at
        };
        state.workflows[workflow.id] = workflow;
        const stepToItem = new Map(rendered.steps.map((step) => [step.id, `${workflow.id}:${step.id}`]));
        const created = [];
        for (const step of rendered.steps) {
          requireAgent(step.owner);
          const item = {
            id: stepToItem.get(step.id),
            workflowId: workflow.id,
            stepId: step.id,
            ownerAgentId: step.owner,
            previousOwnerAgentId: null,
            connectorId: connectorBindings[step.id] ?? connectorBindings[step.connectorProfile] ?? null,
            connectorProfile: step.connectorProfile ?? null,
            actionClass: step.actionClass,
            resourceKey: step.resourceKey ?? null,
            state: step.dependsOn?.length ? "BLOCKED" : "READY",
            dependencyIds: (step.dependsOn ?? []).map((dependency) => stepToItem.get(dependency)),
            requiresVerifiedDependencies: Boolean(step.requiresVerifiedDependencies),
            sessionRef: null,
            claimId: null,
            expectedResourceVersionRef: null,
            observedResourceVersionRef: null,
            verificationRef: null,
            resultRef: null,
            createdAt: at,
            updatedAt: at,
            startedAt: null,
            completedAt: null
          };
          state.workItems[item.id] = item;
          created.push(clone(item));
          if (item.state === "READY") {
            this.#notify(state, {
              toAgentId: item.ownerAgentId,
              fromAgentId: agentId,
              kind: "WORK_READY",
              subjectRef: item.id,
              summary: `Work item ${item.stepId} is ready`,
              idempotencyKey: `work-ready:${item.id}:initial`
            });
          }
        }
        return { workflow: clone(workflow), workItems: created };
      }
    )).result;
  }

  async queue({ agentId, sessionRef, includeTerminal = false }) {
    this.#requireIdentity(agentId, sessionRef);
    const state = await this.store.read();
    this.#requireLiveSession(state, agentId, sessionRef);
    return Object.values(state.workItems)
      .filter((item) => item.ownerAgentId === agentId)
      .filter((item) => includeTerminal || !TERMINAL.has(item.state))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(clone);
  }

  async startWorkItem({ agentId, sessionRef, workItemId, expectedResourceVersionRef = null }) {
    this.#requireIdentity(agentId, sessionRef);
    return (await this.store.transact(
      { actor: agentId, type: "work.start", data: { workItemId, expectedResourceVersionRef } },
      (state) => {
        this.#requireLiveSession(state, agentId, sessionRef);
        this.#refreshReady(state);
        const item = state.workItems[workItemId];
        if (!item) throw new Error("work-item-not-found");
        if (item.ownerAgentId !== agentId) throw new Error("work-item-owner-mismatch");
        if (item.state !== "READY") throw new Error(`work-item-not-ready:${item.state}`);
        if (MUTATING.has(item.actionClass)) {
          const active = Object.values(state.workItems).find(
            (candidate) => candidate.id !== item.id &&
              candidate.ownerAgentId === agentId &&
              MUTATING.has(candidate.actionClass) &&
              ["CLAIMED", "RUNNING", "VERIFYING"].includes(candidate.state)
          );
          if (active) throw new Error(`agent-exclusive-mutation-limit:${active.id}`);
          const claimed = Object.values(state.workItems).find(
            (candidate) => candidate.id !== item.id &&
              candidate.resourceKey && item.resourceKey &&
              candidate.resourceKey === item.resourceKey &&
              ["CLAIMED", "RUNNING", "VERIFYING"].includes(candidate.state)
          );
          if (claimed) throw new Error(`resource-already-claimed:${claimed.id}`);
        }
        if (expectedResourceVersionRef && item.resourceKey) {
          const current = state.resources[item.resourceKey]?.versionRef;
          if (current && current !== expectedResourceVersionRef) throw new Error("resource-version-conflict");
        }
        item.state = "RUNNING";
        item.sessionRef = sessionRef;
        item.claimId = id("claim");
        item.expectedResourceVersionRef = expectedResourceVersionRef;
        item.startedAt = now();
        item.updatedAt = item.startedAt;
        return clone(item);
      }
    )).result;
  }

  async finishWorkItem({
    agentId,
    sessionRef,
    workItemId,
    outcome,
    resultRef = null,
    verificationRef = null,
    observedResourceVersionRef = null
  }) {
    this.#requireIdentity(agentId, sessionRef);
    const allowed = new Set(["SUCCEEDED", "FAILED", "TIMEOUT_UNKNOWN", "CANCELLED"]);
    if (!allowed.has(outcome)) throw new Error("invalid-work-outcome");
    return (await this.store.transact(
      {
        actor: agentId,
        type: "work.finish",
        data: { workItemId, outcome, resultRef, verificationRef, observedResourceVersionRef }
      },
      (state) => {
        this.#requireLiveSession(state, agentId, sessionRef);
        const item = state.workItems[workItemId];
        if (!item) throw new Error("work-item-not-found");
        if (item.ownerAgentId !== agentId) throw new Error("work-item-owner-mismatch");
        if (item.sessionRef !== sessionRef) throw new Error("work-item-session-mismatch");
        if (!["RUNNING", "VERIFYING"].includes(item.state)) throw new Error(`work-item-not-active:${item.state}`);
        if (outcome === "SUCCEEDED" && MUTATING.has(item.actionClass) && !verificationRef) {
          throw new Error("verified-readback-required");
        }
        item.state = outcome;
        item.resultRef = resultRef;
        item.verificationRef = verificationRef;
        item.observedResourceVersionRef = observedResourceVersionRef;
        item.updatedAt = now();
        item.completedAt = item.updatedAt;
        if (item.resourceKey && observedResourceVersionRef) {
          state.resources[item.resourceKey] = {
            connectorId: item.connectorId,
            versionRef: observedResourceVersionRef,
            observedAt: item.updatedAt,
            observedByAgentId: agentId,
            evidenceRef: verificationRef
          };
        }
        this.#refreshReady(state, agentId);
        this.#refreshWorkflow(state, item.workflowId);
        return clone(item);
      }
    )).result;
  }

  async createDelegation({
    agentId,
    sessionRef,
    workItemId,
    toAgentId,
    contractRef,
    acceptanceRefs = [],
    idempotencyKey
  }) {
    this.#requireIdentity(agentId, sessionRef);
    requireAgent(toAgentId);
    if (!contractRef) throw new Error("delegation-contract-required");
    const semanticKey = idempotencyKey ?? `delegate:${workItemId}:${toAgentId}`;
    return (await this.store.transact(
      {
        actor: agentId,
        type: "delegation.create",
        data: { workItemId, toAgentId, contractRef, acceptanceRefs, idempotencyKey: semanticKey }
      },
      (state) => {
        this.#requireLiveSession(state, agentId, sessionRef);
        const item = state.workItems[workItemId];
        if (!item) throw new Error("work-item-not-found");
        if (item.ownerAgentId !== agentId) throw new Error("delegation-source-not-owner");
        if (["RUNNING", "VERIFYING"].includes(item.state)) throw new Error("cannot-delegate-active-work");
        const existing = Object.values(state.delegations).find((entry) => entry.idempotencyKey === semanticKey);
        if (existing) {
          if (existing.workItemId !== workItemId || existing.toAgentId !== toAgentId || existing.contractRef !== contractRef) {
            throw new Error("delegation-idempotency-conflict");
          }
          return clone(existing);
        }
        const at = now();
        const delegation = {
          id: id("delegation"),
          workItemId,
          workflowId: item.workflowId,
          fromAgentId: agentId,
          fromSessionRef: sessionRef,
          toAgentId,
          toSessionRef: null,
          contractRef,
          acceptanceRefs,
          idempotencyKey: semanticKey,
          state: "OPEN",
          resultRef: null,
          createdAt: at,
          updatedAt: at,
          resolvedAt: null
        };
        state.delegations[delegation.id] = delegation;
        this.#notify(state, {
          toAgentId,
          fromAgentId: agentId,
          kind: "DELEGATION_REQUESTED",
          subjectRef: delegation.id,
          summary: `Delegation requested for ${workItemId}`,
          idempotencyKey: `delegation-open:${delegation.id}`
        });
        return clone(delegation);
      }
    )).result;
  }

  async resolveDelegation({ agentId, sessionRef, delegationId, decision, resultRef = null }) {
    this.#requireIdentity(agentId, sessionRef);
    if (!["ACCEPTED", "REJECTED"].includes(decision)) throw new Error("invalid-delegation-decision");
    return (await this.store.transact(
      { actor: agentId, type: "delegation.resolve", data: { delegationId, decision, resultRef } },
      (state) => {
        this.#requireLiveSession(state, agentId, sessionRef);
        const delegation = state.delegations[delegationId];
        if (!delegation) throw new Error("delegation-not-found");
        if (delegation.toAgentId !== agentId) throw new Error("delegation-target-mismatch");
        if (delegation.state !== "OPEN") throw new Error(`delegation-not-open:${delegation.state}`);
        delegation.state = decision;
        delegation.toSessionRef = sessionRef;
        delegation.resultRef = resultRef;
        delegation.updatedAt = now();
        delegation.resolvedAt = delegation.updatedAt;
        const item = state.workItems[delegation.workItemId];
        if (decision === "ACCEPTED") {
          if (!item || item.ownerAgentId !== delegation.fromAgentId) throw new Error("delegation-work-owner-drift");
          item.previousOwnerAgentId = item.ownerAgentId;
          item.ownerAgentId = agentId;
          item.updatedAt = now();
          this.#notify(state, {
            toAgentId: delegation.fromAgentId,
            fromAgentId: agentId,
            kind: "DELEGATION_RESOLVED",
            subjectRef: delegation.id,
            summary: `Delegation accepted by ${agentId}`,
            idempotencyKey: `delegation-resolved:${delegation.id}:accepted`
          });
          if (item.state === "READY") {
            this.#notify(state, {
              toAgentId: agentId,
              fromAgentId: delegation.fromAgentId,
              kind: "WORK_READY",
              subjectRef: item.id,
              summary: `Delegated work ${item.stepId} is ready`,
              idempotencyKey: `work-ready:${item.id}:delegated:${agentId}`
            });
          }
        } else {
          this.#notify(state, {
            toAgentId: delegation.fromAgentId,
            fromAgentId: agentId,
            kind: "DELEGATION_RESOLVED",
            subjectRef: delegation.id,
            summary: `Delegation rejected by ${agentId}`,
            idempotencyKey: `delegation-resolved:${delegation.id}:rejected`
          });
        }
        return clone(delegation);
      }
    )).result;
  }

  async notifications({ agentId, sessionRef, includeAcknowledged = false }) {
    this.#requireIdentity(agentId, sessionRef);
    const state = await this.store.read();
    this.#requireLiveSession(state, agentId, sessionRef);
    return Object.values(state.notifications)
      .filter((entry) => entry.toAgentId === agentId)
      .filter((entry) => includeAcknowledged || entry.state !== "ACKNOWLEDGED")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }

  async acknowledgeNotification({ agentId, sessionRef, notificationId }) {
    this.#requireIdentity(agentId, sessionRef);
    return (await this.store.transact(
      { actor: agentId, type: "notification.ack", data: { notificationId } },
      (state) => {
        this.#requireLiveSession(state, agentId, sessionRef);
        const notification = state.notifications[notificationId];
        if (!notification) throw new Error("notification-not-found");
        if (notification.toAgentId !== agentId) throw new Error("notification-target-mismatch");
        notification.state = "ACKNOWLEDGED";
        notification.acknowledgedAt = now();
        notification.acknowledgedBySessionRef = sessionRef;
        notification.updatedAt = notification.acknowledgedAt;
        return clone(notification);
      }
    )).result;
  }

  #requireIdentity(agentId, sessionRef) {
    requireAgent(agentId);
    if (!sessionRef) throw new Error("session-ref-required");
  }

  #sessionIsLive(session) {
    return session && session.state === "ONLINE" && Date.now() - Date.parse(session.lastSeenAt) <= this.heartbeatTtlMs;
  }

  #requireLiveSession(state, agentId, sessionRef) {
    const session = state.sessions[sessionRef];
    if (!session || session.agentId !== agentId) throw new Error("session-not-found");
    if (!this.#sessionIsLive(session)) throw new Error("session-not-live");
    return session;
  }

  #notify(state, { toAgentId, fromAgentId = null, kind, subjectRef, summary = "", idempotencyKey }) {
    const existing = Object.values(state.notifications).find(
      (entry) => entry.idempotencyKey === idempotencyKey && entry.toAgentId === toAgentId
    );
    if (existing) return existing;
    const at = now();
    const notification = {
      id: id("notification"),
      toAgentId,
      fromAgentId,
      kind,
      subjectRef,
      summary,
      state: "PENDING",
      idempotencyKey,
      createdAt: at,
      updatedAt: at,
      deliveredAt: null,
      acknowledgedAt: null,
      acknowledgedBySessionRef: null
    };
    state.notifications[notification.id] = notification;
    return notification;
  }

  #refreshReady(state, fromAgentId = "connector-orchestrator") {
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of Object.values(state.workItems)) {
        if (item.state !== "BLOCKED") continue;
        const dependencies = item.dependencyIds.map((dependencyId) => state.workItems[dependencyId]);
        if (!dependencies.every(Boolean)) continue;
        const ready = dependencies.every(
          (dependency) => dependency.state === "SUCCEEDED" &&
            (!item.requiresVerifiedDependencies || Boolean(dependency.verificationRef) || !MUTATING.has(dependency.actionClass))
        );
        if (ready) {
          item.state = "READY";
          item.updatedAt = now();
          this.#notify(state, {
            toAgentId: item.ownerAgentId,
            fromAgentId,
            kind: "WORK_READY",
            subjectRef: item.id,
            summary: `Work item ${item.stepId} is ready`,
            idempotencyKey: `work-ready:${item.id}:dependencies`
          });
          changed = true;
        }
      }
    }
  }

  #refreshWorkflow(state, workflowId) {
    const workflow = state.workflows[workflowId];
    if (!workflow) return;
    const items = Object.values(state.workItems).filter((item) => item.workflowId === workflowId);
    if (items.some((item) => item.state === "TIMEOUT_UNKNOWN")) workflow.state = "BLOCKED";
    else if (items.some((item) => item.state === "FAILED")) workflow.state = "FAILED";
    else if (items.every((item) => item.state === "SUCCEEDED")) workflow.state = "SUCCEEDED";
    else if (items.some((item) => item.state === "CANCELLED")) workflow.state = "PARTIAL";
    else workflow.state = "ACTIVE";
    workflow.updatedAt = now();
  }
}
