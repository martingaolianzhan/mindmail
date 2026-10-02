import nock, { type Scope } from "nock";
import { afterAll, afterEach } from "vitest";

const originalFetch = globalThis.fetch;

// Unit and integration tests are network-denied. PostgreSQL uses its own TCP
// connection and is separately restricted by integration.ts to a loopback test DB.
nock.disableNetConnect();
globalThis.fetch = async () => {
  throw new Error("Network access is denied in tests. Use an explicit mock.");
};

export function requireNockScope(scope: Scope) {
  return scope;
}

export function assertNoPendingNockInterceptors() {
  const pendingMocks = nock.pendingMocks();
  if (pendingMocks.length > 0) {
    throw new Error(`Required Nock interceptors were not used: ${pendingMocks.join(", ")}`);
  }
}

afterEach(() => {
  try {
    assertNoPendingNockInterceptors();
  } finally {
    nock.cleanAll();
  }
});

afterAll(() => {
  nock.enableNetConnect();
  globalThis.fetch = originalFetch;
});
