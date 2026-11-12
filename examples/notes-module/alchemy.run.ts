import * as Cloudflare from "@alchemy.run/cloudflare";
import { OpenWorkspace, providers } from "@open-workspace/core/alchemy";
import * as Alchemy from "alchemy";

import { Notes } from "./modules/notes/alchemy.ts";

// A deployment with the Notes module. With mail, install @open-workspace/email
// and list Email() before Notes(): the first module's home is the app's "/".
export default Alchemy.Stack(
  "NotesExample",
  { providers: providers(), state: Cloudflare.state() },
  OpenWorkspace({
    hostname: "workspace.example.com",
    mailDomains: ["example.com"],
    modules: [Notes()],
  })
);
