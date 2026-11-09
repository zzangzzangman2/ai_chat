"use strict";

const http = require("node:http");

function probeAppPort(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    let request;
    const finish = (healthy) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      request?.destroy();
      resolve(healthy);
    };
    // Bound the whole request, including a server that sends headers but never
    // finishes its body. Native HTTP also avoids desktop proxy discovery delays.
    const deadline = setTimeout(() => finish(false), timeoutMs);
    request = http.get({ hostname: "127.0.0.1", port, path: "/api/auth/me", agent: false }, (response) => {
      if (response.statusCode !== 200) {
        finish(false);
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 16_384) finish(false);
      });
      response.on("error", () => finish(false));
      response.on("end", () => {
        try {
          const value = JSON.parse(body);
          finish(value?.ok === true && Object.prototype.hasOwnProperty.call(value, "user"));
        } catch {
          finish(false);
        }
      });
    });
    request.on("error", () => finish(false));
  });
}

async function findHealthyAppPort(candidates, options = {}) {
  const ports = [...new Set(candidates.map(Number).filter((port) => Number.isInteger(port) && port > 0 && port <= 65535))];
  const probe = options.probe || probeAppPort;
  const timeoutMs = options.timeoutMs || 1500;
  // Probe all candidates together, but preserve saved-port preference even if a
  // different server replies first. A dead range costs one deadline, not 21.
  const healthy = await Promise.all(ports.map((port) => probe(port, timeoutMs).catch(() => false)));
  return ports[healthy.indexOf(true)] || 0;
}

if (require.main === module) {
  findHealthyAppPort(process.argv.slice(2)).then(
    (port) => process.stdout.write(`${port}\n`),
    () => { process.stdout.write("0\n"); process.exitCode = 1; }
  );
}

module.exports = { probeAppPort, findHealthyAppPort };
