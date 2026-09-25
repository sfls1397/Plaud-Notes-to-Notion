#!/usr/bin/env node
/**
 * npm bin entry. Always invokes main — do not rely on dist/cli.js detecting a
 * symlinked argv[1] (that check silently exited 0 on the Mini for EdgeCore).
 */
import { main } from "../dist/cli.js";

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    const message = err instanceof Error && err.message ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
