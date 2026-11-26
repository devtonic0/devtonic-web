#!/usr/bin/env node
// `npx devtonic-web` entry point: parse flags, then start the bridge server.
import fs from "node:fs";
import { USAGE, parseArgs } from "../server/cli.mjs";

const opts = parseArgs(process.argv.slice(2));
if (opts.error) {
  process.stderr.write(`devtonic-web: ${opts.error}\n\n${USAGE}`);
  process.exit(2);
}
if (opts.help) { process.stdout.write(USAGE); process.exit(0); }
if (opts.version) {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}
if (opts.port) process.env.DEVTONIC_PORT = String(opts.port);
// server/index.mjs reads --open from argv.
process.argv = [process.argv[0], process.argv[1], ...(opts.open ? ["--open"] : [])];
await import("../server/index.mjs");
