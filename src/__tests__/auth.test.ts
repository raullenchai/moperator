import { describe, it, expect } from "vitest";
import { verifyApiKey, unauthorizedResponse } from "../auth";

describe("auth", () => {
  describe("verifyApiKey", () => {
    it("returns true when no API key is configured (dev mode)", () => {
      const request = new Request("http://localhost/test");
      expect(verifyApiKey(request, undefined)).toBe(true);
    });

    it("returns false when no auth header provided", () => {
      const request = new Request("http://localhost/test");
      expect(verifyApiKey(request, "secret-key")).toBe(false);
    });

    it("returns false for malformed auth header", () => {
      const request = new Request("http://localhost/test", {
        headers: { Authorization: "malformed" },
      });
      expect(verifyApiKey(request, "secret-key")).toBe(false);
    });

    it("returns false for wrong scheme", () => {
      const request = new Request("http://localhost/test", {
        headers: { Authorization: "Basic secret-key" },
      });
      expect(verifyApiKey(request, "secret-key")).toBe(false);
    });

    it("returns true for valid Bearer token", () => {
      const request = new Request("http://localhost/test", {
        headers: { Authorization: "Bearer secret-key" },
      });
      expect(verifyApiKey(request, "secret-key")).toBe(true);
    });

    it("returns true for valid ApiKey token", () => {
      const request = new Request("http://localhost/test", {
        headers: { Authorization: "ApiKey secret-key" },
      });
      expect(verifyApiKey(request, "secret-key")).toBe(true);
    });

    it("returns false for wrong key", () => {
      const request = new Request("http://localhost/test", {
        headers: { Authorization: "Bearer wrong-key" },
      });
      expect(verifyApiKey(request, "secret-key")).toBe(false);
    });

    it("returns false for different length keys", () => {
      const request = new Request("http://localhost/test", {
        headers: { Authorization: "Bearer short" },
      });
      expect(verifyApiKey(request, "longer-secret-key")).toBe(false);
    });
  });

  describe("unauthorizedResponse", () => {
    it("returns 401 status", () => {
      const response = unauthorizedResponse();
      expect(response.status).toBe(401);
    });

    it("has correct content type", () => {
      const response = unauthorizedResponse();
      expect(response.headers.get("Content-Type")).toBe("application/json");
    });

    it("has WWW-Authenticate header", () => {
      const response = unauthorizedResponse();
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    });

    it("returns error JSON body", async () => {
      const response = unauthorizedResponse();
      const body = await response.json() as { error: string; message: string };
      expect(body.error).toBe("Unauthorized");
      expect(body.message).toContain("API key required");
    });
  });
});
