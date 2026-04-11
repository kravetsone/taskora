import fs from "node:fs";
import path from "node:path";

// Read package.json directly instead of `npm pkg get version` — the latter
// now returns workspace-scoped JSON (`{"taskora":"0.4.0"}`) when invoked
// from a workspace-member directory, which previously got written into
// deno.json as the version string and broke `jsr publish` semver parsing.
const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"));
const version = pkg.version as string;

const jsrConfig = JSON.parse(String(fs.readFileSync("deno.json")));

jsrConfig.version = version;

fs.writeFileSync("deno.json", JSON.stringify(jsrConfig, null, 4));

console.log(`Prepared to release on JSR (version=${version})`);
