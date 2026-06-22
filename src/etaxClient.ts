import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Catalogue, JsonValue, RuntimeField, RuntimeScope, UpdateResult } from "./types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type Environment = "training" | "production";

export interface EtaxClientConfig {
  environment: Environment;
  fetch: FetchLike;
  loginEmail?: string | undefined;
  loginPassword?: string | undefined;
  declarationPersId?: string | undefined;
  declarationAccessCode?: string | undefined;
  configuredDeclarationId?: string | undefined;
  language?: string | undefined;
  catalogue?: Catalogue | undefined;
  baseUrl?: string | undefined;
  token?: string | undefined;
}

export interface CreateDeclarationOptions {
  modelId?: string | undefined;
  groupId?: string | undefined;
  noPrevYearImport?: boolean | undefined;
  previousYearId?: string | undefined;
}

export interface ScopeRequest {
  id?: string | undefined;
  templateIds: string[];
  rootScopeId: string;
}

export interface SetFieldRequest extends ScopeRequest {
  domainPath: string;
  scopeId: string;
  value: JsonValue;
}

export interface InsertListEntryRequest extends ScopeRequest {
  domainPath: string;
  parentScopeId: string;
  onSuccessTemplateId?: string | undefined;
}

export interface PrintDeclarationOptions {
  id?: string | undefined;
  includeAttachments?: boolean | undefined;
  modelId?: string | undefined;
  pollIntervalMs?: number | undefined;
  maxPolls?: number | undefined;
  outputPath?: string | undefined;
}

export class EtaxClient {
  private readonly opened = new Set<string>();
  private token: string | undefined;

  readonly baseUrl: string;
  readonly language: string;

  constructor(private readonly config: EtaxClientConfig) {
    this.baseUrl = config.baseUrl ?? baseUrlFor(config.environment);
    this.language = config.language ?? "de";
    this.token = config.token;
  }

  static fromEnvironment(environment: Environment, fetchImpl: FetchLike = fetch): EtaxClient {
    return new EtaxClient({
      environment,
      fetch: fetchImpl,
      loginEmail: process.env.ETAX_LOGIN_EMAIL,
      loginPassword: process.env.ETAX_LOGIN_PASSWORD,
      declarationPersId: process.env.ETAX_DECLARATION_PERS_ID,
      declarationAccessCode: process.env.ETAX_DECLARATION_ACCESS_CODE,
      configuredDeclarationId: process.env.ETAX_DECLARATION_ID,
      language: process.env.ETAX_LANGUAGE,
    });
  }

  async authenticate(): Promise<string> {
    if (this.token) {
      return this.token;
    }
    if (!this.config.loginEmail || !this.config.loginPassword) {
      throw new Error("Missing Login Credentials in process configuration");
    }

    const body = new URLSearchParams({
      grant_type: "password",
      client_id: this.config.environment === "training" ? "eTaxEDU-LU" : "etax",
      username: this.config.loginEmail,
      password: this.config.loginPassword,
    });
    const realm = this.config.environment === "training" ? "eTaxEDU-LU" : "eTax-LU";
    const response = await this.config.fetch(`${this.baseUrl}/realms/${realm}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const payload = await parseJson<{ access_token?: string }>(response);
    if (!payload.access_token) {
      throw new Error("Authentication response did not include an access token");
    }
    this.token = payload.access_token;
    return payload.access_token;
  }

  async listDeclarations(groupId: string): Promise<JsonValue> {
    return this.post("/services/datamodel/search", { groupId }, false);
  }

  async createDeclaration(options: CreateDeclarationOptions = {}): Promise<JsonValue> {
    if (!this.config.declarationPersId || !this.config.declarationAccessCode) {
      throw new Error("Missing Declaration Credentials in process configuration");
    }
    const parameters: Record<string, JsonValue> = {
      PID: this.config.declarationPersId,
      CODE: this.config.declarationAccessCode,
    };
    if (options.noPrevYearImport) {
      parameters.NOPREVYEARIMPORT = true;
    }
    if (options.previousYearId) {
      parameters.PREVYEAR_ID = options.previousYearId;
    }

    return this.post("/services/datamodel/create", {
      modelId: options.modelId ?? options.groupId ?? "ch.np.lu.2025",
      parameters,
    }, false);
  }

  async loadDeclaration(id?: string): Promise<JsonValue> {
    const declarationId = this.resolveDeclarationId(id);
    const result = await this.post<JsonValue>("/services/datamodel/load", { id: declarationId }, false);
    this.opened.add(declarationId);
    return result;
  }

  async getScope(request: ScopeRequest): Promise<RuntimeScope> {
    const id = this.resolveDeclarationId(request.id);
    await this.ensureOpen(id);
    return this.post<RuntimeScope>("/services/datamodel/entityScope", {
      id,
      templateIds: request.templateIds,
      rootScopeId: request.rootScopeId,
      language: this.language,
    }, false);
  }

  async setField(request: SetFieldRequest): Promise<UpdateResult> {
    const id = this.resolveDeclarationId(request.id);
    this.refuseCalculatedFromCatalogue(request.domainPath);
    const scope = await this.getScope({ id, templateIds: request.templateIds, rootScopeId: request.rootScopeId });
    const runtimeField = requireWritableField(scope, request.domainPath, request.scopeId);
    if (runtimeField.type === "list") {
      throw new Error(`Field ${request.domainPath} is a list; use insert_list_entry`);
    }
    return this.post<UpdateResult>("/services/datamodel/update", {
      id,
      templateIds: request.templateIds,
      rootScopeId: request.rootScopeId,
      language: this.language,
      changes: [{
        domainPath: request.domainPath,
        scopeId: request.scopeId,
        value: request.value,
        type: 1,
      }],
    }, false);
  }

  async insertListEntry(request: InsertListEntryRequest): Promise<UpdateResult> {
    const id = this.resolveDeclarationId(request.id);
    const scope = await this.getScope({ id, templateIds: request.templateIds, rootScopeId: request.rootScopeId });
    const listField = requireWritableField(scope, request.domainPath, request.parentScopeId);
    if (listField.type !== "list") {
      throw new Error(`Field ${request.domainPath} is not a list`);
    }
    const currentScopeCount = Array.isArray(listField.scopeIds) ? listField.scopeIds.length : 0;
    const change: Record<string, JsonValue> = {
      domainPath: request.domainPath,
      scopeId: request.parentScopeId,
      currentScopeCount,
      type: 2,
    };
    if (request.onSuccessTemplateId) {
      change.request = { onSuccess: { action: "navigate-to-inserted", templateId: request.onSuccessTemplateId } };
    }
    return this.post<UpdateResult>("/services/datamodel/update", {
      id,
      templateIds: request.templateIds,
      rootScopeId: request.rootScopeId,
      language: this.language,
      changes: [change],
    }, false);
  }

  async saveDeclaration(id?: string): Promise<JsonValue> {
    const declarationId = this.resolveDeclarationId(id);
    await this.ensureOpen(declarationId);
    return this.post("/services/datamodel/save", { id: declarationId }, false);
  }

  async printDeclaration(options: PrintDeclarationOptions = {}): Promise<JsonValue> {
    const id = this.resolveDeclarationId(options.id);
    await this.ensureOpen(id);
    const started = await this.post<{ jobId?: string }>("/services/datamodel/print", {
      id,
      includeAttachments: options.includeAttachments ?? true,
      language: this.language,
      modelId: options.modelId ?? "",
    }, false);
    if (!started.jobId) {
      return started as JsonValue;
    }

    const maxPolls = options.maxPolls ?? 10;
    let status: JsonValue = {};
    for (let i = 0; i < maxPolls; i += 1) {
      status = await this.get(`/services/datamodel/printStatus/${encodeURIComponent(started.jobId)}`);
      if (isCompleteStatus(status)) {
        break;
      }
      if (options.pollIntervalMs) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, options.pollIntervalMs));
      }
    }

    if (!options.outputPath) {
      return {
        jobId: started.jobId,
        status,
        warning: "Print artifacts can contain taxpayer data and were not downloaded because no outputPath was provided.",
      };
    }
    if (isInsideProject(options.outputPath)) {
      throw new Error("Refusing to write print artifact inside the repository");
    }
    const artifact = await this.getBytes(`/services/datamodel/printResult/${encodeURIComponent(started.jobId)}`);
    const outputPath = resolve(options.outputPath);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, artifact);
    return { jobId: started.jobId, status, outputPath, warning: "Print artifact may contain taxpayer data." };
  }

  private async ensureOpen(id: string): Promise<void> {
    if (this.opened.has(id)) {
      return;
    }
    await this.loadDeclaration(id);
  }

  private resolveDeclarationId(id?: string): string {
    const declarationId = id ?? this.config.configuredDeclarationId;
    if (!declarationId) {
      throw new Error("Tax Declaration ID is required unless ETAX_DECLARATION_ID is configured");
    }
    return declarationId;
  }

  private refuseCalculatedFromCatalogue(domainPath: string): void {
    const fieldId = fieldIdFromDomainPath(domainPath);
    const field = this.config.catalogue?.fields.get(fieldId);
    if (field?.calculated) {
      throw new Error(`Refusing to write calculated Field ${field.id}`);
    }
  }

  private async get<T>(path: string): Promise<T> {
    const token = await this.authenticate();
    const response = await this.config.fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });
    return parseJson<T>(response);
  }

  private async getBytes(path: string): Promise<Buffer> {
    const token = await this.authenticate();
    const response = await this.config.fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`eTax request failed: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  private async post<T>(path: string, body: unknown, retryAfterOpen: boolean): Promise<T> {
    const token = await this.authenticate();
    const response = await this.config.fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(stripUndefined(body)),
    });
    if (!response.ok && retryAfterOpen) {
      throw new Error(`eTax request failed: ${response.status}`);
    }
    return parseJson<T>(response);
  }
}

export function baseUrlFor(environment: Environment): string {
  return environment === "training" ? "https://schulen-lu.etax.ch" : "https://esteuern.lu.ch";
}

export function requireWritableField(scope: RuntimeScope, domainPath: string, scopeId: string): RuntimeField {
  const field = scope.dto?.entities?.find((candidate) => candidate.domainPath === domainPath && candidate.scopeId === scopeId);
  if (!field) {
    throw new Error(`Field ${domainPath} at ${scopeId} was not found in Runtime Scope`);
  }
  if (field.calculated) {
    throw new Error(`Refusing to write calculated Field ${domainPath}`);
  }
  if (field.active === false) {
    throw new Error(`Refusing to write inactive Field ${domainPath}`);
  }
  if (field.enabled === false) {
    throw new Error(`Refusing to write disabled Field ${domainPath}`);
  }
  return field;
}

export function fieldIdFromDomainPath(domainPath: string): string {
  const parts = domainPath.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? domainPath;
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`eTax request failed: ${response.status}`);
  }
  return await response.json() as T;
}

function isCompleteStatus(status: JsonValue): boolean {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return false;
  }
  const values = status as Record<string, JsonValue>;
  return values.complete === true || values.done === true || values.status === "DONE" || values.status === "COMPLETED";
}

function isInsideProject(outputPath: string): boolean {
  const root = resolve(process.cwd());
  const target = resolve(outputPath);
  return target === root || target.startsWith(`${root}/`);
}

function stripUndefined(value: unknown): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item));
  }
  if (value && typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) {
        result[key] = stripUndefined(child);
      }
    }
    return result;
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return null;
}
