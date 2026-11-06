export const domainOnboardingSteps = [
  "routing",
  "catch_all",
  "sending",
  "events",
  "zone",
] as const;

export type DomainOnboardingStep = (typeof domainOnboardingSteps)[number];

export const domainOnboardingStatuses = [
  "ok",
  "skipped",
  "failed",
  "manual",
  "drifted",
  "rolled_back",
] as const;

export type DomainOnboardingStatus = (typeof domainOnboardingStatuses)[number];
