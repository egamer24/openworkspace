export const accessLinkKinds = ["invitation", "recovery"] as const;

export type AccessLinkKind = (typeof accessLinkKinds)[number];
