import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Guards the code-splitting work: no JS chunk in dist/ may exceed the budget.
// Skipped when dist/ is absent (run `npm run build` first; CI builds before testing).
const BUDGET = 800 * 1024;
const dir = new URL("../dist/assets/", import.meta.url).pathname;

test("every built JS chunk is under 800 kB", { skip: !existsSync(dir) && "dist/ not built" }, () => {
  const js = readdirSync(dir).filter(f => f.endsWith(".js"));
  assert.ok(js.length > 1, "expected multiple chunks");
  const over = js.map(f => [f, statSync(join(dir, f)).size]).filter(([, n]) => n > BUDGET);
  assert.deepEqual(over, [], `chunks over budget: ${over.map(([f, n]) => `${f}=${(n / 1024).toFixed(0)}kB`).join(", ")}`);
});
