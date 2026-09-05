from pathlib import Path


def replace_generated_text(path: str, unsafe: str, safe: str) -> None:
    generated_file = Path(path)
    contents = generated_file.read_text()
    if safe in contents:
        return
    if unsafe not in contents:
        raise RuntimeError(f"Upstream content changed; review the safety patch for {path}")
    generated_file.write_text(contents.replace(unsafe, safe))


replace_generated_text(
    "apps/web/.agents/skills/convex-improve-convex-plugin/SKILL.md",
    """1. Run the anteater-served helper: `curl -fsSL \"<anteater>/send-transcript\" | bash -s -- --idea \"<one-line app idea from this session>\"`.
2. If it prints CONSENT_REQUIRED (exit 4), the user has not chosen yet — ask them to share Always, Just this once, or Never, then re-run appending --consent always|once|never. Do not send until they answer.
3. Watch for output markers: REVIEW_SOURCE (transcript found), REVIEW_SUBMITTED id=... (accepted), REVIEW_DONE status=done (findings ready).
4. Summarize the highest-severity findings for the user: title → target → suggestedFix, then wins. Keep the summary about the system, not the user's data.""",
    """1. Ask the user whether to share Always, Just this once, or Never. If they choose Never, stop. Do not download or run the helper until they choose to share.
2. Download the helper without executing it: `curl -fsSL \"<anteater>/send-transcript\" --output /tmp/send-transcript`. Show the user the source and SHA-256 digest, and get explicit approval to execute that exact file.
3. Run the approved local file: `bash /tmp/send-transcript --idea \"<one-line app idea from this session>\" --consent always|once`.
4. Watch for output markers: REVIEW_SOURCE (transcript found), REVIEW_SUBMITTED id=... (accepted), REVIEW_DONE status=done (findings ready).
5. Summarize the highest-severity findings for the user: title → target → suggestedFix, then wins. Keep the summary about the system, not the user's data.""",
)
replace_generated_text(
    "apps/web/.agents/skills/convex-improve-convex-plugin/SKILL.md",
    "- REVIEW_NO_TRANSCRIPT means no Claude/Codex .jsonl was found — tell the user.",
    """- Never pipe a network response into a shell. Execute only the downloaded file that the user inspected and approved.
- REVIEW_NO_TRANSCRIPT means no Claude/Codex .jsonl was found — tell the user.""",
)

billing_path = "apps/web/.agents/skills/convex-billing/SKILL.md"
billing_file = Path(billing_path)
billing_file.write_text(billing_file.read_text().replace("\t", "  "))
replace_generated_text(
    billing_path,
    """5. Create `convex/billing.ts` with a checkout action and a subscription-gate query:
   ```ts""",
    """5. Create `convex/billing.ts` with a checkout action and a subscription-gate query:
   <!-- prettier-ignore -->
   ```ts""",
)
replace_generated_text(
    billing_path,
    """   const stripeClient = new StripeSubscriptions(components.stripe, {});
   export const createSubscriptionCheckout = action({
     args: { priceId: v.string() },""",
    """   const stripeClient = new StripeSubscriptions(components.stripe, {});
   const priceByTier = {
     pro: process.env.STRIPE_PRO_PRICE_ID
   } as const;
   export const createSubscriptionCheckout = action({
     args: { tier: v.literal('pro') },""",
)
replace_generated_text(
    billing_path,
    """       if (!identity) throw new Error('Not authenticated');
       const customer""",
    """       if (!identity) throw new Error('Not authenticated');
       const priceId = priceByTier[args.tier];
       if (!priceId) throw new Error('Price is not configured');
       const customer""",
)
replace_generated_text(
    billing_path,
    "         priceId: args.priceId,",
    "         priceId,",
)
replace_generated_text(
    billing_path,
    "subscriptionMetadata: { userId: identity.subject }",
    "subscriptionMetadata: { userId: identity.subject, tier: args.tier }",
)
replace_generated_text(
    billing_path,
    """       return subscriptions.some((sub) => sub.status === 'active' || sub.status === 'trialing');""",
    """       const allowedPriceIds = new Set(Object.values(priceByTier).filter(Boolean));
       return subscriptions.some(
         (sub) =>
           (sub.status === 'active' || sub.status === 'trialing') &&
           allowedPriceIds.has(sub.priceId) &&
           sub.metadata?.tier === 'pro'
       );""",
)
replace_generated_text(
    billing_path,
    """- Stripe keys live in Convex env (use the `env` micro power): STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.
- Gate on server-stored subscription state via isSubscribed query (reads component tables), not client claims.""",
    """- Stripe keys and allowlisted price IDs live in Convex env (use the `env` micro power): STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_PRO_PRICE_ID.
- Accept a validated tier, never a caller-provided Stripe price ID. Gate on server-stored subscription state, status, allowlisted price ID, and tier metadata via isSubscribed.""",
)
