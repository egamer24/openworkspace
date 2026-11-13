/** Why an address was refused for a mailbox, naming the workspace's mail domains (primary first). */
export function workspaceDomainRefusal(domains: readonly string[]) {
  return domains.length === 1
    ? `Use an address at ${domains[0]}`
    : `Use an address on one of the workspace's mail domains: ${domains.join(", ")}`;
}
