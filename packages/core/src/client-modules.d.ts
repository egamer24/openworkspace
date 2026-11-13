/** The client modules built into the browser app (see `alchemy/client.ts`). */
declare module "virtual:open-workspace/modules" {
  const modules: readonly import("./modules").ClientModule[];
  export default modules;
}
