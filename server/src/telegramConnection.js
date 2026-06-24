require("telegram");
const { ConnectionTCPFull } = require("telegram/network/connection/TCPFull");

// Some networks accept Telegram TCP/80 and immediately tear it down. Keep the
// normal GramJS transport while pinning every main and exported-DC connection
// to TCP/443, including sessions loaded after client construction.
class ConnectionTCPFull443 extends ConnectionTCPFull {
  constructor(options) {
    super({ ...options, port: 443 });
  }
}

module.exports = { ConnectionTCPFull443 };
