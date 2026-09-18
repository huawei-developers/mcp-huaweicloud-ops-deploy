/**
 * BSS account-balance + coupon queries for the balance_summary field
 * returned by list_existing_resources (§3.2 + cost review §7 step 9).
 *
 * Why these are aggregated into list_existing_resources instead of a
 * separate tool: the deployment flow calls list_existing_resources at the
 * reuse-decision point (step 5), and balance/coupon info is the same
 * cost-decision context. One call gives the full cost picture at the
 * reuse/budget decision point.
 *
 * Both APIs accept AK/SK signing (the swagger marks X-Auth-Token, but
 * BSS accepts SDK-HMAC-SHA256 too — verified end-to-end: 200 responses
 * from IAM, BSS balances, and BSS coupons). The shared signed HTTP
 * client is in auth/http.ts.
 */

import { signedHttp } from "../auth/http.js";

export interface BalanceSummary {
  /** Account balances by type. */
  balances: Array<{
    account_type: number;
    /** 1=余额 2=信用 5=奖励金 7=保证金 */
    account_type_name: string;
    amount: number;
    currency: string;
    /** Only for credit accounts (account_type=2). */
    credit_amount?: number;
    /** Reserved/special-purpose balance. */
    designated_amount?: number;
  }>;
  /** Coupon list (代金券). */
  coupons: {
    count: number;
    /** Total remaining balance across all coupons, null if any unparseable. */
    total_balance: number | null;
    /** Per-coupon details — each has expire_time, the LLM judges urgency. */
    items: CouponDetail[];
  };
}

/** Per-coupon summary — the fields the LLM needs to advise the user. */
export interface CouponDetail {
  coupon_id: string;
  /** 1=代金券 2=折扣券 3=产品券 4=现金券 */
  coupon_type: number | null;
  /** 代金券/折扣券/产品券/现金券 (derived from coupon_type) */
  coupon_type_name: string | null;
  /** Remaining balance (元). Null for legacy coupons (coupon_version=1). */
  balance: number | null;
  /** Face value (元). */
  face_value: number | null;
  /** Usage description (e.g. "ECS 通用"). */
  coupon_usage: string | null;
  /** Promotion plan name. */
  plan_name: string | null;
  /** Expire time (ISO 8601 UTC). */
  expire_time: string | null;
  /** 1=legacy (one-time use) 2=new (reusable). */
  coupon_version: number | null;
  /** 0=not frozen 1=frozen. */
  is_frozen: number | null;
}

/** Signed GET helper — wraps signedHttp with empty body. */
async function signedGet(url: URL): Promise<{ status: number; body: string }> {
  const resp = await signedHttp("GET", url, "");
  return { status: resp.status, body: resp.body };
}

/**
 * Query account balances (ShowCustomerAccountBalances).
 * GET /v2/accounts/customer-accounts/balances — no params.
 * Response: { account_balances: [{ account_type, amount, currency, credit_amount? }] }
 */
const ACCOUNT_TYPE_NAMES: Record<number, string> = {
  1: "余额",
  2: "信用",
  5: "奖励金",
  7: "保证金",
};

const COUPON_TYPE_NAMES: Record<number, string> = {
  1: "代金券",
  2: "折扣券",
  3: "产品券",
  4: "现金券",
};

export async function queryAccountBalances(): Promise<BalanceSummary["balances"]> {
  const url = new URL("https://bss.myhuaweicloud.com/v2/accounts/customer-accounts/balances");
  try {
    const { status, body } = await signedGet(url);
    if (status !== 200) return [];
    const data = JSON.parse(body) as { account_balances?: Array<Record<string, unknown>> };
    return (data.account_balances ?? [])
      .map((b) => {
        const at = typeof b["account_type"] === "number" ? b["account_type"] as number : 0;
        const item: BalanceSummary["balances"][number] = {
          account_type: at,
          account_type_name: ACCOUNT_TYPE_NAMES[at] ?? "未知",
          amount: typeof b["amount"] === "number" ? b["amount"] as number : 0,
          currency: typeof b["currency"] === "string" ? b["currency"] as string : "",
        };
        if (typeof b["credit_amount"] === "number") item.credit_amount = b["credit_amount"] as number;
        if (typeof b["designated_amount"] === "number") item.designated_amount = b["designated_amount"] as number;
        return item;
      })
      // Filter out zero-balance accounts — they're noise. Exception: credit
      // accounts (type 2) are kept even at amount=0 because credit_amount
      // (total credit line) is still useful info.
      .filter((b) => b.amount !== 0 || b.account_type === 2);
  } catch {
    return [];
  }
}

/**
 * Query coupons (ListSubCustomerCoupons).
 * GET /v2/promotions/benefits/coupons — no params.
 * Response: { count, user_coupons: [{ coupon_id, status, balance, effective_time, expire_time, ... }] }
 */
export async function queryCoupons(): Promise<BalanceSummary["coupons"]> {
  const url = new URL("https://bss.myhuaweicloud.com/v2/promotions/benefits/coupons");
  try {
    const { status, body } = await signedGet(url);
    if (status !== 200) return { count: 0, total_balance: null, items: [] };
    const data = JSON.parse(body) as {
      count?: number;
      user_coupons?: Array<Record<string, unknown>>;
    };
    const rawCoupons = data.user_coupons ?? [];
    let total = 0;
    let allParseable = true;
    const items: CouponDetail[] = [];
    for (const c of rawCoupons) {
      const balance = typeof c["balance"] === "number" ? c["balance"] as number : null;
      const ct = typeof c["coupon_type"] === "number" ? c["coupon_type"] as number : null;
      const expireTime = typeof c["expire_time"] === "string" ? c["expire_time"] as string : null;
      const faceValue = typeof c["face_value"] === "number" ? c["face_value"] as number : null;
      if (balance !== null) {
        total += balance;
      } else {
        allParseable = false;
      }
      items.push({
        coupon_id: String(c["coupon_id"] ?? ""),
        coupon_type: ct,
        coupon_type_name: ct !== null ? (COUPON_TYPE_NAMES[ct] ?? "未知") : null,
        balance,
        face_value: faceValue,
        coupon_usage: typeof c["coupon_usage"] === "string" ? c["coupon_usage"] as string : null,
        plan_name: typeof c["plan_name"] === "string" ? c["plan_name"] as string : null,
        expire_time: expireTime,
        coupon_version: typeof c["coupon_version"] === "number" ? c["coupon_version"] as number : null,
        is_frozen: typeof c["is_frozen"] === "number" ? c["is_frozen"] as number : null,
      });
    }
    return {
      count: data.count ?? rawCoupons.length,
      total_balance: allParseable ? total : null,
      items,
    };
  } catch {
    return { count: 0, total_balance: null, items: [] };
  }
}

/** Query both balances and coupons, return the combined summary. */
export async function queryBalanceSummary(): Promise<BalanceSummary> {
  const [balances, coupons] = await Promise.all([queryAccountBalances(), queryCoupons()]);
  return { balances, coupons };
}
