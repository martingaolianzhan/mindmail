import nock from "nock";
import { afterAll, afterEach } from "vitest";

// Unit and integration tests are network-denied. PostgreSQL uses its own TCP
// connection and is separately restricted by integration.ts to a loopback test DB.
nock.disableNetConnect();

afterEach(() => {
  nock.cleanAll();
});

afterAll(() => {
  nock.enableNetConnect();
});
