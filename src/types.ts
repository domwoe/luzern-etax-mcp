export type EnvironmentName = "training" | "production";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type FieldType = "string" | "boolean" | "integer" | "decimal" | "float" | "date" | "text" | "list" | "dictionary" | "table" | string;

export interface FieldSummary {
  id: string;
  type: FieldType;
  label?: string | undefined;
  calculated: boolean;
  enabled: boolean;
  visible: boolean;
  enumId?: string | undefined;
  scantax?: {
    form?: string | undefined;
    fref?: string | undefined;
    seq?: string | undefined;
  } | undefined;
  sourceFiles: string[];
}

export interface CatalogueDiagnostic {
  type: "duplicate-label" | "parse-warning";
  key?: string;
  message: string;
}

export interface Catalogue {
  fields: Map<string, FieldSummary>;
  diagnostics: CatalogueDiagnostic[];
}

export interface RuntimeField {
  domainPath: string;
  scopeId: string;
  type: string;
  value?: JsonValue;
  calculated?: boolean;
  active?: boolean;
  enabled?: boolean;
  scopeIds?: string[];
  scopes?: JsonValue[];
}

export interface ConsistencyMessage {
  scopeId?: string;
  path?: string;
  messageText?: string;
  severity?: number;
  valid?: boolean;
  affectedDataIds?: JsonValue[];
}

export interface RuntimeScope {
  dto?: {
    rootScopeId?: string;
    entities?: RuntimeField[];
    anchors?: JsonValue[];
    attachments?: JsonValue[];
    inTransaction?: boolean;
  };
  id?: string;
  modelId?: string;
  consistency?: ConsistencyMessage[];
  OK?: boolean;
}

export interface UpdateResult {
  changeResults?: Array<{ scopeId?: string }>;
  dto?: RuntimeScope["dto"];
  modelId?: string;
  events?: JsonValue[];
  consistency?: ConsistencyMessage[];
  OK?: boolean;
}
