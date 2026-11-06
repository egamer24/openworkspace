import journal from "./meta/_journal.json";
import m0000 from "./0000_baseline.sql";
import m0001 from "./0001_invitations.sql";

export default {
  journal,
  migrations: {
    m0000,
    m0001,
  },
};
