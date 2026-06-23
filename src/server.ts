import { resolve } from "node:path";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import * as z from "zod/v4";
import { findFields, getField, loadCatalogue, type CataloguePaths } from "./catalogue.js";
import { EtaxClient, type EtaxClientConfig, type Environment, type FetchLike } from "./etaxClient.js";
import type { Catalogue, JsonValue } from "./types.js";

type ToolResponse = Promise<{ content: Array<{ type: "text"; text: string }> }>;

export interface ServerDependencies {
  catalogue?: Catalogue | undefined;
  cataloguePaths?: CataloguePaths | undefined;
  fetch?: FetchLike | undefined;
  clientFactory?: ((environment: Environment, catalogue: Catalogue) => EtaxClient) | undefined;
}

const environmentSchema = z.enum(["training", "production"]);
const optionalIdSchema = z.object({ id: z.string().optional() });
const templateScopeSchema = z.object({
  id: z.string().optional(),
  templateIds: z.array(z.string()).min(1),
  rootScopeId: z.string(),
});
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

export function createMcpServer(dependencies: ServerDependencies = {}): McpServer {
  const server = new McpServer({ name: "luzern-etax-mcp", version: "0.1.0" });
  const handlers = createToolHandlers(dependencies);

  server.registerTool(
    "search_fields",
    {
      description: "Search the offline Field Catalogue. Does not contact eSteuern.LU or require taxpayer data.",
      inputSchema: z.object({
        query: z.string().default(""),
        limit: z.number().int().positive().max(100).default(20),
        includeCalculated: z.boolean().default(false),
      }),
    },
    handlers.searchFields,
  );

  server.registerTool(
    "get_field",
    {
      description: "Get one Field from the offline Field Catalogue by field ID. Does not contact eSteuern.LU.",
      inputSchema: z.object({ fieldId: z.string() }),
    },
    handlers.getField,
  );

  server.registerTool(
    "list_declarations",
    {
      description: "List visible Tax Declarations in the selected environment. Uses configured Login Credentials; do not send credentials or taxpayer PII as tool arguments.",
      inputSchema: z.object({ environment: environmentSchema, groupId: z.string().default("ch.np.lu.2025") }),
    },
    handlers.listDeclarations,
  );

  server.registerTool(
    "create_declaration",
    {
      description: "Create a Tax Declaration using configured Declaration Credentials. Do not send PersID or access code as tool arguments.",
      inputSchema: z.object({
        environment: environmentSchema,
        modelId: z.string().optional(),
        groupId: z.string().optional(),
        noPrevYearImport: z.boolean().default(true),
        previousYearId: z.string().optional(),
      }),
    },
    handlers.createDeclaration,
  );

  server.registerTool(
    "load_declaration",
    {
      description: "Open a Tax Declaration for diagnostics or manual flow testing. Normal tools open automatically when needed.",
      inputSchema: z.object({ environment: environmentSchema, id: z.string().optional() }),
    },
    handlers.loadDeclaration,
  );

  server.registerTool(
    "get_scope",
    {
      description: "Read a Runtime Scope from eSteuern.LU. Requires explicit environment and a declaration ID unless configured.",
      inputSchema: templateScopeSchema.extend({ environment: environmentSchema }),
    },
    handlers.getScope,
  );

  server.registerTool(
    "set_field",
    {
      description: "Safely update one Field after catalogue and Runtime Scope checks. Do not send credentials or unnecessary taxpayer PII.",
      inputSchema: templateScopeSchema.extend({
        environment: environmentSchema,
        domainPath: z.string(),
        scopeId: z.string(),
        value: jsonValueSchema,
      }),
    },
    handlers.setField,
  );

  server.registerTool(
    "insert_list_entry",
    {
      description: "Safely insert a List Entry after checking the parent Runtime Scope and deriving currentScopeCount.",
      inputSchema: templateScopeSchema.extend({
        environment: environmentSchema,
        domainPath: z.string(),
        parentScopeId: z.string(),
        onSuccessTemplateId: z.string().optional(),
      }),
    },
    handlers.insertListEntry,
  );

  server.registerTool(
    "save_declaration",
    {
      description: "Save the current Tax Declaration draft. This is not Submission.",
      inputSchema: optionalIdSchema.extend({ environment: environmentSchema }),
    },
    handlers.saveDeclaration,
  );

  server.registerTool(
    "print_declaration",
    {
      description: "Generate a review PDF job. Print artifacts may contain taxpayer data and are not written into the repository by default.",
      inputSchema: optionalIdSchema.extend({
        environment: environmentSchema,
        includeAttachments: z.boolean().default(true),
        modelId: z.string().optional(),
        outputPath: z.string().optional(),
      }),
    },
    handlers.printDeclaration,
  );

  return server;
}

export function createToolHandlers(dependencies: ServerDependencies = {}) {
  const catalogue = dependencies.catalogue ?? loadCatalogue(dependencies.cataloguePaths ?? defaultCataloguePaths());
  const clientFactory = dependencies.clientFactory ?? ((environment: Environment, activeCatalogue: Catalogue) => new EtaxClient({
    ...configFromEnvironment(environment),
    fetch: dependencies.fetch ?? fetch,
    catalogue: activeCatalogue,
  }));

  const client = (environment: Environment) => clientFactory(environment, catalogue);

  return {
    searchFields: async (input: { query?: string; limit?: number; includeCalculated?: boolean }): ToolResponse =>
      textResult(findFields(catalogue, input.query ?? "", searchOptions(input))),

    getField: async (input: { fieldId: string }): ToolResponse =>
      textResult(getField(catalogue, input.fieldId) ?? { error: `Field not found: ${input.fieldId}` }),

    listDeclarations: async (input: { environment: Environment; groupId?: string }): ToolResponse =>
      textResult(await client(input.environment).listDeclarations(input.groupId ?? "ch.np.lu.2025")),

    createDeclaration: async (input: { environment: Environment; modelId?: string | undefined; groupId?: string | undefined; noPrevYearImport?: boolean | undefined; previousYearId?: string | undefined }): ToolResponse =>
      textResult(await client(input.environment).createDeclaration(createOptions(input))),

    loadDeclaration: async (input: { environment: Environment; id?: string | undefined }): ToolResponse =>
      textResult(await client(input.environment).loadDeclaration(input.id)),

    getScope: async (input: { environment: Environment; id?: string | undefined; templateIds: string[]; rootScopeId: string }): ToolResponse =>
      textResult(await client(input.environment).getScope(input)),

    setField: async (input: { environment: Environment; id?: string | undefined; templateIds: string[]; rootScopeId: string; domainPath: string; scopeId: string; value: JsonValue }): ToolResponse =>
      textResult(await client(input.environment).setField(input)),

    insertListEntry: async (input: { environment: Environment; id?: string | undefined; templateIds: string[]; rootScopeId: string; domainPath: string; parentScopeId: string; onSuccessTemplateId?: string | undefined }): ToolResponse =>
      textResult(await client(input.environment).insertListEntry(input)),

    saveDeclaration: async (input: { environment: Environment; id?: string | undefined }): ToolResponse =>
      textResult(await client(input.environment).saveDeclaration(input.id)),

    printDeclaration: async (input: { environment: Environment; id?: string | undefined; includeAttachments?: boolean | undefined; modelId?: string | undefined; outputPath?: string | undefined }): ToolResponse =>
      textResult(await client(input.environment).printDeclaration(input)),
  };
}

function defaultCataloguePaths(): CataloguePaths {
  return {
    modelXml: resolve("config/model.xml"),
    labelsProperties: resolve("config/entity-labels.properties"),
    scantaxXml: resolve("config/scantax.xml"),
  };
}

function configFromEnvironment(environment: Environment): Omit<EtaxClientConfig, "fetch"> {
  return stripUndefined({
    environment,
    loginEmail: process.env.ETAX_LOGIN_EMAIL,
    loginPassword: process.env.ETAX_LOGIN_PASSWORD,
    declarationPersId: process.env.ETAX_DECLARATION_PERS_ID,
    declarationAccessCode: process.env.ETAX_DECLARATION_ACCESS_CODE,
    configuredDeclarationId: process.env.ETAX_DECLARATION_ID,
    language: process.env.ETAX_LANGUAGE,
  });
}

function textResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

async function main(): Promise<void> {
  const server = createMcpServer();
  const transport = new NodeStreamableHTTPServerTransport();
  await server.connect(transport);
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const host = process.env.HOST ?? "127.0.0.1";
  createServer((request, response) => {
    void transport.handleRequest(request, response);
  }).listen(port, host, () => {
    console.error(`Luzern eTax MCP listening on http://${host}:${port}/mcp`);
  });
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)) as T;
}

function searchOptions(input: { limit?: number; includeCalculated?: boolean }): { limit?: number; includeCalculated?: boolean } {
  const options: { limit?: number; includeCalculated?: boolean } = {};
  if (input.limit !== undefined) {
    options.limit = input.limit;
  }
  if (input.includeCalculated !== undefined) {
    options.includeCalculated = input.includeCalculated;
  }
  return options;
}

function createOptions(input: { modelId?: string | undefined; groupId?: string | undefined; noPrevYearImport?: boolean | undefined; previousYearId?: string | undefined }) {
  const options: { modelId?: string; groupId?: string; noPrevYearImport?: boolean; previousYearId?: string } = {
    noPrevYearImport: input.noPrevYearImport ?? true,
  };
  if (input.modelId !== undefined) {
    options.modelId = input.modelId;
  }
  if (input.groupId !== undefined) {
    options.groupId = input.groupId;
  }
  if (input.previousYearId !== undefined) {
    options.previousYearId = input.previousYearId;
  }
  return options;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
