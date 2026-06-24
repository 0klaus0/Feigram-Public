const assert = require("node:assert/strict");
const test = require("node:test");

const { ConnectionTCPObfuscated443 } = require("./telegramConnection");

class FakeSocket {
  constructor() {}
}

test("GramJS uses obfuscated abridged MTProto on TCP 443", () => {
  const connection = new ConnectionTCPObfuscated443({
    ip: "149.154.167.91",
    port: 80,
    dcId: 4,
    loggers: {},
    socket: FakeSocket,
    testServers: false
  });

  assert.equal(connection._port, 443);
  assert.equal(connection.constructor.name, "ConnectionTCPObfuscated443");
});
