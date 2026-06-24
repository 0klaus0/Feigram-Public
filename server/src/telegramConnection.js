require("telegram");
const { ConnectionTCPObfuscated } = require("telegram/network/connection/TCPObfuscated");

// Carry native MTProto with GramJS' obfuscated abridged transport. This avoids
// TCPFull signatures that some networks terminate immediately, while keeping
// every main and exported-DC connection on TCP/443.
class ConnectionTCPObfuscated443 extends ConnectionTCPObfuscated {
  constructor(options) {
    super({ ...options, port: 443 });
  }
}

module.exports = { ConnectionTCPObfuscated443 };
