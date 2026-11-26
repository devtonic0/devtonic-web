// Command-line parsing for the `devtonic-web` executable (bin/devtonic-web.mjs).
// Pure: no IO, so it can be unit-tested. The bin applies the result to the
// environment and then imports server/index.mjs.

export const USAGE = `Usage: devtonic-web [options]

Starts the devtonic-web bridge on 127.0.0.1 and opens the UI in your browser.

Options:
  -p, --port <n>   Port to listen on (default: $DEVTONIC_PORT or 4777)
      --no-open    Don't open a browser; just print the URL
      --open       Open a browser (default)
  -v, --version    Print the version and exit
  -h, --help       Show this help and exit

Environment:
  DEVTONIC_PORT      Port (overridden by --port)
  DEVTONIC_TOKEN     Fixed access token (default: random per start)
  DEVTONIC_HERMES    Path to the agent CLI (default: hermes on PATH)
  DEVTONIC_AGENT_URL Agent API base URL (default: http://127.0.0.1:8642)
  DEVTONIC_AGENT_API Set to 0 to always use the CLI instead of the agent API
`;

/** Parse argv (without node + script). Returns { help, version, open, port, error }. */
export function parseArgs(argv) {
  const out = { help: false, version: false, open: true, port: null, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "-v" || a === "--version") out.version = true;
    else if (a === "--open") out.open = true;
    else if (a === "--no-open") out.open = false;
    else if (a === "-p" || a === "--port" || a.startsWith("--port=")) {
      const v = a.startsWith("--port=") ? a.slice(7) : argv[++i];
      const n = Number(v);
      if (v === undefined || v === "" || !Number.isInteger(n) || n < 1 || n > 65535) {
        out.error = `invalid port: ${v === undefined ? "(missing)" : v}`;
        return out;
      }
      out.port = n;
    } else {
      out.error = `unknown option: ${a}`;
      return out;
    }
  }
  return out;
}
