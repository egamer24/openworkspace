import { describe, expect, it } from "bun:test";

import {
  completesListedDomain,
  resolveDomainAddress,
  settleAddressText,
  splitAddressText,
} from "../../src/lib/domain-address.ts";
import type { DomainAddressState } from "../../src/lib/domain-address.ts";

const one = ["example.com"];
const several = ["example.com", "example.org", "example.co"];

const empty = (domain = "example.com"): DomainAddressState => ({
  text: "",
  domain,
  rejectedDomain: null,
});

describe("address fields on the workspace's mail domains", () => {
  it("splits typed or pasted text at its first @", () => {
    expect(splitAddressText(" ada ")).toEqual({
      localPart: "ada",
      domain: null,
    });
    expect(splitAddressText(" Ada@Example.ORG ")).toEqual({
      localPart: "Ada",
      domain: "example.org",
    });
    expect(splitAddressText("ada@")).toEqual({ localPart: "ada", domain: "" });
  });

  it("builds the address on the picked domain", () => {
    expect(resolveDomainAddress({ ...empty(), text: "ada" }, one)).toEqual({
      address: "ada@example.com",
      error: null,
      validity: "",
    });
    expect(
      resolveDomainAddress({ ...empty("example.org"), text: "ada" }, several)
        .address
    ).toBe("ada@example.org");
    expect(resolveDomainAddress(empty(), one).address).toBeNull();
  });

  it("moves a full address on a listed domain into the local part and the picker", () => {
    expect(settleAddressText(empty(), "ada@Example.org", several)).toEqual({
      text: "ada",
      domain: "example.org",
      rejectedDomain: null,
    });
    expect(settleAddressText(empty(), "ada@", one)).toEqual({
      text: "ada",
      domain: "example.com",
      rejectedDomain: null,
    });
  });

  it("keeps the local part of an address on another domain and says which domains to use", () => {
    const settled = settleAddressText(empty(), "ada@gmail.com", one);
    expect(settled).toEqual({
      text: "ada",
      domain: "example.com",
      rejectedDomain: "gmail.com",
    });
    expect(resolveDomainAddress(settled, one)).toEqual({
      address: null,
      error:
        "gmail.com isn't a workspace mail domain. Use an address at example.com.",
      validity: "Use an address at example.com",
    });
    expect(
      resolveDomainAddress(
        settleAddressText(empty(), "ada@gmail.com", several),
        several
      ).validity
    ).toBe(
      "Use an address on one of the workspace's mail domains: example.com, example.org, example.co"
    );
  });

  it("blocks text that names another domain while it is still being typed", () => {
    const typing = { ...empty(), text: "ada@gmai" };
    expect(resolveDomainAddress(typing, one)).toMatchObject({
      address: null,
      error: null,
      validity: "Use an address at example.com",
    });
    expect(
      resolveDomainAddress({ ...empty(), text: "ada@example.org" }, several)
        .address
    ).toBe("ada@example.org");
  });

  it("settles a typed domain only once no other listed domain continues it", () => {
    expect(completesListedDomain("ada@example.org", several)).toBe(true);
    expect(completesListedDomain("ada@example.co", several)).toBe(false);
    expect(completesListedDomain("ada@example.c", several)).toBe(false);
    expect(completesListedDomain("ada", several)).toBe(false);
  });
});
