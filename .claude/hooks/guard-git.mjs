#!/usr/bin/env node
// PreToolUse guard for Bash and PowerShell commands (see CLAUDE.md §1).
// Blocks only what could touch main/master directly: pushes that would update it, --mirror/--all
// pushes, `git push --no-verify` (it skips the pre-push guard), and commits while on main/master.
// Force pushes to feature branches and `gh pr merge` are allowed.
// Fails open on internal errors: the git pre-push hook and GitHub branch protection are the
// next layers, and a crashing guard must not block unrelated shell commands.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const PROTECTED = new Set(["main", "master"]);

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `${reason} (blocked by .claude/hooks/guard-git.mjs; see CLAUDE.md §1-2)`,
      },
    }),
  );
  process.exit(0);
}

// Split a command line into segments on shell separators, ignoring separators inside quotes.
function splitSegments(cmd) {
  const segments = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
      segments.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  segments.push(cur);
  return segments.map((s) => s.trim()).filter(Boolean);
}

function tokenize(segment) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

function currentBranch(cwd) {
  try {
    return execFileSync("git", ["symbolic-ref", "--short", "-q", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    return null; // not a repo, detached HEAD, or git unavailable
  }
}

const isGit = (t) => /(^|[\\/])git(\.exe)?$/i.test(t);
const stripRef = (r) => r.replace(/^refs\/heads\//, "");

// Short-flag cluster like -uf: true if `flag` appears before any value-taking flag.
function clusterHas(token, flag, valueFlags) {
  if (!/^-[a-zA-Z]{2,}$/.test(token)) return token === `-${flag}`;
  for (const ch of token.slice(1)) {
    if (ch === flag) return true;
    if (valueFlags.includes(ch)) return false;
  }
  return false;
}

function checkPush(args, branch) {
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--no-verify") deny("`git push --no-verify` skips the pre-push guard");
    if (a === "--mirror" || a === "--all") deny(`\`git push ${a}\` would push main`);
    if (a === "-o" || a === "--push-option" || a === "--repo" || a === "--receive-pack" || a === "--exec") {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    positional.push(a);
  }
  const refspecs = positional.slice(1); // first positional is the remote
  if (refspecs.length === 0) {
    if (branch && PROTECTED.has(branch))
      deny(
        `You are on '${branch}'; pushing would update ${branch}. Create a branch: git switch -c <your-name>/<topic>`,
      );
    return;
  }
  for (const spec of refspecs) {
    const dstRaw = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec;
    const dst = stripRef(dstRaw === "HEAD" ? (branch ?? "") : dstRaw);
    if (PROTECTED.has(dst))
      deny(`Pushing to '${dst}' is not allowed; push your feature branch and open a PR`);
  }
}

function checkCommitLike(sub, args, branch) {
  if (branch && PROTECTED.has(branch))
    deny(
      `\`git ${sub}\` on '${branch}' is not allowed; local ${branch} is read-only. Create a branch: git switch -c <your-name>/<topic>`,
    );
}

function checkSegment(tokens, cwd) {
  // Skip env assignments (FOO=1 git push) and wrappers.
  let i = 0;
  while (i < tokens.length && (/^\w+=/.test(tokens[i]) || tokens[i] === "env" || tokens[i] === "command"))
    i++;
  const head = tokens[i];
  if (!head) return cwd;

  if (head === "cd" || head === "Set-Location" || head === "pushd") {
    const target = tokens[i + 1];
    return target ? resolve(cwd, target) : cwd;
  }

  if (!isGit(head)) return cwd;

  // Skip git global options to find the subcommand.
  let gitCwd = cwd;
  i++;
  while (i < tokens.length && tokens[i].startsWith("-")) {
    const opt = tokens[i];
    if (opt === "-C") {
      gitCwd = resolve(gitCwd, tokens[i + 1] ?? ".");
      i += 2;
    } else if (opt === "-c") {
      i += 2;
    } else {
      i++;
    }
  }
  const sub = tokens[i];
  const args = tokens.slice(i + 1);
  if (!sub) return cwd;

  const branch = currentBranch(gitCwd);
  if (sub === "push") checkPush(args, branch);
  if (["commit", "cherry-pick", "revert", "am"].includes(sub)) checkCommitLike(sub, args, branch);
  return cwd;
}

try {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw || "{}");
  const command = input?.tool_input?.command;
  if (typeof command !== "string" || !/\b(git|gh)\b/.test(command)) process.exit(0);

  let cwd = input.cwd || process.cwd();
  for (const segment of splitSegments(command)) cwd = checkSegment(tokenize(segment), cwd);
  process.exit(0);
} catch (err) {
  process.stderr.write(`guard-git: internal error, allowing command: ${err?.message ?? err}\n`);
  process.exit(0);
}
