import { describe, it, expect } from "vitest";
import { extractCompactContract, extractFields } from "../src/tools/openapi.js";
import type { ShowApiResponse } from "../src/tools/openapi.js";

// --- extractCompactContract ---

const sampleSwagger: ShowApiResponse = {
  name: "ListCustomerBillsMonthlyBreakDown",
  summary: "查询客户月度消费账单",
  host: "bss.myhuaweicloud.com",
  base_path: "/",
  paths: {
    "/v2/bills/customer-bills/monthly-breakdown": {
      get: {
        parameters: [
          { name: "bill_cycle", in: "query", required: true, type: "string", description: "账期，格式YYYY-MM" },
          { name: "include_zero_record", in: "query", required: false, type: "boolean", description: "是否包含0元记录" },
          { name: "offset", in: "query", required: false, type: "integer", description: "偏移量" },
          { name: "X-Auth-Token", in: "header", required: true, type: "string", description: "用户Token" },
        ],
      },
    },
  },
  parameters: {
    SharedPageLimit: { name: "limit", in: "query", required: false, type: "integer", description: "每页数量" },
  },
  definitions: {
    BillItem: { type: "object", properties: { amount: { type: "number" } } },
  },
};

describe("extractCompactContract", () => {
  it("extracts method + path + params split by required", () => {
    const contract = extractCompactContract(sampleSwagger);
    expect(contract.name).toBe("ListCustomerBillsMonthlyBreakDown");
    expect(contract.host).toBe("bss.myhuaweicloud.com");
    expect(contract.operations).toHaveLength(1);

    const op = contract.operations[0]!;
    expect(op.method).toBe("GET");
    expect(op.path).toBe("/v2/bills/customer-bills/monthly-breakdown");

    const requiredNames = op.required_params.map((p) => p.name);
    const optionalNames = op.optional_params.map((p) => p.name);
    expect(requiredNames).toEqual(expect.arrayContaining(["bill_cycle", "X-Auth-Token"]));
    expect(optionalNames).toEqual(expect.arrayContaining(["include_zero_record", "offset"]));
    expect(requiredNames).not.toContain("include_zero_record");
  });

  it("each param carries name/in/type/required/description", () => {
    const contract = extractCompactContract(sampleSwagger);
    const zeroRec = contract.operations[0]!.optional_params.find((p) => p.name === "include_zero_record");
    expect(zeroRec).toEqual({
      name: "include_zero_record",
      in: "query",
      type: "boolean",
      required: false,
      description: "是否包含0元记录",
    });
  });

  it("drops definitions/responses/schemes", () => {
    const contract = extractCompactContract(sampleSwagger);
    const keys = Object.keys(contract);
    expect(keys).not.toContain("definitions");
    expect(keys).toEqual(["name", "summary", "host", "base_path", "operations"]);
  });

  it("resolves $ref parameters from the top-level parameters map", () => {
    const swagger: ShowApiResponse = {
      name: "Test",
      paths: {
        "/v1/test": {
          get: {
            parameters: [
              { $ref: "#/parameters/SharedPageLimit" },
              { name: "q", in: "query", required: true, type: "string", description: "query" },
            ],
          },
        },
      },
      parameters: {
        SharedPageLimit: { name: "limit", in: "query", required: false, type: "integer", description: "每页数量" },
      },
    };
    const op = extractCompactContract(swagger).operations[0]!;
    expect(op.optional_params).toContainEqual({
      name: "limit", in: "query", type: "integer", required: false, description: "每页数量",
    });
  });

  it("marks unresolved $ref params clearly", () => {
    const swagger: ShowApiResponse = {
      name: "Test",
      paths: { "/v1/test": { get: { parameters: [{ $ref: "#/parameters/Missing" }] } } },
      parameters: {},
    };
    const op = extractCompactContract(swagger).operations[0]!;
    expect(op.optional_params[0]!.name).toBe("(unresolved ref: Missing)");
  });

  it("body param recursively expands nested $ref and array items into flat field paths", () => {
    const swagger: ShowApiResponse = {
      name: "ListOnDemandResourceRatings",
      paths: {
        "/v2/bills/ratings/on-demand-resources": {
          post: {
            parameters: [
              {
                name: "body",
                in: "body",
                required: true,
                description: "询价请求体",
                schema: { $ref: "#/definitions/RateOnDemandReq" },
              },
            ],
          },
        },
      },
      definitions: {
        RateOnDemandReq: {
          type: "object",
          required: ["product_infos", "project_id"],
          properties: {
            project_id: { type: "string", description: "项目ID" },
            product_infos: {
              type: "array",
              description: "产品信息列表",
              items: { $ref: "#/definitions/ProductInfo" },
            },
          },
        },
        ProductInfo: {
          type: "object",
          required: ["cloud_service_type", "resource_spec", "usage_factor", "usage_value"],
          properties: {
            cloud_service_type: { type: "string", description: "云服务类型" },
            resource_spec: { type: "string", description: "资源规格" },
            usage_factor: { type: "string", description: "使用量因子" },
            usage_value: { type: "number", description: "使用量值" },
            optional_note: { type: "string", description: "可选备注" },
          },
        },
      },
    };
    const op = extractCompactContract(swagger).operations[0]!;
    const body = op.required_params[0]!;
    expect(body.fields).toEqual([
      { path: "project_id", type: "string", required: true, description: "项目ID" },
      { path: "product_infos[].cloud_service_type", type: "string", required: true, description: "云服务类型" },
      { path: "product_infos[].resource_spec", type: "string", required: true, description: "资源规格" },
      { path: "product_infos[].usage_factor", type: "string", required: true, description: "使用量因子" },
      { path: "product_infos[].usage_value", type: "number", required: true, description: "使用量值" },
      { path: "product_infos[].optional_note", type: "string", required: false, description: "可选备注" },
    ]);
  });

  it("body param without $ref or nested structure has no fields", () => {
    const swagger: ShowApiResponse = {
      name: "Simple",
      paths: {
        "/v1/simple": {
          post: {
            parameters: [
              { name: "body", in: "body", required: true, description: "simple body", schema: { type: "object" } },
            ],
          },
        },
      },
    };
    const op = extractCompactContract(swagger).operations[0]!;
    expect(op.required_params[0]!.fields).toBeUndefined();
  });

  it("handles operations with no parameters field", () => {
    const swagger: ShowApiResponse = {
      name: "Ping",
      paths: { "/ping": { get: {} } },
    };
    const op = extractCompactContract(swagger).operations[0]!;
    expect(op.required_params).toEqual([]);
    expect(op.optional_params).toEqual([]);
  });

  it("handles multiple paths and methods", () => {
    const swagger: ShowApiResponse = {
      name: "Multi",
      paths: {
        "/v1/a": {
          get: { parameters: [{ name: "x", in: "query", required: true, type: "string", description: "x" }] },
          post: { parameters: [{ name: "y", in: "body", required: true, description: "body", schema: {} }] },
        },
        "/v1/b": {
          delete: { parameters: [] },
        },
      },
    };
    const ops = extractCompactContract(swagger).operations;
    expect(ops).toHaveLength(3);
    const methods = ops.map((o) => `${o.method} ${o.path}`).sort();
    expect(methods).toEqual(["DELETE /v1/b", "GET /v1/a", "POST /v1/a"].sort());
  });
});

// --- extractFields ---

describe("extractFields", () => {
  const jsonBody = JSON.stringify({
    status: 200,
    data: { bills: [{ id: 1 }, { id: 2 }], total_count: 42 },
    error: null,
  });

  it("extracts existing dot-path fields", () => {
    const result = extractFields(jsonBody, ["data.bills", "data.total_count"]);
    expect(result).toEqual([
      { path: "data.bills", value: [{ id: 1 }, { id: 2 }] },
      { path: "data.total_count", value: 42 },
    ]);
  });

  it("returns null for missing paths", () => {
    const result = extractFields(jsonBody, ["nonexistent", "data.missing"]);
    expect(result).toEqual([
      { path: "nonexistent", value: null },
      { path: "data.missing", value: null },
    ]);
  });

  it("returns null when mid-path value is not an object", () => {
    const result = extractFields(jsonBody, ["data.total_count.sub"]);
    expect(result).toEqual([{ path: "data.total_count.sub", value: null }]);
  });

  it("returns undefined for non-JSON body (caller falls back to raw body)", () => {
    const result = extractFields("not json {", ["data"]);
    expect(result).toBeUndefined();
  });

  it("handles empty fields array", () => {
    const result = extractFields(jsonBody, []);
    expect(result).toEqual([]);
  });
});
