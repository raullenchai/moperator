import { describe, it, expect, beforeAll } from "vitest";
import { generateOpenAPISpec, handleOpenAPIRequest, type OpenAPISpec } from "../protocols/openapi";

describe("OpenAPI Protocol", () => {
  describe("generateOpenAPISpec", () => {
    let spec: OpenAPISpec;

    beforeAll(() => {
      spec = generateOpenAPISpec("https://api.example.com");
    });

    it("generates valid OpenAPI 3.1.0 spec", () => {
      expect(spec.openapi).toBe("3.1.0");
    });

    it("includes correct server URL", () => {
      expect(spec.servers).toHaveLength(1);
      expect(spec.servers[0].url).toBe("https://api.example.com");
    });

    it("includes API info", () => {
      expect(spec.info.title).toBe("Moperator Email API");
      expect(spec.info.version).toBe("1.0.0");
      expect(spec.info.description).toContain("Email for AI");
    });

    it("defines email endpoints", () => {
      expect(spec.paths).toHaveProperty("/api/v1/emails");
      expect(spec.paths).toHaveProperty("/api/v1/emails/search");
      expect(spec.paths).toHaveProperty("/api/v1/emails/{emailId}");
      expect(spec.paths).toHaveProperty("/api/v1/emails/stats");
    });

    it("defines bearer auth security scheme", () => {
      expect(spec.components.securitySchemes).toHaveProperty("bearerAuth");
      expect((spec.components.securitySchemes.bearerAuth as any).type).toBe("http");
      expect((spec.components.securitySchemes.bearerAuth as any).scheme).toBe("bearer");
    });

    it("defines required schemas", () => {
      const schemas = spec.components.schemas;
      expect(schemas).toHaveProperty("EmailListResponse");
      expect(schemas).toHaveProperty("EmailSearchResponse");
      expect(schemas).toHaveProperty("EmailSummary");
      expect(schemas).toHaveProperty("EmailRecord");
      expect(schemas).toHaveProperty("EmailStats");
    });

    it("applies security globally", () => {
      expect(spec.security).toHaveLength(1);
      expect(spec.security[0]).toHaveProperty("bearerAuth");
    });
  });

  describe("listEmails endpoint", () => {
    let spec: OpenAPISpec;

    beforeAll(() => {
      spec = generateOpenAPISpec("https://api.example.com");
    });

    it("has correct operationId", () => {
      const endpoint = spec.paths["/api/v1/emails"].get as any;
      expect(endpoint.operationId).toBe("listEmails");
    });

    it("includes display instruction in description", () => {
      const endpoint = spec.paths["/api/v1/emails"].get as any;
      expect(endpoint.description).toContain("IMPORTANT");
      expect(endpoint.description).toContain("display ALL emails");
    });

    it("defines limit and offset parameters", () => {
      const endpoint = spec.paths["/api/v1/emails"].get as any;
      const params = endpoint.parameters;

      const limitParam = params.find((p: any) => p.name === "limit");
      expect(limitParam).toBeDefined();
      expect(limitParam.schema.default).toBe(10);
      expect(limitParam.schema.maximum).toBe(50);

      const offsetParam = params.find((p: any) => p.name === "offset");
      expect(offsetParam).toBeDefined();
      expect(offsetParam.schema.default).toBe(0);
    });
  });

  describe("searchEmails endpoint", () => {
    let spec: OpenAPISpec;

    beforeAll(() => {
      spec = generateOpenAPISpec("https://api.example.com");
    });

    it("has correct operationId", () => {
      const endpoint = spec.paths["/api/v1/emails/search"].get as any;
      expect(endpoint.operationId).toBe("searchEmails");
    });

    it("defines from and subject parameters", () => {
      const endpoint = spec.paths["/api/v1/emails/search"].get as any;
      const params = endpoint.parameters;

      expect(params.find((p: any) => p.name === "from")).toBeDefined();
      expect(params.find((p: any) => p.name === "subject")).toBeDefined();
    });
  });

  describe("getEmail endpoint", () => {
    let spec: OpenAPISpec;

    beforeAll(() => {
      spec = generateOpenAPISpec("https://api.example.com");
    });

    it("has correct operationId", () => {
      const endpoint = spec.paths["/api/v1/emails/{emailId}"].get as any;
      expect(endpoint.operationId).toBe("getEmail");
    });

    it("requires emailId path parameter", () => {
      const endpoint = spec.paths["/api/v1/emails/{emailId}"].get as any;
      const param = endpoint.parameters[0];
      expect(param.name).toBe("emailId");
      expect(param.in).toBe("path");
      expect(param.required).toBe(true);
    });

    it("defines 404 response", () => {
      const endpoint = spec.paths["/api/v1/emails/{emailId}"].get as any;
      expect(endpoint.responses["404"]).toBeDefined();
    });
  });

  describe("handleOpenAPIRequest", () => {
    it("returns JSON by default", () => {
      const request = new Request("https://api.example.com/openapi.json");
      const response = handleOpenAPIRequest(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");
    });

    it("returns YAML when format=yaml", () => {
      const request = new Request("https://api.example.com/openapi.json?format=yaml");
      const response = handleOpenAPIRequest(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/yaml");
    });

    it("returns YAML when Accept header includes yaml", () => {
      const request = new Request("https://api.example.com/openapi.json", {
        headers: { Accept: "text/yaml" },
      });
      const response = handleOpenAPIRequest(request);

      expect(response.headers.get("Content-Type")).toBe("text/yaml");
    });

    it("includes CORS header", () => {
      const request = new Request("https://api.example.com/openapi.json");
      const response = handleOpenAPIRequest(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });

    it("returns valid JSON spec", async () => {
      const request = new Request("https://api.example.com/openapi.json");
      const response = handleOpenAPIRequest(request);
      const body = await response.text();

      const spec = JSON.parse(body);
      expect(spec.openapi).toBe("3.1.0");
      expect(spec.servers[0].url).toBe("https://api.example.com");
    });
  });

  describe("EmailSummary schema", () => {
    let schema: any;

    beforeAll(() => {
      const spec = generateOpenAPISpec("https://api.example.com");
      schema = spec.components.schemas.EmailSummary;
    });

    it("includes preview field for ChatGPT", () => {
      expect(schema.properties).toHaveProperty("preview");
      expect(schema.properties.preview.description).toContain("200 chars");
    });

    it("includes all required fields", () => {
      const fields = Object.keys(schema.properties);
      expect(fields).toContain("id");
      expect(fields).toContain("from");
      expect(fields).toContain("subject");
      expect(fields).toContain("preview");
      expect(fields).toContain("receivedAt");
      expect(fields).toContain("success");
    });
  });
});
