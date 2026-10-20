/**
 * Minimal draft-07 validator for vendored upstream schemas. It supports exactly the keywords
 * those schemas use ($ref to local definitions, type, required, properties, additionalProperties,
 * items, enum, const, anyOf) and throws on any other assertion keyword, so a schema it cannot
 * fully check is never reported as valid.
 */
type Schema = Record<string, unknown>;
const ANNOTATIONS = new Set(["$schema", "description", "examples", "title", "default"]);
const SUPPORTED = new Set(["$ref", "type", "required", "properties", "additionalProperties", "items", "enum", "const", "anyOf"]);

const typeOf = (value: unknown): string => value === null ? "null" : Array.isArray(value) ? "array"
  : Number.isInteger(value) ? "integer" : typeof value;

export function schemaErrors(root: Schema, schema: Schema, value: unknown, path = "$"): string[] {
  for (const keyword of Object.keys(schema)) {
    if (!ANNOTATIONS.has(keyword) && !SUPPORTED.has(keyword) && keyword !== "definitions") throw new Error(`unsupported schema keyword ${keyword} at ${path}`);
  }
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.match(/^#\/definitions\/([^/]+)$/)?.[1];
    const target = name ? (root.definitions as Record<string, Schema>)[name] : undefined;
    if (!target) throw new Error(`unresolvable $ref ${schema.$ref}`);
    return schemaErrors(root, target, value, path);
  }
  const errors: string[] = [];
  if (schema.type !== undefined && typeof schema.type !== "string") throw new Error(`unsupported type list at ${path}`);
  if (typeof schema.type === "string") {
    const actual = typeOf(value);
    if (actual !== schema.type && !(schema.type === "number" && actual === "integer")) return [`${path}: expected ${schema.type}, got ${actual}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if ("const" in schema && schema.const !== value) errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((option) => schemaErrors(root, option as Schema, value, path).length === 0)) {
    errors.push(`${path}: matches no anyOf option`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => errors.push(...schemaErrors(root, schema.items as Schema, item, `${path}[${index}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const name of (schema.required as string[] | undefined) ?? []) if (!Object.hasOwn(object, name)) errors.push(`${path}: missing required ${name}`);
    const properties = (schema.properties as Record<string, Schema> | undefined) ?? {};
    for (const [name, child] of Object.entries(object)) {
      if (properties[name]) errors.push(...schemaErrors(root, properties[name], child, `${path}.${name}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property ${name}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...schemaErrors(root, schema.additionalProperties as Schema, child, `${path}.${name}`));
      }
    }
  }
  return errors;
}
