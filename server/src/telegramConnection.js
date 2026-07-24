require("telegram");
const { ConnectionTCPAbridged } = require("telegram/network/connection/TCPAbridged");
const { ConnectionTCPObfuscated } = require("telegram/network/connection/TCPObfuscated");

// Abridged MTProto transport on TCP/443 (low overhead, no obfuscation).
class ConnectionTCPAbridged443 extends ConnectionTCPAbridged {
  constructor(options) {
    super({ ...options, port: 443 });
  }
}

// Obfuscated+Abridged MTProto transport on TCP/443.
// The payload is wrapped with AES-256-CTR encryption, making it
// undetectable by DPI. Useful in regions where Telegram is blocked.
class ConnectionTCPObfuscated443 extends ConnectionTCPObfuscated {
  constructor(options) {
    super({ ...options, port: 443 });
  }
}

// Export a factory that returns the appropriate connection class
// based on the TELEGRAM_TRANSPORT environment variable.
// - "obfuscated" -> ConnectionTCPObfuscated443 (DPI-resistant)
// - "abridged" or unset -> ConnectionTCPAbridged443 (default, low overhead)
function getConnectionClass(transport) {
  if (transport === "obfuscated") {
    return ConnectionTCPObfuscated443;
  }
  return ConnectionTCPAbridged443;
}

module.exports = { ConnectionTCPAbridged443, ConnectionTCPObfuscated443, getConnectionClass };
