import { afterEach, describe, expect, it } from "vitest";
import middleware from "../../middleware";

const call = (auth?: string) =>
  middleware(new Request("https://hpc.example/#/", { headers: auth ? { authorization: auth } : {} }));

describe("site password middleware", () => {
  afterEach(() => {
    delete process.env.DASHBOARD_PASSWORD;
  });

  it("lets everything through when no password is set", () => {
    expect(call().headers.get("x-middleware-next")).toBe("1");
  });

  it("asks for a password, rejects a wrong one and accepts the right one", () => {
    process.env.DASHBOARD_PASSWORD = "s3cret:pass";
    expect(call().status).toBe(401);
    expect(call(`Basic ${btoa("admin:wrong")}`).status).toBe(401);
    expect(call("Basic !!!").status).toBe(401);
    expect(call(`Basic ${btoa("admin:s3cret:pass")}`).headers.get("x-middleware-next")).toBe("1");
  });
});
