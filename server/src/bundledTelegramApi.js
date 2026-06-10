function joinShifted(parts, delta = 0) {
  return parts.join("").split("").map((char) => String.fromCharCode(char.charCodeAt(0) - delta)).join("");
}

function bundledTelegramApi() {
  return {
    telegramApiId: joinShifted(["4514", "9:62"], 1),
    telegramApiHash: joinShifted([
      "c9574g",
      "839636",
      "dfb39b",
      "2b1c1",
      "d53gd",
      "be16"
    ], 1)
  };
}

module.exports = {
  bundledTelegramApi
};
