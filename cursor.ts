import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  createCursorCliRuntime,
  main,
} from "./src/adapters/cursor/cli.js";

const entryDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.basename(entryDir) === "dist"
  ? path.dirname(entryDir)
  : entryDir;
const runtime = createCursorCliRuntime({
  packageRoot,
  executablePath: process.argv[1],
});

process.exitCode = await main(process.argv.slice(2), runtime);
