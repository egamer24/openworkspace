import { expect, test } from "playwright/test";
import type { Locator, Page } from "playwright/test";

/** Shows first-time setup with these domains, whatever the e2e stack's state. */
async function setupScreen(page: Page, setupMailDomains: string[]) {
  await page.route(/\/api\/bootstrap(?:\?|$)/u, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({
      response,
      json: {
        ...json,
        needsBootstrap: true,
        authenticated: false,
        user: null,
        setupMailDomains,
      },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Set up your workspace" })
  ).toBeVisible();
}

/** A paste, as the browser reports it to the field. */
async function paste(field: Locator, text: string) {
  await field.evaluate((input: HTMLInputElement, value) => {
    input.focus();

    // React tracks the value through the prototype's setter, not the instance's.
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;

    if (!setValue) throw new Error("HTMLInputElement has no value setter");
    setValue.call(input, value);
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertFromPaste",
        data: value,
      })
    );
  }, text);
}

test("setup with one domain takes the local part beside the fixed domain", async ({
  page,
}) => {
  await setupScreen(page, ["example.com"]);
  const email = page.getByRole("textbox", { name: "Email address" });
  await expect(email).toHaveAttribute("autocomplete", "off");
  await expect(page.getByText("@example.com", { exact: true })).toBeVisible();
  await expect(page.getByText("Your personal mailbox.")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Domain" })).toHaveCount(0);

  // A pasted address on the domain leaves its local part.
  await paste(email, "ada@example.com");
  await expect(email).toHaveValue("ada");
  await expect(email).not.toHaveAttribute("aria-invalid", "true");

  // One on another domain keeps the local part and says which domain to use.
  await paste(email, "ada@gmail.com");
  await expect(email).toHaveValue("ada");
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert")).toHaveText(
    "gmail.com isn't a workspace mail domain. Use an address at example.com."
  );
  await expect(page.getByText("Your personal mailbox.")).toHaveCount(0);

  // Typing again clears it; a typed address on another domain settles when the field is left.
  await email.fill("ada@other.test");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByLabel("Full name").focus();
  await expect(email).toHaveValue("ada");
  await expect(page.getByRole("alert")).toContainText(
    "other.test isn't a workspace mail domain"
  );
});

test("setup with several domains picks the domain beside the local part", async ({
  page,
}) => {
  await setupScreen(page, ["example.com", "example.org", "mail.example.net"]);
  const email = page.getByRole("textbox", { name: "Email address" });
  const domain = page.getByRole("combobox", { name: "Domain" });
  await expect(domain).toContainText("@example.com");

  // A typed address on a listed domain moves into the picker.
  await email.fill("ada@example.org");
  await expect(email).toHaveValue("ada");
  await expect(domain).toContainText("@example.org");

  await domain.click();
  await page.getByRole("option", { name: "@mail.example.net" }).click();
  await expect(domain).toContainText("@mail.example.net");

  // The account is created on the address the field shows.
  let sent: unknown;
  await page.route("**/api/auth/mock/bootstrap", async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({
      status: 409,
      json: {
        ok: false,
        error: { code: "CONFLICT", message: "Account is already set up" },
      },
    });
  });
  await page.getByLabel("Full name").fill("Ada Lovelace");
  await page
    .getByRole("button", { name: "Create local demo without passkey" })
    .click();
  await expect(page.getByText("Account is already set up")).toBeVisible();
  expect(sent).toEqual({ name: "Ada Lovelace", email: "ada@mail.example.net" });
});

test("inviting a person takes an address on the workspace's domain", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(
    page.getByRole("heading", { name: "Hello, Sam Brooks" })
  ).toBeVisible();
  await page.goto("/admin/people/invite");
  const email = page.getByRole("textbox", { name: "Personal mailbox" });
  const invite = page.getByRole("button", { name: "Invite", exact: true });
  await page.getByPlaceholder("Full name").fill("Grace Hopper");
  await expect(page.getByText("@demo.example", { exact: true })).toBeVisible();

  await paste(email, "grace@demo.example");
  await expect(email).toHaveValue("grace");
  await expect(invite).toBeEnabled();

  await paste(email, "grace@gmail.com");
  await expect(email).toHaveValue("grace");
  await expect(page.getByRole("alert")).toHaveText(
    "gmail.com isn't a workspace mail domain. Use an address at demo.example."
  );
  await expect(invite).toBeDisabled();
});
