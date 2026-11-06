import journal from "./meta/_journal.json";
import m0000 from "./0000_baseline.sql";
import m0001 from "./0001_booking_pages.sql";
import m0002 from "./0002_invitations.sql";

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
  },
};
