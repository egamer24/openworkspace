import { api, responseJson } from "../lib/api";

/** The administration overview every admin screen reads, shared through the query cache. */
export const adminStateQuery = {
  queryKey: ["admin-state"],
  queryFn: async () => responseJson(await api.api.admin.state.$get()),
};
