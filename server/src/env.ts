import { existsSync } from "node:fs";

// Loads server/.env for local development. Imported before anything reads
// process.env; real deployments set variables in their dashboard instead.
if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}
