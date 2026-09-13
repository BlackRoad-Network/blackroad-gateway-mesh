export const ROLE_CAPABILITIES = Object.freeze({
  discussion: Object.freeze({ operations: ['read', 'write'], semantics: ['list', 'search', 'thread', 'comment'] }),
  delivery: Object.freeze({ operations: ['read', 'write'], semantics: ['prepare', 'send', 'status', 'verify-delivery'] }),
  event: Object.freeze({ operations: ['read'], semantics: ['list', 'search', 'observe'] }),
  control: Object.freeze({ operations: ['read', 'write'], semantics: ['inspect', 'configure', 'reconcile', 'verify-state'] }),
  decision: Object.freeze({ operations: ['read', 'write'], semantics: ['inspect', 'decide', 'record-evidence'] }),
  'reference-only': Object.freeze({ operations: [], semantics: ['reference'] })
});

export function capabilitiesFor(role) {
  const capabilities = ROLE_CAPABILITIES[role];
  if (!capabilities) throw new Error(`unknown connector role: ${role}`);
  return capabilities;
}
