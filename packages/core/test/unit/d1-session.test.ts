import { describe, expect, it } from "bun:test";

import { D1_BOOKMARK_HEADER } from "../../shared/d1-bookmark.ts";
import { requestD1Session, withBookmark } from "../../worker/lib/d1-session.ts";

/** A D1 binding that records how each session started and returns `bookmark`. */
function fakeD1(bookmark: string | null) {
  const started: string[] = [];

  const session: Pick<D1DatabaseSession, "getBookmark"> = {
    getBookmark: () => bookmark,
  };

  const fake: Pick<D1Database, "withSession"> = {
    withSession(constraint = "first-unconstrained") {
      started.push(constraint);

      // SAFETY: requestD1Session and withBookmark use only getBookmark of a session.
      return session as D1DatabaseSession;
    },
  };

  // SAFETY: requestD1Session calls only withSession on the binding.
  const binding = fake as D1Database;

  return { binding, started };
}

const request = (headers: Record<string, string> = {}) =>
  new Request("https://example.test/api/x", { headers });

describe("D1 sessions per request", () => {
  it("continues from the client's bookmark, else starts on the primary", () => {
    const { binding, started } = fakeD1(null);
    requestD1Session(
      binding,
      request({ [D1_BOOKMARK_HEADER]: "0000002a-00000003-00005000-abcdef" })
    );
    requestD1Session(binding, request());
    requestD1Session(
      binding,
      request({ [D1_BOOKMARK_HEADER]: "not a bookmark; drop table" })
    );
    expect(started).toEqual([
      "0000002a-00000003-00005000-abcdef",
      "first-primary",
      "first-primary",
    ]);
  });

  it("returns the session's bookmark, also on immutable responses", async () => {
    const { binding } = fakeD1("0000002b-00000001-00005001-123456");
    const session = binding.withSession("first-primary");
    const plain = withBookmark(new Response("ok"), session);
    expect(plain.headers.get(D1_BOOKMARK_HEADER)).toBe(
      "0000002b-00000001-00005001-123456"
    );

    // Like a fetched response passed through: its headers cannot change.
    const immutable = new Headers();
    immutable.set = () => {
      throw new TypeError("immutable");
    };

    const fetched = new Response("body");
    Object.defineProperty(fetched, "headers", { value: immutable });
    const copied = withBookmark(fetched, session);
    expect(copied).not.toBe(fetched);
    expect(copied.headers.get(D1_BOOKMARK_HEADER)).toBe(
      "0000002b-00000001-00005001-123456"
    );
    expect(await copied.text()).toBe("body");
  });

  it("adds nothing without a bookmark", () => {
    const { binding } = fakeD1(null);

    const response = withBookmark(
      new Response("ok"),
      binding.withSession("first-primary")
    );

    expect(response.headers.has(D1_BOOKMARK_HEADER)).toBe(false);
  });
});
