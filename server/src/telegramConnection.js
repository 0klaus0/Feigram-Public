require("telegram");
const { ConnectionTCPFull } = require("telegram/network/connection/TCPFull");

class ConnectionTCPFull443 extends ConnectionTCPFull {
  constructor(options) {
    super({ ...options, port: 443 });
  }
}

module.exports = { ConnectionTCPFull443 };
