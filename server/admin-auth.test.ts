import { describe, expect, it, vi, beforeEach } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// Mock the db module to avoid real DB calls in tests
vi.mock("./db", () => ({
  getDb: vi.fn().mockResolvedValue(null),
}));

type CookieCall = {
  name: string;
  value: string;
  options: Record<string, unknown>;
};

function createPublicContext(cookieHeader?: string): {
  ctx: TrpcContext;
  setCookies: CookieCall[];
  clearedCookies: Array<{ name: string; options: Record<string, unknown> }>;
} {
  const setCookies: CookieCall[] = [];
  const clearedCookies: Array<{ name: string; options: Record<string, unknown> }> = [];

  const ctx: TrpcContext = {
    user: null,
    req: {
      protocol: "https",
      headers: {
        cookie: cookieHeader || "",
      },
    } as TrpcContext["req"],
    res: {
      cookie: (name: string, value: string, options: Record<string, unknown>) => {
        setCookies.push({ name, value, options });
      },
      clearCookie: (name: string, options: Record<string, unknown>) => {
        clearedCookies.push({ name, options });
      },
    } as unknown as TrpcContext["res"],
  };

  return { ctx, setCookies, clearedCookies };
}

describe("adminAuth.me", () => {
  it("returns isAdmin: false when no cookie is present", async () => {
    const { ctx } = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.adminAuth.me();
    expect(result).toEqual({ isAdmin: false, username: null });
  });

  it("returns isAdmin: false when cookie is invalid", async () => {
    const { ctx } = createPublicContext("admin_session_id=invalid_token");
    const caller = appRouter.createCaller(ctx);
    const result = await caller.adminAuth.me();
    expect(result).toEqual({ isAdmin: false, username: null });
  });
});

describe("adminAuth.logout", () => {
  it("clears the admin_session_id cookie and reports success", async () => {
    const { ctx, clearedCookies } = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.adminAuth.logout();
    expect(result).toEqual({ success: true });
    expect(clearedCookies).toHaveLength(1);
    expect(clearedCookies[0]?.name).toBe("admin_session_id");
    expect(clearedCookies[0]?.options).toMatchObject({
      maxAge: -1,
      httpOnly: true,
      path: "/",
    });
  });
});

describe("adminAuth.login", () => {
  it("throws error when DB is unavailable", async () => {
    const { ctx } = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.adminAuth.login({ username: "admin", password: "admin" })
    ).rejects.toThrow("データベースに接続できません");
  });
});
