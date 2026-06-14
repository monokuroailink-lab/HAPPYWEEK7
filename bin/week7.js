#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const APP_NAME = "HAPPYWEEK7";
const CLI_NAME = "week7";
const DEFAULT_MODE = "rewrite-once";
const VALID_MODES = new Set(["warn", "rewrite-once", "strict"]);
// A real harness leak is a raw, unnamespaced opening tag that carries a name="..."
// attribute. Requiring the attribute (B) keeps the word "invoke" in prose from firing,
// and code regions are masked first (A) so documentation examples never count.
const LEAK_PATTERN = /(?<![A-Za-z0-9_:-])<\s*(invoke|parameter)\b[^>]*\bname\s*=\s*["']/i;

const homeDir = os.homedir();
const claudeDir = path.join(homeDir, ".claude");
const settingsPath = path.join(claudeDir, "settings.json");
const appDir = path.join(claudeDir, "week7");
const backupDir = path.join(appDir, "backups");
const configPath = path.join(appDir, "config.json");
const statePath = path.join(appDir, "state.json");
const logPath = path.join(appDir, "week7.log");

function main() {
  const args = process.argv.slice(2);
  const command = args.shift() || "help";

  try {
    switch (command) {
      case "install":
        install(parseOptions(args));
        break;
      case "uninstall":
        uninstall(parseOptions(args));
        break;
      case "status":
        status();
        break;
      case "test":
        runTests();
        break;
      case "logs":
        showLogs(parseOptions(args));
        break;
      case "hook":
        runHook();
        break;
      case "help":
      case "--help":
      case "-h":
        printHelp();
        break;
      case "version":
      case "--version":
      case "-v":
        printVersion();
        break;
      default:
        fail(`Unknown command: ${command}\nRun: ${CLI_NAME} help`);
    }
  } catch (error) {
    fail(error && error.message ? error.message : String(error));
  }
}

function parseOptions(args) {
  const options = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--mode") {
      options.mode = args[++i];
    } else if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
    } else if (arg === "--tail") {
      options.tail = Number(args[++i]);
    } else if (arg.startsWith("--tail=")) {
      options.tail = Number(arg.slice("--tail=".length));
    } else if (arg === "--purge") {
      options.purge = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function install(options) {
  const mode = options.mode || DEFAULT_MODE;
  assertMode(mode);
  ensureDir(appDir);
  ensureDir(backupDir);
  ensureDir(claudeDir);

  const settings = readSettings();
  backupSettings("install");
  ensureHooks(settings);

  removeWeek7Hooks(settings);
  addHook(settings, "Stop", hookCommand(), 5);
  addHook(settings, "SubagentStop", hookCommand(), 5);
  addHook(settings, "UserPromptSubmit", hookCommand(), 3);

  writeSettings(settings);
  writeJson(configPath, {
    app: APP_NAME,
    mode,
    installedAt: new Date().toISOString(),
    command: hookCommand(),
    dataDir: appDir
  });

  logLine(`installed mode=${mode}`);
  console.log(`${APP_NAME} installed.`);
  console.log(`Mode: ${mode}`);
  console.log(`Claude settings: ${settingsPath}`);
  console.log(`Data dir: ${appDir}`);
}

function uninstall(options) {
  const settings = readSettings();
  backupSettings("uninstall");
  ensureHooks(settings);
  const removed = removeWeek7Hooks(settings);
  writeSettings(settings);
  logLine(`uninstalled removedHooks=${removed}`);

  if (options.purge) {
    rmIfExists(configPath);
    rmIfExists(statePath);
    rmIfExists(logPath);
  }

  console.log(`${APP_NAME} uninstalled.`);
  console.log(`Removed hooks: ${removed}`);
  if (options.purge) {
    console.log("Purged config, state, and log files.");
  }
}

function status() {
  const config = readConfig();
  const settings = readSettings(false);
  const hooks = settings && settings.hooks ? settings.hooks : {};
  const installed = ["Stop", "SubagentStop", "UserPromptSubmit"].map((eventName) => ({
    eventName,
    count: countWeek7Hooks(hooks[eventName])
  }));

  console.log(APP_NAME);
  console.log(`CLI: ${CLI_NAME}`);
  console.log(`Mode: ${config.mode || DEFAULT_MODE}`);
  console.log(`Config: ${configPath}`);
  console.log(`State: ${statePath}`);
  console.log(`Log: ${logPath}`);
  console.log(`Claude settings: ${settingsPath}`);
  console.log("Hooks:");
  installed.forEach((item) => {
    console.log(`  ${item.eventName}: ${item.count}`);
  });
}

function showLogs(options) {
  const tail = Number.isFinite(options.tail) && options.tail > 0 ? Math.floor(options.tail) : 50;
  if (!fs.existsSync(logPath)) {
    console.log("No logs yet.");
    return;
  }

  const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean);
  lines.slice(-tail).forEach((line) => console.log(line));
}

function runHook() {
  readStdin((raw) => {
    if (!raw.trim()) {
      return;
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      logLine(`hook-json-error message=${safeForLog(error.message)}`);
      return;
    }

    const eventName = String(payload.hook_event_name || "");
    if (eventName === "UserPromptSubmit") {
      writeHookJson({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: userPromptContext()
        }
      });
      return;
    }

    if (eventName !== "Stop" && eventName !== "SubagentStop") {
      return;
    }

    const message = String(payload.last_assistant_message || "");
    const leak = detectLeak(message);
    if (!leak) {
      return;
    }

    const config = readConfig();
    const mode = config.mode || DEFAULT_MODE;
    assertMode(mode);
    const sessionId = String(payload.session_id || "unknown-session");
    const hash = sha256(message);
    const stateKey = `${eventName}/${sessionId}/${hash}`;
    const state = readState();
    const preview = makePreview(message, leak.index);

    logLine(`leak event=${eventName} session=${safeForLog(sessionId)} mode=${mode} hash=${hash} preview=${preview}`);

    if (mode === "warn") {
      return;
    }

    if (mode === "rewrite-once" && state.blocked[stateKey]) {
      logLine(`allow-repeat event=${eventName} session=${safeForLog(sessionId)} hash=${hash}`);
      return;
    }

    state.blocked[stateKey] = {
      at: new Date().toISOString(),
      preview
    };
    writeState(state);

    writeHookJson({
      decision: "block",
      reason: blockReason(mode, hash)
    });
  });
}

function runTests() {
  const sessionId = `test-${Date.now()}`;
  const bad = [
    "notifyDiscord structure is ready.",
    "",
    "call",
    "<invoke name=\"Bash\">",
    "<parameter name=\"command\">echo ok</parameter>",
    "</invoke>"
  ].join("\n");
  const good = "notifyDiscord structure is ready. Running deployment through the internal tool.";
  const namespaced = "call\n<antml:invoke name=\"Bash\"><antml:parameter name=\"command\">echo ok</antml:parameter></antml:invoke>";

  // Build raw (unnamespaced) tags via concatenation so the test source itself
  // never contains a literal tool-call tag that an editor or guard might rewrite.
  const LT = "<";
  const rawOpen = `${LT}invoke name="Bash">`;
  const rawParam = `${LT}parameter name="command">echo ok${LT}/parameter>`;
  const rawProse = `leaking now ${rawOpen} ${rawParam}`;
  const fenced = ["```text", bad, "```", "that is documentation, not a leak."].join("\n");
  const inlineCode = `the guard catches an \`${rawOpen}\` tag written inline`;
  const wordOnly = "I will invoke the Bash tool and pass a parameter to it.";
  const bareNoAttr = `discussing an ${LT}invoke> tag without a name attribute in prose`;

  const tests = [
    ["detect raw leak", Boolean(detectLeak(bad)), true],
    ["detect constructed raw leak", Boolean(detectLeak(rawProse)), true],
    ["ignore normal prose", Boolean(detectLeak(good)), false],
    ["ignore namespaced antml", Boolean(detectLeak(namespaced)), false],
    ["ignore fenced code block", Boolean(detectLeak(fenced)), false],
    ["ignore inline code span", Boolean(detectLeak(inlineCode)), false],
    ["ignore plain words", Boolean(detectLeak(wordOnly)), false],
    ["ignore tag without name attribute", Boolean(detectLeak(bareNoAttr)), false]
  ];

  let failed = 0;
  for (const [name, actual, expected] of tests) {
    if (actual !== expected) {
      failed += 1;
      console.log(`FAIL ${name}: expected ${expected}, got ${actual}`);
    } else {
      console.log(`PASS ${name}`);
    }
  }

  const first = simulateHook("Stop", sessionId, bad);
  const second = simulateHook("Stop", sessionId, bad);
  const third = simulateHook("Stop", sessionId, namespaced);
  const firstObj = first ? JSON.parse(first) : null;
  const reason = firstObj && firstObj.reason ? firstObj.reason : "";

  if (!firstObj || firstObj.decision !== "block") {
    failed += 1;
    console.log("FAIL rewrite-once first leak blocks");
  } else {
    console.log("PASS rewrite-once first leak blocks");
  }

  if (second !== "") {
    failed += 1;
    console.log("FAIL rewrite-once repeated identical leak is allowed");
  } else {
    console.log("PASS rewrite-once repeated identical leak is allowed");
  }

  if (third !== "") {
    failed += 1;
    console.log("FAIL namespaced markup is allowed");
  } else {
    console.log("PASS namespaced markup is allowed");
  }

  if (/[<>]/.test(reason)) {
    failed += 1;
    console.log("FAIL block reason contains angle brackets");
  } else {
    console.log("PASS block reason has no angle brackets");
  }

  if (failed > 0) {
    process.exitCode = 1;
    return;
  }

  console.log(`${APP_NAME} test suite passed.`);
}

function simulateHook(eventName, sessionId, message) {
  const payload = {
    hook_event_name: eventName,
    session_id: sessionId,
    stop_hook_active: false,
    last_assistant_message: message
  };
  return runHookWithPayload(payload, "rewrite-once");
}

function runHookWithPayload(payload, modeOverride) {
  const eventName = String(payload.hook_event_name || "");
  if (eventName !== "Stop" && eventName !== "SubagentStop") {
    return "";
  }

  const message = String(payload.last_assistant_message || "");
  const leak = detectLeak(message);
  if (!leak) {
    return "";
  }

  const mode = modeOverride || readConfig().mode || DEFAULT_MODE;
  const sessionId = String(payload.session_id || "unknown-session");
  const hash = sha256(message);
  const stateKey = `${eventName}/${sessionId}/${hash}`;
  const state = readState();

  if (mode === "warn") {
    return "";
  }

  if (mode === "rewrite-once" && state.blocked[stateKey]) {
    return "";
  }

  state.blocked[stateKey] = {
    at: new Date().toISOString(),
    preview: makePreview(message, leak.index)
  };
  writeState(state);

  return JSON.stringify({
    decision: "block",
    reason: blockReason(mode, hash)
  });
}

function userPromptContext() {
  return [
    "HAPPYWEEK7 guard is active.",
    "Do not expose raw tool-call XML in assistant prose.",
    "If an internal harness call is intended, use namespaced antml invoke and antml parameter tags, not unnamespaced tags.",
    "If raw tool-call markup appears in the final assistant text, a deterministic local Stop hook will request a rewrite."
  ].join(" ");
}

function blockReason(mode, hash) {
  return [
    "週七出勤喜んで！",
    "",
    "HAPPYWEEK7 blocked a raw tool-call leak.",
    "Rewrite the response without exposing internal tool-call markup.",
    `Mode: ${mode}.`,
    "This is a deterministic local hook, not an AI check.",
    `Leak hash: ${hash}`
  ].join("\n");
}

function detectLeak(text) {
  if (!text || typeof text !== "string") {
    return null;
  }
  // Mask fenced and inline code with same-length spaces so documentation that
  // shows tool-call syntax is ignored while leak offsets stay aligned with the
  // original text (used by makePreview).
  return LEAK_PATTERN.exec(maskCodeRegions(text));
}

function maskCodeRegions(text) {
  let masked = text.replace(/```[\s\S]*?```/g, (block) => " ".repeat(block.length));
  masked = masked.replace(/`[^`\r\n]*`/g, (span) => " ".repeat(span.length));
  return masked;
}

function makePreview(text, index) {
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + 180);
  return safeForLog(text.slice(start, end).replace(/\s+/g, " ").trim());
}

function safeForLog(value) {
  return String(value).replace(/</g, "[").replace(/>/g, "]").replace(/\r?\n/g, " ");
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function readConfig() {
  if (!fs.existsSync(configPath)) {
    return { app: APP_NAME, mode: DEFAULT_MODE };
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return { app: APP_NAME, mode: DEFAULT_MODE };
  }
}

function readState() {
  if (!fs.existsSync(statePath)) {
    return { blocked: {} };
  }
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (!state.blocked || typeof state.blocked !== "object") {
      state.blocked = {};
    }
    return state;
  } catch {
    return { blocked: {} };
  }
}

function writeState(state) {
  ensureDir(appDir);
  const keys = Object.keys(state.blocked || {}).slice(-300);
  const trimmed = {};
  keys.forEach((key) => {
    trimmed[key] = state.blocked[key];
  });
  writeJson(statePath, { blocked: trimmed });
}

function readSettings(required = true) {
  if (!fs.existsSync(settingsPath)) {
    if (required) {
      return {};
    }
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse Claude settings: ${settingsPath}\n${error.message}`);
  }
}

function writeSettings(settings) {
  ensureDir(claudeDir);
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function ensureHooks(settings) {
  if (!settings.hooks || typeof settings.hooks !== "object") {
    settings.hooks = {};
  }
}

function backupSettings(reason) {
  if (!fs.existsSync(settingsPath)) {
    return;
  }
  ensureDir(backupDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(backupDir, `settings.${reason}.${stamp}.json`);
  fs.copyFileSync(settingsPath, target);
}

function addHook(settings, eventName, command, timeout) {
  ensureHooks(settings);
  if (!Array.isArray(settings.hooks[eventName])) {
    settings.hooks[eventName] = [];
  }
  settings.hooks[eventName].unshift({
    hooks: [
      {
        type: "command",
        command,
        timeout
      }
    ]
  });
}

function removeWeek7Hooks(settings) {
  ensureHooks(settings);
  let removed = 0;
  for (const eventName of Object.keys(settings.hooks)) {
    const entries = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
    const nextEntries = [];
    for (const entry of entries) {
      if (!entry || !Array.isArray(entry.hooks)) {
        nextEntries.push(entry);
        continue;
      }
      const hooks = entry.hooks.filter((hook) => {
        const command = String(hook && hook.command ? hook.command : "");
        const isWeek7 = command.includes("week7.js") || command.includes("HAPPYWEEK7");
        const isPrototype = command.includes("antml-guard.ps1") || command.includes("watch-antml-leaks.ps1");
        if (isWeek7 || isPrototype) {
          removed += 1;
          return false;
        }
        return true;
      });
      if (hooks.length > 0) {
        nextEntries.push({ ...entry, hooks });
      }
    }
    if (nextEntries.length > 0) {
      settings.hooks[eventName] = nextEntries;
    } else {
      delete settings.hooks[eventName];
    }
  }
  return removed;
}

function countWeek7Hooks(entries) {
  if (!Array.isArray(entries)) {
    return 0;
  }
  let count = 0;
  entries.forEach((entry) => {
    if (!entry || !Array.isArray(entry.hooks)) {
      return;
    }
    entry.hooks.forEach((hook) => {
      const command = String(hook && hook.command ? hook.command : "");
      if (command.includes("week7.js") || command.includes("HAPPYWEEK7")) {
        count += 1;
      }
    });
  });
  return count;
}

function hookCommand() {
  return `${quote(process.execPath)} ${quote(__filename)} hook`;
}

function quote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function assertMode(mode) {
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Invalid mode: ${mode}. Use warn, rewrite-once, or strict.`);
  }
}

function readStdin(callback) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    raw += chunk;
  });
  process.stdin.on("end", () => {
    callback(raw);
  });
  if (process.stdin.isTTY) {
    callback("");
  }
}

function writeHookJson(value) {
  process.stdout.write(JSON.stringify(value));
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function rmIfExists(filePath) {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}

function logLine(message) {
  ensureDir(appDir);
  const stamp = new Date().toISOString();
  fs.appendFileSync(logPath, `${stamp} ${message}\n`, "utf8");
}

function printVersion() {
  const packagePath = path.join(__dirname, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  console.log(pkg.version);
}

function printHelp() {
  console.log(`${APP_NAME}`);
  console.log("I'd be happy to work seven days a week!");
  console.log("");
  console.log("Usage:");
  console.log(`  ${CLI_NAME} install [--mode warn|rewrite-once|strict]`);
  console.log(`  ${CLI_NAME} uninstall [--purge]`);
  console.log(`  ${CLI_NAME} status`);
  console.log(`  ${CLI_NAME} test`);
  console.log(`  ${CLI_NAME} logs [--tail 50]`);
  console.log(`  ${CLI_NAME} hook`);
  console.log("");
  console.log("Default mode: rewrite-once");
}

function fail(message) {
  console.error(`${APP_NAME}: ${message}`);
  process.exitCode = 1;
}

main();
