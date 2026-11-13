import { projectAlchemy } from "./setup/alchemy.ts";
import { createUsage, parseCreateArgs } from "./setup/args.ts";
import { cloudflareApi } from "./setup/cloudflare-api.ts";
import { runCreate } from "./setup/flow.ts";
import { clackUi } from "./setup/ui.ts";

/** `bun create @open-workspace`: the flow in setup/flow.ts on the real terminal, Alchemy, Cloudflare API and bun. */
export function main(args: readonly string[]) {
  const parsed = parseCreateArgs(args);

  if ("error" in parsed) {
    console.error(`${parsed.error}\n\n${createUsage}`);

    return 2;
  }

  const { options } = parsed;

  if (options.help) {
    console.log(createUsage);

    return 0;
  }

  const interactive =
    !options.yes && Boolean(process.stdin.isTTY && process.stdout.isTTY);

  return runCreate(options, {
    ui: clackUi,
    cwd: process.cwd(),
    env: process.env,
    interactive,
    async install(directory) {
      const child = Bun.spawn([process.execPath, "install"], {
        cwd: directory,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });

      const [output, exitCode] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
      ]);

      return { ok: exitCode === 0, output };
    },
    alchemy: (directory, profile) =>
      projectAlchemy(directory, { profile, interactive }),
    cloudflare: (auth) => cloudflareApi(auth),
    git: (directory) => startRepository(directory),
  });
}

/** `git init` plus a first commit, in a project that isn't already inside a repository. */
export async function startRepository(directory: string) {
  if (!Bun.which("git")) return "skipped";

  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", ...args], {
      cwd: directory,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });

    return (await child.exited) === 0;
  };

  if (await git("rev-parse", "--is-inside-work-tree")) return "skipped";

  if (!(await git("init", "--quiet", "--initial-branch=main"))) {
    return "skipped";
  }

  if (!(await git("add", "--all"))) return "initialized";

  const committed = await git(
    "commit",
    "--quiet",
    "--message",
    "Create the OpenWorkspace project"
  );

  return committed ? "committed" : "initialized";
}
