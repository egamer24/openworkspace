import type journal from "./meta/_journal.json";

declare const migrations: {
  journal: typeof journal;
  migrations: Record<string, string>;
};

export default migrations;

