/**
 * Minimal ambient declaration for the optional `nats` dependency.
 * Pulse core has no runtime dependency on NATS; NatsAgentTransport
 * imports it dynamically and fails with an actionable error if absent.
 */
declare module "nats" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function connect(opts?: { servers?: string }): Promise<any>;
}
