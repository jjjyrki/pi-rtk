/**
 * Exercises rewrite selection through Pi's real bash tool and user-bash hook.
 * Owns temporary CLI fixtures, not RTK's command parsing or Pi permissions.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const piAgentPath = fileURLToPath(
  import.meta.resolve("@earendil-works/pi-coding-agent"),
);
const piRequire = createRequire(piAgentPath);
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url, {
  alias: { "@earendil-works/pi-coding-agent": piAgentPath },
  moduleCache: false,
});
const { default: register } = await jiti.import(
  resolve(dirname(fileURLToPath(import.meta.url)), "../index.ts"),
);

async function fixture(context, rewritten = "printf optimized") {
  const root = await mkdtemp(join(tmpdir(), "pi-rtk-rewrite-"));
  const oldPath = process.env.PATH;
  const oldRewrite = process.env.PI_RTK_TEST_REWRITE;

  context.after(async () => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;

    if (oldRewrite === undefined) delete process.env.PI_RTK_TEST_REWRITE;
    else process.env.PI_RTK_TEST_REWRITE = oldRewrite;

    await rm(root, { recursive: true, force: true });
  });

  await writeFile(
    join(root, "rtk"),
    `#!/usr/bin/env node
if (process.argv[2] === "rewrite") process.stdout.write(process.env.PI_RTK_TEST_REWRITE);
else { process.stderr.write("unsupported rewritten command"); process.exitCode = 1; }
`,
    { mode: 0o755 },
  );

  await writeFile(
    join(root, "rg"),
    '#!/usr/bin/env node\nprocess.stdout.write("marker.txt\\n");\n',
    { mode: 0o755 },
  );

  await writeFile(
    join(root, "eslint"),
    "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ok:true}));\n",
    { mode: 0o755 },
  );

  await writeFile(
    join(root, "git"),
    "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
    { mode: 0o755 },
  );

  await writeFile(join(root, "marker.txt"), "native\n");

  process.env.PATH = `${root}${delimiter}${oldPath ?? ""}`;
  process.env.PI_RTK_TEST_REWRITE = rewritten;

  const hooks = new Map();
  const commands = new Map();
  let tool;
  const cwd = process.cwd();

  try {
    process.chdir(root);
    register({
      on: (name, handler) => hooks.set(name, handler),
      registerCommand: (name, command) => commands.set(name, command),
      registerTool: (registered) => {
        tool = registered;
      },
    });
  } finally {
    process.chdir(cwd);
  }

  const extensionContext = {
    ui: {
      notify() {},
      setStatus() {},
      theme: { fg: (_color, text) => text },
    },
  };

  await commands.get("rtk").handler("enable", extensionContext);

  return {
    root,
    run: async (command) => {
      const result = await tool.execute("test", { command, timeout: 5 });

      return result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
    },
    user: (command, excludeFromContext = false) =>
      hooks.get("user_bash")({ command, excludeFromContext }, extensionContext),
  };
}

test("file enumeration stays native in both execution paths", async (context) => {
  const current = await fixture(context);

  assert.equal(await current.run("rg --files"), "marker.txt\n");
  assert.equal(current.user("rg --files"), undefined);
  assert.equal(current.user("rg '--files'"), undefined);
});

test("ripgrep options bypass rewriting in both hooks", async (context) => {
  const current = await fixture(context, "rtk grep incompatible");

  for (const command of [
    "rg --files -g '*.ts'",
    "rg --hidden literal .",
    "rg --glob='*.ts' literal .",
    "rg -g'*.ts' literal .",
    "rg --type=ts literal .",
    "rg -t ts literal .",
    "rg -tts literal .",
    "rg -F 'a.b' .",
    "rg '-F' 'a.b' .",
    "printf 'before\\n'; rg --hidden -g '*.ts' literal .",
    "'rg' literal source.ts",
  ]) {
    assert.match(await current.run(command), /marker\.txt/u, command);
    assert.equal(current.user(command), undefined, command);
  }
});

test("ripgrep commands retain native results when ripgrep is available", async (context) => {
  const rg = spawnSync("which", ["rg"], { encoding: "utf8" });

  if (rg.status !== 0) {
    context.skip("ripgrep is not installed");

    return;
  }

  const current = await fixture(context, "rtk grep incompatible");

  await rm(join(current.root, "rg"));
  await symlink(rg.stdout.trim(), join(current.root, "rg"));
  await writeFile(join(current.root, "source.ts"), "literal a.b\n");
  await writeFile(join(current.root, ".hidden.ts"), "literal axb\n");

  for (const command of [
    "rg --files -g '*.ts'",
    "rg --hidden literal .",
    "rg --glob='*.ts' literal .",
    "rg -g'*.ts' literal .",
    "rg --type=ts literal .",
    "rg -tts literal .",
    "rg -F 'a.b' .",
    "rg '-F' 'a.b' .",
    "printf 'before\\n'; rg --hidden -g '*.ts' literal .",
    "rg literal source.ts",
  ]) {
    const native = spawnSync("bash", ["-c", command], {
      cwd: current.root,
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(native.status, 0, `${command}: ${native.stderr}`);
    assert.deepEqual(
      (await current.run(command)).trimEnd().split("\n").sort(),
      native.stdout.trimEnd().split("\n").sort(),
      command,
    );
    assert.equal(current.user(command), undefined, command);
  }
});

test("native find expressions are not sent to RTK's subset", async (context) => {
  const current = await fixture(context, "rtk find . -not -name ignored");
  const command = "find . -name marker.txt -not -path ./missing";

  assert.equal(await current.run(command), "./marker.txt\n");
  assert.equal(current.user(command), undefined);
});

test("explicit machine-readable formats stay native", async (context) => {
  const current = await fixture(context);

  for (const command of [
    "eslint --format json",
    "eslint --format=json",
    "eslint -f json",
    "eslint '--format' 'json'",
  ]) {
    assert.deepEqual(JSON.parse(await current.run(command)), { ok: true });
    assert.equal(current.user(command), undefined);
  }

  assert.equal(current.user("git status --porcelain=v1"), undefined);
  assert.equal(current.user("gh pr view 1 --json url"), undefined);
  assert.equal(current.user("npx --package=pnpm pnpm install"), undefined);
});

test("end-of-options separators retain native argument meaning", async (context) => {
  const current = await fixture(context, "rtk git diff -- marker.txt");
  const command = "git diff -- marker.txt";

  assert.deepEqual(JSON.parse(await current.run(command)), [
    "diff",
    "--",
    "marker.txt",
  ]);
  assert.equal(current.user(command), undefined);
});

test("pipes and redirections retain their original producer output", async (context) => {
  const current = await fixture(context);

  assert.equal(
    await current.run("printf native | /usr/bin/tr a-z A-Z"),
    "NATIVE",
  );
  await current.run("printf native > captured.txt");
  assert.equal(
    await readFile(join(current.root, "captured.txt"), "utf8"),
    "native",
  );
  assert.equal(current.user("printf native | /usr/bin/tr a-z A-Z"), undefined);
});

test("unresolved shell values are not classified as safe rewrites", async (context) => {
  const current = await fixture(context);

  assert.equal(current.user('eslint --format "$FORMAT"'), undefined);
  assert.equal(current.user("printf `date`"), undefined);
});

test("ordinary rewrites and context-excluded user commands keep their behavior", async (context) => {
  const current = await fixture(context);

  assert.equal(await current.run("printf original"), "optimized");
  assert.equal(
    typeof current.user("printf original").operations.exec,
    "function",
  );
  assert.equal(current.user("printf original", true), undefined);
});
