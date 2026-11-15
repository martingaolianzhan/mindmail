/** Fail on every procedure, including future account-router additions. */
export const forbiddenDemoCalls: string[] = [];
export function forbiddenDemoCall(name: string): never {
  forbiddenDemoCalls.push(name);
  throw new Error(`Demo attempted forbidden production operation: ${name}`);
}
export const forbiddenAccountApi = new Proxy({}, {
  get: (_target, procedure) => forbiddenDemoCall(`api.account.${String(procedure)}`),
});
