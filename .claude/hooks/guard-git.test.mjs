// Runs the real hook as Claude Code does: JSON on stdin, decision on stdout.
// `pnpm test:hooks` (also in CI). Uses two empty temp repos, one on main and one on a feature branch.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

const HOOK = join(import.meta.dirname, "guard-git.mjs");

function repoOn(branch) {
  const dir = mkdtempSync(join(tmpdir(), "guard-git-"));
  execFileSync("git", ["init", "-q", "-b", branch], { cwd: dir });
  return dir;
}
const onMain = repoOn("main");
const onFeature = repoOn("arnav/feature");
after(() => {
  rmSync(onMain, { recursive: true, force: true });
  rmSync(onFeature, { recursive: true, force: true });
});

function decide(command, cwd) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_input: { command }, cwd }),
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.includes('"deny"') ? "deny" : "allow";
}

const cases = {
  deny: [
    ["push to main", "git push origin main", onFeature],
    ["push HEAD:main", "git push origin HEAD:main", onFeature],
    ["push with a full ref", "git push origin feat:refs/heads/main", onFeature],
    ["bare push while on main", "git push", onMain],
    ["push --all", "git push --all", onFeature],
    ["force refspec to main", "git push origin +x:main", onFeature],
    ["commit on main", "git commit -m x", onMain],
    ["merge with --delete-branch", "gh pr merge 65 --squash --delete-branch", onFeature],
    ["merge with -d", "gh pr merge 65 -s -d", onFeature],
    ["push --delete", "git push origin --delete arnav/x", onFeature],
    ["push -d", "git push -d origin arnav/x", onFeature],
    ["push :branch", "git push origin :arnav/x", onFeature],
    ["API branch delete", "gh api -X DELETE repos/o/r/git/refs/heads/arnav/x", onFeature],
    ["second command after &&", "pnpm check && git push origin main", onFeature],
    ["git -C into main repo", `git -C "${onMain}" commit -m x`, onFeature],
    ["the line that opens a heredoc", "git commit -F - <<'EOF'\nmsg\nEOF", onMain],
    ["a command after the heredoc ends", "cat > f <<EOF\ntext\nEOF\ngit push origin main", onFeature],
    ["a command after a here-string ends", "$m = @'\ntext\n'@\ngit push origin main", onFeature],
  ],
  allow: [
    ["push own branch", "git push -u origin arnav/x", onFeature],
    ["force-with-lease on a feature branch", "git push --force-with-lease", onFeature],
    ["force push to a feature branch", "git push --force origin arnav/x", onFeature],
    ["plain squash merge", "gh pr merge 65 --squash", onFeature],
    ["local branch delete", "git branch -d arnav/x", onFeature],
    ["pull on main", "git pull", onMain],
    ["unrelated command", "pnpm check", onMain],
    ["git push inside a quoted PR body", 'gh pr create --body "run: git push origin main"', onMain],
    ["git push inside a heredoc", "cat > body.md <<'EOF'\ngit push --force-with-lease\nEOF", onMain],
    ["git push inside <<-EOF", "cat <<-EOF\n\tgit push origin main\n\tEOF", onMain],
    ['git push inside <<"EOF"', 'cat <<"EOF"\ngit push origin :x\nEOF', onFeature],
    ["two heredocs on one line", "cat <<A <<B\ngit push origin main\nA\ngit commit -m x\nB", onMain],
    ["git push inside a PowerShell here-string", "$b = @'\ngit push origin main\n'@", onMain],
    ["git commit inside a double-quoted here-string", '$b = @"\ngit commit -m x\n"@', onMain],
    ["bash <<< here-string is not a heredoc", "cat <<< hello\npnpm check", onMain],
  ],
};

for (const [expected, list] of Object.entries(cases)) {
  describe(expected, () => {
    for (const [name, command, cwd] of list) {
      it(name, () => assert.equal(decide(command, cwd), expected));
    }
  });
}
