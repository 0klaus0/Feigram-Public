const assert = require("node:assert/strict");
const test = require("node:test");
const { ConnectionTCPFull443 } = require("./telegramConnection");

class FakeSocket {
  constructor() {}
}

test("forces GramJS TCP connections to port 443", () => {
  const connection = new ConnectionTCPFull443({
    ip: "149.154.167.91",
    port: 80,
    dcId: 4,
    loggers: {},
    socket: FakeSocket,
    testServers: false
  });
  assert.equal(connection._port, 443);
});
