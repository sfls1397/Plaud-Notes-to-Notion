#!/usr/bin/env node
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
