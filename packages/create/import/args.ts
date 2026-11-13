import { parseArgs } from "node:util";
import type { ParseArgsConfig } from "node:util";

type Options = NonNullable<ParseArgsConfig["options"]>;

/**
 * Joins each long string option to a value that starts with a dash, so
 * `--token -abc` reads as `--token=-abc`. `parseArgs` rejects the spaced
 * form as ambiguous, but tokens, passwords and other secrets may begin with
 * a dash. A dash value that is itself one of the options (`--token --login`)
 * is left alone, and so is everything after `--`.
 */
export function joinDashValues(args: readonly string[], options: Options) {
  const known = new Set<string>();
  const takesValue = new Set<string>();

  for (const [name, option] of Object.entries(options)) {
    known.add(`--${name}`);

    if (option.short) known.add(`-${option.short}`);

    if (option.type === "string") takesValue.add(`--${name}`);
  }

  const isOption = (arg: string) =>
    arg === "--" || known.has(arg.split("=", 1)[0] ?? arg);

  const joined: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (arg === "--") {
      joined.push(...args.slice(index));
      break;
    }

    const next = args[index + 1];

    if (takesValue.has(arg) && next?.startsWith("-") && !isOption(next)) {
      joined.push(`${arg}=${next}`);
      index += 1;
    } else {
      joined.push(arg);
    }
  }

  return joined;
}

/** `parseArgs` that accepts option values starting with a dash (`joinDashValues`). */
export function parseCliArgs<T extends ParseArgsConfig>(config: T) {
  return parseArgs({
    ...config,
    args: joinDashValues(config.args ?? [], config.options ?? {}),
  });
}
