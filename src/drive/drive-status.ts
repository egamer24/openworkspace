import { useQuery } from "@tanstack/react-query";
import { api, responseJson } from "@/lib/api";

/** Drive is an optional module; its status route is a 404 while an admin has it switched off. */
export function useDriveStatus() {
  return useQuery({
    queryKey: ["drive-status"],
    queryFn: async () => responseJson(await api.api.drive.status.$get()),
    retry: false,
    staleTime: 60_000,
  });
}
