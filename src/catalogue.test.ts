import assert from "node:assert/strict";
import test from "node:test";
import { loadCatalogue, findFields, getField } from "./catalogue.js";

const catalogue = loadCatalogue({
  modelXml: "config/model.xml",
  labelsProperties: "config/entity-labels.properties",
  scantaxXml: "config/scantax.xml",
});

test("catalogue loads model fields", () => {
  assert.ok(catalogue.fields.size > 2500);
  assert.ok(getField(catalogue, "STES3_EinkomVeraendErwartet"));
});

test("known fields from notes are present", () => {
  for (const fieldId of ["STES3_NettoEinkommenBund", "MAX_DEDUCTION_COLUMN_3A", "STES1_VBAbzugAMitBund", "listOfSecurities"]) {
    assert.ok(getField(catalogue, fieldId), fieldId);
  }
});

test("calculated fields are flagged", () => {
  const field = getField(catalogue, "STES3_NettoEinkommenBund");
  assert.equal(field?.calculated, true);
});

test("duplicate labels are reported", () => {
  const duplicateKeys = catalogue.diagnostics
    .filter((diagnostic) => diagnostic.type === "duplicate-label")
    .map((diagnostic) => diagnostic.key);

  assert.ok(duplicateKeys.includes("STES1_persID_Copy"));
  assert.ok(duplicateKeys.includes("KU1_13AbzugSelbstbehalt"));
  assert.ok(duplicateKeys.includes("WVS3_VerrechnungSteuer"));
  assert.ok(duplicateKeys.includes("LIEG00_TotalKosten"));
});

test("text search finds fields by label and id", () => {
  assert.ok(findFields(catalogue, "PersID", { includeCalculated: true }).some((field) => field.id === "STES1_persID"));
  assert.ok(findFields(catalogue, "STES3_EinkomVeraendErwartet", { includeCalculated: true }).some((field) => field.id === "STES3_EinkomVeraendErwartet"));
});
