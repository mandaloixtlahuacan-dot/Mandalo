/**
 * Corre todos los escenarios del simulador y falla si sale texto interno
 * o el mismo mensaje dos veces seguidas al mismo número.
 * La revisión vive en scripts/simulate-customer.ts (process.exitCode).
 */
import { spawnSync } from "node:child_process";

const run = spawnSync(
  "npx",
  ["tsx", "--import", "./scripts/sim/preload.mjs", "scripts/simulate-customer.ts"],
  { stdio: "inherit" },
);

if (run.status !== 0) {
  console.error("check-sim-outbound: el simulador encontró texto interno o un duplicado");
  process.exit(run.status ?? 1);
}
