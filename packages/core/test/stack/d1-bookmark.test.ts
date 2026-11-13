import { expect, it } from "bun:test";

import { D1_BOOKMARK_HEADER as HEADER } from "../../shared/d1-bookmark.ts";
import { required } from "../../shared/invariant.ts";
import { useFreshWorkspace, worker } from "../../testing/client.ts";

useFreshWorkspace();

it("hands the client a D1 bookmark and continues from the one it sends", async () => {
  const signUp = await worker.fetch(
    new Request("http://example.test/api/auth/mock/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
    })
  );

  expect(signUp.status).toBe(200);

  const afterWrite = required(
    signUp.headers.get(HEADER),
    "a write answers with a bookmark"
  );

  expect(afterWrite).toBeTruthy();

  const cookie = required(
    signUp.headers.get("set-cookie")?.split(";", 1)[0],
    "sign-up sets a session cookie"
  );

  // Reading with it sees the write (the new session) and returns a bookmark
  // no older than it.
  const state = await worker.fetch(
    new Request("http://example.test/api/bootstrap", {
      headers: { cookie, [HEADER]: afterWrite },
    })
  );

  expect(await state.json()).toMatchObject({ authenticated: true });

  const next = required(
    state.headers.get(HEADER),
    "a read answers with a bookmark"
  );

  expect(next).toBeTruthy();
  expect(next >= afterWrite).toBe(true);

  // A malformed bookmark is ignored (the request starts on the primary).
  const malformed = await worker.fetch(
    new Request("http://example.test/api/bootstrap", {
      headers: { cookie, [HEADER]: "not a bookmark" },
    })
  );

  expect(malformed.status).toBe(200);
  expect(await malformed.json()).toMatchObject({ authenticated: true });
});
