import assert from "node:assert/strict";
import test from "node:test";
import { EtaxClient, type FetchLike, requireWritableField } from "./etaxClient.js";
import type { Catalogue, RuntimeField, RuntimeScope } from "./types.js";

interface CapturedRequest {
  url: string;
  init?: RequestInit | undefined;
  body?: unknown;
}

function fakeFetch(responses: unknown[]): { fetch: FetchLike; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    let body: unknown;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    } else if (init?.body instanceof URLSearchParams) {
      body = Object.fromEntries(init.body.entries());
    }
    requests.push({ url, init, body });
    const response = responses.shift() ?? { OK: true };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fetchImpl, requests };
}

function writableScope(field = writableRuntimeField()): RuntimeScope {
  return {
    dto: {
      rootScopeId: "/revenue:0/dependent:0/",
      entities: [field],
    },
    OK: true,
  };
}

function writableRuntimeField(): RuntimeField {
  return {
    domainPath: "/revenue/dependent/amount",
    scopeId: "/revenue:0/dependent:0/",
    type: "decimal",
    calculated: false,
    active: true,
    enabled: true,
  };
}

test("listDeclarations sends auth header and search body", async () => {
  const { fetch, requests } = fakeFetch([{ values: [], OK: true }]);
  const client = new EtaxClient({ environment: "training", fetch, token: "token" });

  await client.listDeclarations("ch.np.lu.2025");

  assert.equal(requests[0]?.url, "https://schulen-lu.etax.ch/services/datamodel/search");
  assert.deepEqual(requests[0]?.body, { groupId: "ch.np.lu.2025" });
  assert.equal((requests[0]?.init?.headers as Record<string, string>).authorization, "Bearer token");
});

test("createDeclaration uses configured Declaration Credentials", async () => {
  const { fetch, requests } = fakeFetch([{ id: "doc", OK: true }]);
  const client = new EtaxClient({
    environment: "training",
    fetch,
    token: "token",
    declarationPersId: "pid",
    declarationAccessCode: "code",
  });

  await client.createDeclaration({ groupId: "ch.np.lu.2025", noPrevYearImport: true });

  assert.equal(requests[0]?.url, "https://schulen-lu.etax.ch/services/datamodel/create");
  assert.deepEqual(requests[0]?.body, {
    modelId: "ch.np.lu.2025",
    parameters: { PID: "pid", CODE: "code", NOPREVYEARIMPORT: true },
  });
});

test("setField opens, checks Runtime Scope, and updates without transaction wrapper", async () => {
  const { fetch, requests } = fakeFetch([
    { id: "doc", OK: true, requestNumber: 2 },
    writableScope(),
    { OK: true, dto: { entities: [{ domainPath: "/revenue/dependent/amount", value: 120000 }] }, consistency: [] },
  ]);
  const client = new EtaxClient({ environment: "training", fetch, token: "token" });

  await client.setField({
    id: "doc",
    templateIds: ["nplu-dependent-2025", "nplu-common-2025"],
    rootScopeId: "/revenue:0/dependent:0/",
    domainPath: "/revenue/dependent/amount",
    scopeId: "/revenue:0/dependent:0/",
    value: 120000,
  });

  assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
    "/services/datamodel/load",
    "/services/datamodel/entityScope",
    "/services/datamodel/update",
  ]);
  assert.ok(!requests.some((request) => request.url.includes("startTransaction") || request.url.includes("commit")));
  assert.deepEqual(requests[2]?.body, {
    id: "doc",
    templateIds: ["nplu-dependent-2025", "nplu-common-2025"],
    rootScopeId: "/revenue:0/dependent:0/",
    language: "de",
    changes: [{
      domainPath: "/revenue/dependent/amount",
      scopeId: "/revenue:0/dependent:0/",
      value: 120000,
      type: 1,
    }],
  });
});

test("setField refuses catalogue-calculated fields before network calls", async () => {
  const { fetch, requests } = fakeFetch([]);
  const catalogue: Catalogue = {
    fields: new Map([["taxTotal", {
      id: "taxTotal",
      type: "decimal",
      calculated: true,
      enabled: false,
      visible: true,
      sourceFiles: ["test"],
    }]]),
    diagnostics: [],
  };
  const client = new EtaxClient({ environment: "training", fetch, token: "token", catalogue });

  await assert.rejects(() => client.setField({
    id: "doc",
    templateIds: ["nplu-common-2025"],
    rootScopeId: "/taxcalc2:0/residential:0/",
    domainPath: "/taxcalc2/residential/taxTotal",
    scopeId: "/taxcalc2:0/residential:0/",
    value: 1,
  }), /calculated/);
  assert.equal(requests.length, 0);
});

test("insertListEntry derives currentScopeCount from Runtime Scope", async () => {
  const { fetch, requests } = fakeFetch([
    { id: "doc", OK: true },
    writableScope({
      domainPath: "/revenue/dependent",
      scopeId: "/revenue:0/",
      type: "list",
      calculated: false,
      active: true,
      enabled: true,
      scopeIds: ["/revenue:0/dependent:0/"],
    }),
    { OK: true, changeResults: [{ scopeId: "/revenue:0/dependent:1/" }] },
  ]);
  const client = new EtaxClient({ environment: "training", fetch, token: "token" });

  await client.insertListEntry({
    id: "doc",
    templateIds: ["nplu-work-2025", "nplu-common-2025"],
    rootScopeId: "/",
    domainPath: "/revenue/dependent",
    parentScopeId: "/revenue:0/",
    onSuccessTemplateId: "nplu-dependent-2025",
  });

  assert.equal((requests[2]?.body as { changes: Array<{ currentScopeCount: number }> }).changes[0]?.currentScopeCount, 1);
});

test("printDeclaration returns metadata by default and refuses repo output path", async () => {
  const { fetch, requests } = fakeFetch([
    { id: "doc", OK: true },
    { jobId: "job-1" },
    { status: "DONE" },
  ]);
  const client = new EtaxClient({ environment: "training", fetch, token: "token" });

  const result = await client.printDeclaration({ id: "doc" });

  assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
    "/services/datamodel/load",
    "/services/datamodel/print",
    "/services/datamodel/printStatus/job-1",
  ]);
  assert.match(JSON.stringify(result), /not downloaded/);

  const next = fakeFetch([{ id: "doc", OK: true }, { jobId: "job-2" }, { status: "DONE" }]);
  const nextClient = new EtaxClient({ environment: "training", fetch: next.fetch, token: "token" });
  await assert.rejects(() => nextClient.printDeclaration({ id: "doc", outputPath: "unsafe.pdf" }), /inside the repository/);
});

test("requireWritableField rejects disabled runtime fields", () => {
  assert.throws(() => requireWritableField(writableScope({ ...writableRuntimeField(), enabled: false }), "/revenue/dependent/amount", "/revenue:0/dependent:0/"), /disabled/);
});
