/**
 * Module-level service registry.
 *
 * webhook.js imports this tiny module (not the orchestrator) to avoid a
 * circular dependency and to stay completely inert until the server wires the
 * group subsystem up at startup.
 */
let service = null;

export function setGroupAdminService(instance) {
  service = instance || null;
}

export function getGroupAdminService() {
  return service;
}
