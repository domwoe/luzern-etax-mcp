import { readFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";
import type { Catalogue, CatalogueDiagnostic, FieldSummary, FieldType } from "./types.js";

export interface CataloguePaths {
  modelXml: string;
  labelsProperties: string;
  scantaxXml?: string;
}

const FIELD_TAGS = new Set(["string", "boolean", "integer", "float", "date", "text", "list", "dictionary", "table"]);

interface ParsedLabels {
  labels: Map<string, string>;
  diagnostics: CatalogueDiagnostic[];
}

interface ScantaxPosition {
  form?: string | undefined;
  fref?: string | undefined;
  seq?: string | undefined;
}

export function loadCatalogue(paths: CataloguePaths): Catalogue {
  const labels = parseLabels(readFileSync(paths.labelsProperties, "utf8"));
  const scantax = paths.scantaxXml ? parseScantax(readFileSync(paths.scantaxXml, "utf8")) : new Map<string, ScantaxPosition>();
  const fields = parseModel(readFileSync(paths.modelXml, "utf8"), labels.labels, scantax);

  return {
    fields,
    diagnostics: labels.diagnostics,
  };
}

export function findFields(catalogue: Catalogue, query: string, options: { limit?: number; includeCalculated?: boolean } = {}): FieldSummary[] {
  const normalized = query.trim().toLowerCase();
  const limit = options.limit ?? 20;
  const results: FieldSummary[] = [];

  for (const field of catalogue.fields.values()) {
    if (!options.includeCalculated && field.calculated) {
      continue;
    }
    const haystack = `${field.id} ${field.label ?? ""} ${field.type}`.toLowerCase();
    if (!normalized || haystack.includes(normalized)) {
      results.push(field);
    }
    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

export function getField(catalogue: Catalogue, fieldId: string): FieldSummary | undefined {
  return catalogue.fields.get(fieldId);
}

function parseLabels(source: string): ParsedLabels {
  const labels = new Map<string, string>();
  const diagnostics: CatalogueDiagnostic[] = [];

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) {
      continue;
    }
    const separator = line.search(/[:=]/);
    const key = separator >= 0 ? line.slice(0, separator).trim() : line;
    const value = separator >= 0 ? line.slice(separator + 1).trim() : "";
    if (!key) {
      continue;
    }
    if (labels.has(key)) {
      diagnostics.push({
        type: "duplicate-label",
        key,
        message: `Duplicate label key: ${key}`,
      });
      continue;
    }
    labels.set(key, decodePropertiesValue(value));
  }

  return { labels, diagnostics };
}

function decodePropertiesValue(value: string): string {
  return value.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function parseModel(source: string, labels: Map<string, string>, scantax: Map<string, ScantaxPosition>): Map<string, FieldSummary> {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
  });
  const parsed = parser.parse(source) as unknown;
  const fields = new Map<string, FieldSummary>();

  visitModelNode(parsed, (tag, node) => {
    if (!FIELD_TAGS.has(tag)) {
      return;
    }
    const id = stringAttr(node, "@_id");
    if (!id || fields.has(id)) {
      return;
    }
    fields.set(id, {
      id,
      type: normalizeType(tag),
      label: labels.get(id),
      calculated: boolAttr(node, "@_calculated") || hasChild(node, "expression"),
      enabled: !boolAttr(node, "@_enabled", false),
      visible: !boolAttr(node, "@_visible", false),
      enumId: stringAttr(node, "@_enum") ?? stringAttr(node, "@_enumeration"),
      scantax: scantax.get(id),
      sourceFiles: ["config/model.xml", ...(labels.has(id) ? ["config/entity-labels.properties"] : []), ...(scantax.has(id) ? ["config/scantax.xml"] : [])],
    });
  });

  return fields;
}

function parseScantax(source: string): Map<string, ScantaxPosition> {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
  });
  const parsed = parser.parse(source) as unknown;
  const positions = new Map<string, ScantaxPosition>();
  let currentForm: string | undefined;

  visitModelNode(parsed, (tag, node) => {
    if (tag === "formInfo") {
      currentForm = stringAttr(node, "@_identification");
      return;
    }
    const sourceId = stringAttr(node, "@_source");
    if (!sourceId || positions.has(sourceId)) {
      return;
    }
    positions.set(sourceId, {
      form: currentForm,
      fref: stringAttr(node, "@_fref"),
      seq: stringAttr(node, "@_seq"),
    });
  });

  return positions;
}

function visitModelNode(value: unknown, visitor: (tag: string, node: Record<string, unknown>) => void): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      visitModelNode(item, visitor);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === "object") {
      const nodes = Array.isArray(child) ? child : [child];
      for (const node of nodes) {
        if (node && typeof node === "object" && !Array.isArray(node)) {
          visitor(key, node as Record<string, unknown>);
          visitModelNode(node, visitor);
        }
      }
    }
  }
}

function normalizeType(tag: string): FieldType {
  return tag === "float" ? "decimal" : tag;
}

function stringAttr(node: Record<string, unknown>, key: string): string | undefined {
  const value = node[key];
  return typeof value === "string" && value ? value : undefined;
}

function boolAttr(node: Record<string, unknown>, key: string, defaultWhenPresent = true): boolean {
  const value = node[key];
  if (value === undefined) {
    return false;
  }
  if (value === "") {
    return defaultWhenPresent;
  }
  return String(value).toLowerCase() === "true";
}

function hasChild(node: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(node, key);
}
