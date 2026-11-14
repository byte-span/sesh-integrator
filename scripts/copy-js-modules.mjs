// Copies plain JavaScript modules from src/ into dist/ unchanged. TypeScript
// does not emit them, and src/skill-contract.mjs must stay a verbatim copy.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "dist"), { recursive: true });
for (const name of readdirSync(join(root, "src")))
  if (name.endsWith(".mjs"))
    copyFileSync(join(root, "src", name), join(root, "dist", name));
