import * as argon2 from "argon2";
import { eq } from "drizzle-orm";
import { Id } from "@keepwell/contracts";
import { merchants, merchantUsers, type Db } from "@keepwell/db";

const PASSWORD_HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashMerchantPassword(password: string): Promise<string> {
  if (Buffer.byteLength(password, "utf8") < 12) {
    throw new Error("Merchant passwords must be at least 12 bytes");
  }
  return argon2.hash(password, PASSWORD_HASH_OPTIONS);
}

/** Provision or rotate the single demo merchant owner without ever printing the password. */
export async function provisionMerchantOwner(
  db: Db,
  input: { merchantId: string; email: string; password: string },
): Promise<{ id: string; merchantId: string; email: string }> {
  const merchantId = Id.parse(input.merchantId);
  const email = input.email.trim().toLowerCase();
  const emailResult = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!emailResult) throw new Error("Merchant owner email is invalid");
  const passwordHash = await hashMerchantPassword(input.password);

  return db.forMerchant(merchantId, async (tx) => {
    const [merchant] = await tx
      .select({ id: merchants.id })
      .from(merchants)
      .where(eq(merchants.id, merchantId))
      .limit(1);
    if (!merchant) throw new Error("Seed the Pantry Plan merchant before provisioning its owner");

    const [user] = await tx
      .insert(merchantUsers)
      .values({ merchantId, email, passwordHash, role: "owner" })
      .onConflictDoUpdate({
        target: [merchantUsers.merchantId, merchantUsers.email],
        set: { passwordHash, role: "owner" },
      })
      .returning({ id: merchantUsers.id, merchantId: merchantUsers.merchantId, email: merchantUsers.email });
    if (!user) throw new Error("Merchant user provisioning returned no row");
    return user;
  });
}
