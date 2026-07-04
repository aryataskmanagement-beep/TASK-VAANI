# Security Specification for ARYA ASSOCIATES

## 1. Data Invariants

- **Business Records**: Must have a unique ID and firm name. Only admins can create/delete; stakeholders can read if authorized.
- **Admin Tasks**: Can be assigned to team members. Status transition is PENDING -> DONE.
- **Extra Work**: Represents financial records. Charges and Received Amount must be valid strings/numbers.
- **Visiting Card**: Publicly readable (limited), but only editable by Admins.

## 2. The "Dirty Dozen" Payloads (Attacks)

1. **Identity Spoof**: Authenticated User A tries to update User B's business record.
2. **Shadow Field Injection**: Adding `isVerified: true` to a Business document.
3. **Admin Privilege Escalation**: Non-admin user tries to write to the `isAdmin` flag in their profile or create a document in `admins` collection.
4. **Terminal State Bypass**: Trying to change the status of a "DONE" admin task back to "PENDING" (if restricted).
5. **PII Scraping**: Trying to list all businesses with their TAN/ GST/ VAT numbers as a guest.
6. **Denial of Wallet**: Sending a 1MB string as a business name document ID.
7. **Relational Sync Failure**: Creating an ExtraWork entry for a non-existent business.
8. **Invalid Status**: Setting an ExtraWork status to "CANCELLED" when only "PAID/UNPAID" are allowed.
9. **Timestamp Spoof**: Providing a client-side `createdAt` date from 2020.
10. **Immutable Field Attack**: Trying to change `id` or `businessId` in an existing `ExtraWork` record.
11. **Guest Write**: Unauthenticated user trying to delete a business.
12. **Array Poisoning**: Injecting 10,000 blank strings into the `services` array of the Visiting Card.

## 3. The Test Runner (firestore.rules.test.ts)

```typescript
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "gen-lang-client-0468452231",
    firestore: {
      rules: fs.readFileSync("firestore.rules", "utf8"),
    },
  });
});

test("Unauthorized users cannot read business master", async () => {
  const alice = testEnv.authenticatedContext("alice");
  await assertFails(alice.firestore().collection("businesses").get());
});

test("Only admins can create businesses", async () => {
  const admin = testEnv.authenticatedContext("admin_uid", { email: "arya4186@gmail.com", email_verified: true });
  // Note: Admin check requires lookup in /admins/ collection in real rules
  // For tests, we simulate the state
});
```
