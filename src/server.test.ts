import assert from "node:assert/strict";
import test from "node:test";
import { createMcpServer, createToolHandlers } from "./server.js";
import type { Catalogue } from "./types.js";

const catalogue: Catalogue = {
  fields: new Map([
    ["amount", {
      id: "amount",
      type: "decimal",
      label: "Nettolohn",
      calculated: false,
      enabled: true,
      visible: true,
      sourceFiles: ["test"],
    }],
  ]),
  diagnostics: [],
};

function parseResponse(response: { content: Array<{ text: string }> }): unknown {
  return JSON.parse(response.content[0]?.text ?? "null");
}

test("creates an MCP server", () => {
  assert.ok(createMcpServer({ catalogue }));
});

test("search_fields and get_field work offline", async () => {
  const handlers = createToolHandlers({ catalogue });

  const search = parseResponse(await handlers.searchFields({ query: "Nettolohn", limit: 5, includeCalculated: true }));
  assert.equal(Array.isArray(search), true);
  assert.equal((search as Array<{ id: string }>)[0]?.id, "amount");

  const field = parseResponse(await handlers.getField({ fieldId: "amount" }));
  assert.equal((field as { id: string }).id, "amount");
});

test("network handlers require and pass explicit environment", async () => {
  const calls: string[] = [];
  const handlers = createToolHandlers({
    catalogue,
    clientFactory: (environment) => ({
      listDeclarations: async (groupId: string) => {
        calls.push(`${environment}:${groupId}`);
        return { OK: true, values: [] };
      },
    }) as never,
  });

  const result = parseResponse(await handlers.listDeclarations({ environment: "training", groupId: "ch.np.lu.2025" }));

  assert.deepEqual(calls, ["training:ch.np.lu.2025"]);
  assert.deepEqual(result, { OK: true, values: [] });
});

test("create_declaration forwards no PersID or access code arguments", async () => {
  let captured: unknown;
  const handlers = createToolHandlers({
    catalogue,
    clientFactory: () => ({
      createDeclaration: async (options: unknown) => {
        captured = options;
        return { id: "doc", OK: true };
      },
    }) as never,
  });

  await handlers.createDeclaration({ environment: "training", groupId: "ch.np.lu.2025", noPrevYearImport: true });

  assert.deepEqual(captured, {
    groupId: "ch.np.lu.2025",
    noPrevYearImport: true,
  });
});

test("set_field handler delegates to safe client method", async () => {
  let called = false;
  const handlers = createToolHandlers({
    catalogue,
    clientFactory: () => ({
      setField: async () => {
        called = true;
        return { OK: true, consistency: [] };
      },
    }) as never,
  });

  const result = parseResponse(await handlers.setField({
    environment: "training",
    id: "doc",
    templateIds: ["nplu-dependent-2025", "nplu-common-2025"],
    rootScopeId: "/revenue:0/dependent:0/",
    domainPath: "/revenue/dependent/amount",
    scopeId: "/revenue:0/dependent:0/",
    value: 120000,
  }));

  assert.equal(called, true);
  assert.deepEqual(result, { OK: true, consistency: [] });
});
