#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const args = parseArgs(process.argv.slice(2));
const port = Number(args.port || process.env.PORT || 3000);
const maintenancePort = Number(
  args.maintenancePort || process.env.DOS_MAINTENANCE_PORT || port + 1000
);
const parentPid = Number(args.parentPid || 0);
const outLog = path.resolve(args.out || path.join(ROOT, ".dos-next.out.log"));
const errLog = path.resolve(args.err || path.join(ROOT, ".dos-next.err.log"));
const portFile = path.join(ROOT, ".dos-server-port");
const runnerPidFile = path.join(ROOT, ".dos-server-runner-pid");
const childPidFile = path.join(ROOT, ".dos-server-child-pid");
const maintenancePortFile = path.join(ROOT, ".dos-maintenance-port");
const maintenanceChildPidFile = path.join(ROOT, ".dos-maintenance-child-pid");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--port") out.port = argv[++i];
    else if (a.startsWith("--port=")) out.port = a.slice("--port=".length);
    else if (a === "--maintenancePort") out.maintenancePort = argv[++i];
    else if (a.startsWith("--maintenancePort=")) {
      out.maintenancePort = a.slice("--maintenancePort=".length);
    }
    else if (a === "--parentPid") out.parentPid = argv[++i];
    else if (a.startsWith("--parentPid=")) out.parentPid = a.slice("--parentPid=".length);
    else if (a === "--out") out.out = argv[++i];
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length);
    else if (a === "--err") out.err = argv[++i];
    else if (a.startsWith("--err=")) out.err = a.slice("--err=".length);
  }
  return out;
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

function pidExists(pid) {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanEnv(extra = {}) {
  const env = {};
  let inheritedPath = "";
  for (const [key, value] of Object.entries(process.env)) {
    if (!key || key.includes("=") || value === undefined) continue;
    // Windows 환경변수 이름은 대소문자를 구분하지 않는다. Path/PATH를 둘 다
    // 넘기면 cmd/npm이 시스템 Node를 먼저 고르는 경우가 있으므로 하나로 합친다.
    if (key.toLowerCase() === "path") {
      inheritedPath = String(value);
      continue;
    }
    env[key] = String(value);
  }
  // dos-server를 실행한 Node와 자식 npm/next의 ABI를 항상 일치시킨다.
  // better-sqlite3 같은 네이티브 모듈은 여기서 Node 버전이 바뀌면 즉시 깨진다.
  const runtimeDir = path.dirname(process.execPath);
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  env[pathKey] = [runtimeDir, inheritedPath].filter(Boolean).join(path.delimiter);
  return { ...env, ...extra };
}

fs.mkdirSync(path.dirname(outLog), { recursive: true });
const out = fs.createWriteStream(outLog, { flags: "a" });
const err = fs.createWriteStream(errLog, { flags: "a" });

const command = process.platform === "win32" ? "cmd.exe" : "npm";
function commandArgs(serverPort) {
  return process.platform === "win32"
    ? ["/d", "/s", "/c", "npm.cmd", "run", "start", "--", "--hostname", "127.0.0.1", "--port", String(serverPort)]
    : ["run", "start", "--", "--hostname", "127.0.0.1", "--port", String(serverPort)];
}

function spawnServer(serverPort, role) {
  return spawn(command, commandArgs(serverPort), {
    cwd: ROOT,
    env: cleanEnv({
      PORT: String(serverPort),
      ARCA_DOS_SERVER: "1",
      ARCA_DOS_SERVER_ROLE: role,
    }),
    windowsHide: true,
    detached: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

const child = spawnServer(port, "chat");
const maintenanceChild = spawnServer(maintenancePort, "maintenance");

try {
  fs.writeFileSync(runnerPidFile, String(process.pid || ""), "ascii");
  fs.writeFileSync(childPidFile, String(child.pid || ""), "ascii");
  fs.writeFileSync(portFile, String(port), "ascii");
  fs.writeFileSync(maintenancePortFile, String(maintenancePort), "ascii");
  fs.writeFileSync(maintenanceChildPidFile, String(maintenanceChild.pid || ""), "ascii");
} catch {}

child.stdout.pipe(out);
child.stderr.pipe(err);
maintenanceChild.stdout.pipe(out);
maintenanceChild.stderr.pipe(err);

function cleanupPidFiles() {
  try {
    fs.rmSync(childPidFile, { force: true });
    fs.rmSync(maintenanceChildPidFile, { force: true });
    fs.rmSync(runnerPidFile, { force: true });
    fs.rmSync(portFile, { force: true });
    fs.rmSync(maintenancePortFile, { force: true });
  } catch {}
}

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  killTree(maintenanceChild.pid);
  killTree(child.pid);
  cleanupPidFiles();
  setTimeout(() => process.exit(exitCode), 300);
}

child.on("exit", (code) => {
  if (!stopping) stop(Number.isFinite(code) ? code : 0);
});

maintenanceChild.on("exit", (code) => {
  try { fs.rmSync(maintenanceChildPidFile, { force: true }); } catch {}
  if (!stopping) {
    try {
      err.write(`${new Date().toISOString()} maintenance server exited (${String(code)})\n`);
    } catch {}
  }
});

child.on("error", (e) => {
  try {
    err.write(`${new Date().toISOString()} ${String(e && e.stack ? e.stack : e)}\n`);
  } catch {}
  stop(1);
});

maintenanceChild.on("error", (e) => {
  try {
    err.write(`${new Date().toISOString()} maintenance server error ${String(e && e.stack ? e.stack : e)}\n`);
  } catch {}
});

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => stop(0));
}

process.on("uncaughtException", (e) => {
  try {
    err.write(`${new Date().toISOString()} ${String(e && e.stack ? e.stack : e)}\n`);
  } catch {}
  stop(1);
});

if (parentPid > 0) {
  setInterval(() => {
    if (!pidExists(parentPid)) stop(0);
  }, 1000);
}
