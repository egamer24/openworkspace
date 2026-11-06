import journal from "./meta/_journal.json";
import m0000 from "./0000_baseline.sql";
import m0001 from "./0001_lazy_chameleon.sql";
import m0002 from "./0002_open_susan_delgado.sql";
import m0003 from "./0003_omniscient_satana.sql";
import m0004 from "./0004_harsh_rattler.sql";
import m0005 from "./0005_office_previews.sql";
import m0006 from "./0006_local_spam_filter.sql";

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
    m0003,
    m0004,
    m0005,
    m0006,
  },
};
