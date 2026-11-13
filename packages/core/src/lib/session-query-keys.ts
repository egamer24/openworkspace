export const sessionQueryKeys = {
  account: ["account-sessions"] as const,
  admin: ["admin-user-sessions"] as const,
  adminUser: (userId: string) => ["admin-user-sessions", userId] as const,
};
