import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { EOL } from "node:os";
import { resolve } from "node:path";

function getLatestTag() {
  try {
    return execSync("git describe --abbrev=0 --tags").toString().trim();
  } catch (e) {
    console.warn(e);
    return execSync("git rev-list --max-parents=0 HEAD").toString().trim();
  }
}

const commits = execSync(`git log ${getLatestTag()}..HEAD  --pretty="format:%s%b"`)
  .toString()
  .trim()
  .split("\n")
  .reverse();

console.log(getLatestTag(), commits);

// Read package.json directly instead of `npm pkg get version` — the latter
// now returns workspace-scoped output (`{"taskora":"0.4.0"}`) when invoked
// inside a Bun/npm workspace, which broke $GITHUB_OUTPUT parsing.
const version = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"))
  .version as string;

const delimiter = `---${randomUUID()}---${EOL}`;

if (process.env.GITHUB_OUTPUT)
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `changelog<<${delimiter}${commits.join(
      EOL.repeat(2),
    )}${EOL}${delimiter}version=${version}${EOL}`,
  );
else console.log("Not github actions");
