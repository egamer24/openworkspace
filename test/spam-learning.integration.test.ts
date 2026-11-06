import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mailboxStub } from "../worker/mailbox";

type Mailbox = ReturnType<typeof mailboxStub>;

const spammy = {
  from: "deals@pills.example",
  subject: "Cheap pills discount",
  body: "Buy cheap pills now with a huge discount at https://pills.example/offer",
};
const hammy = {
  from: "colleague@partner.example",
  subject: "Quarterly review agenda",
  body: "Here is the agenda for the quarterly review meeting with the project team.",
};

async function seed(mailbox: Mailbox, message: typeof spammy) {
  const id = crypto.randomUUID();
  await mailbox.insertEmail({
    id: `msg_${id}`,
    conversationId: `conv_${id}`,
    direction: "incoming",
    fromJson: [{ address: message.from, name: null }],
    toJson: [{ address: "me@example.test", name: null }],
    subject: message.subject,
    bodyText: message.body,
    timelineAt: new Date(),
    transportState: "received",
  });
  return `conv_${id}`;
}

async function tokenCounts(mailbox: Mailbox, token: string) {
  return runInDurableObject(mailbox, (_instance, state) =>
    state.storage.sql.exec<{ spam_count: number; ham_count: number }>(
      "select spam_count, ham_count from spam_tokens where token = ?",
      token,
    ).toArray()[0] ?? null
  );
}

async function deliver(mailbox: Mailbox, mailboxId: string, message: typeof spammy) {
  const id = `learn-${crypto.randomUUID()}`;
  const rawObjectKey = `test/spam-learning/${id}.eml`;
  await env.MAIL_STORAGE.put(rawObjectKey, [
    `From: ${message.from}`,
    "To: me@example.test",
    `Subject: ${message.subject}`,
    `Message-ID: <${id}@example.net>`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    message.body,
  ].join("\r\n"));
  await mailbox.enqueueInbound({
    id,
    mailboxId,
    rawObjectKey,
    envelopeFrom: "bounce@example.net",
    envelopeTo: "me@example.test",
    receivedAt: Date.now(),
  });
  await runInDurableObject(mailbox, async (instance, state) => {
    await state.storage.deleteAlarm();
    await instance.alarm();
  });
  return (await mailbox.getEmail(`msg_${id}`))!;
}

const learned = (email: { spamReasonsJson: Array<{ reason: string; points: number }> | null }) =>
  email.spamReasonsJson?.find((item) => item.reason.startsWith("Similar to messages"));

describe("spam learning", () => {
  it("trains only from Spam / Not spam moves, reverses, and does not double count", async () => {
    const mailboxId = `mbx_x_${crypto.randomUUID()}`;
    const mailbox = mailboxStub(env, mailboxId);
    const conversation = await seed(mailbox, spammy);

    expect(await mailbox.bulkUpdateConversations([conversation], "inbox", { mailboxState: "spam" })).toBe(1);
    expect(await mailbox.getSpamLearning()).toMatchObject({ spamMessages: 1, hamMessages: 0, active: false });
    expect(await tokenCounts(mailbox, "pills")).toEqual({ spam_count: 1, ham_count: 0 });

    // Trash and back into Spam: still one spam example.
    await mailbox.bulkUpdateConversations([conversation], "spam", { mailboxState: "trash" });
    await mailbox.bulkUpdateConversations([conversation], "trash", { mailboxState: "spam" });
    expect(await mailbox.getSpamLearning()).toMatchObject({ spamMessages: 1, hamMessages: 0 });
    expect(await tokenCounts(mailbox, "pills")).toEqual({ spam_count: 1, ham_count: 0 });

    // Not spam reverses the earlier decision.
    await mailbox.bulkUpdateConversations([conversation], "spam", { mailboxState: "active" });
    expect(await mailbox.getSpamLearning()).toMatchObject({ spamMessages: 0, hamMessages: 1 });
    expect(await tokenCounts(mailbox, "pills")).toEqual({ spam_count: 0, ham_count: 1 });

    // Archiving or moving between non-spam states does not train.
    await mailbox.bulkUpdateConversations([conversation], "inbox", { mailboxState: "archive" });
    const other = await seed(mailbox, hammy);
    await mailbox.bulkUpdateConversations([other], "inbox", { mailboxState: "archive" });
    expect(await mailbox.getSpamLearning()).toMatchObject({ spamMessages: 0, hamMessages: 1 });

    // A filter decision (block list) moves mail to Spam without training.
    await mailbox.setSpamSender("pills.example", "block");
    const blocked = await deliver(mailbox, mailboxId, spammy);
    expect(blocked.spamVerdict).toBe("spam");
    expect(await mailbox.getSpamLearning()).toMatchObject({ spamMessages: 0, hamMessages: 1 });

    expect(await mailbox.resetSpamLearning()).toEqual({
      spamMessages: 0,
      hamMessages: 0,
      tokens: 0,
      minimum: 20,
      active: false,
    });
  });

  it("adds a learned signal only after 20 spam and 20 ham examples", async () => {
    const mailboxId = `mbx_x_${crypto.randomUUID()}`;
    const mailbox = mailboxStub(env, mailboxId);
    const spamConversations = [];
    const hamConversations = [];
    for (let index = 0; index < 20; index += 1) {
      spamConversations.push(await seed(mailbox, spammy));
      hamConversations.push(await seed(mailbox, hammy));
    }
    // Not spam needs a conversation that is in Spam first.
    await mailbox.bulkUpdateConversations(hamConversations, "inbox", { mailboxState: "spam" });
    await mailbox.bulkUpdateConversations(hamConversations, "spam", { mailboxState: "active" });
    await mailbox.bulkUpdateConversations(spamConversations.slice(1), "inbox", { mailboxState: "spam" });
    expect(await mailbox.getSpamLearning()).toMatchObject({ spamMessages: 19, hamMessages: 20, active: false });

    const below = await deliver(mailbox, mailboxId, spammy);
    expect(learned(below)).toBeUndefined();

    await mailbox.bulkUpdateConversations(spamConversations.slice(0, 1), "inbox", { mailboxState: "spam" });
    expect(await mailbox.getSpamLearning()).toMatchObject({ spamMessages: 20, hamMessages: 20, active: true });

    const spam = await deliver(mailbox, mailboxId, spammy);
    expect(learned(spam)).toEqual({
      points: 35,
      reason: "Similar to messages you marked as spam (p=1.00)",
    });
    // The learned signal is the only one on this message.
    expect(spam.spamScore).toBe(35);
    expect(below.spamScore).toBe(0);

    const ham = await deliver(mailbox, mailboxId, hammy);
    expect(learned(ham)).toEqual({
      points: -20,
      reason: "Similar to messages you marked as not spam (p=0.00)",
    });
    expect(ham.spamScore).toBe(0);

    await mailbox.resetSpamLearning();
    expect(learned(await deliver(mailbox, mailboxId, spammy))).toBeUndefined();
  });

  it("prunes the least-used tokens past the cap", async () => {
    const mailbox = mailboxStub(env, `mbx_x_${crypto.randomUUID()}`);
    await mailbox.bulkUpdateConversations([await seed(mailbox, spammy)], "inbox", { mailboxState: "spam" });
    await mailbox.bulkUpdateConversations([await seed(mailbox, {
      ...spammy,
      body: "cheap pills",
    })], "inbox", { mailboxState: "spam" });
    await runInDurableObject(mailbox, (instance) => {
      const prune = Reflect.get(instance, "pruneSpamTokens") as (limit: number, pruneTo: number) => void;
      prune.call(instance, 5, 3);
    });
    const remaining = await runInDurableObject(mailbox, (_instance, state) =>
      state.storage.sql.exec<{ token: string }>("select token from spam_tokens order by token")
        .toArray().map((row) => row.token)
    );
    expect(remaining).toHaveLength(3);
    // Tokens seen in both messages survive.
    expect(remaining).toEqual(expect.arrayContaining(["cheap", "pills"]));
  });
});
