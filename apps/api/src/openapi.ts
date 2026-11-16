import { z } from 'zod';
import { type ApiRoute, type ResponseSpec } from './route.js';

export const API_KEY_HEADER = 'X-API-Key';

type JsonSchema = Record<string, unknown>;

/**
 * Shared definitions of recursive schemas (e.g. a JSON value), hoisted from each
 * schema's local `$defs` into `components/schemas`: a `#/$defs/...` reference would
 * otherwise resolve against the root of the OpenAPI document.
 */
class Components {
  readonly schemas: Record<string, JsonSchema> = {};
  private readonly byContent = new Map<string, string>();

  hoist(schema: JsonSchema): JsonSchema {
    const defs = schema['$defs'] as Record<string, JsonSchema> | undefined;
    if (!defs) return schema;
    delete schema['$defs'];
    const rename = new Map<string, string>();
    for (const [local, def] of Object.entries(defs)) {
      const key = JSON.stringify(def);
      let name = this.byContent.get(key);
      if (!name) {
        const json = JSON.stringify(def['anyOf'] ?? []);
        const base =
          /"string"/.test(json) && /"boolean"/.test(json) && /"array"/.test(json)
            ? 'JsonValue'
            : 'Schema';
        name = base;
        for (let n = 2; name in this.schemas; n++) name = `${base}${n}`;
        this.byContent.set(key, name);
        this.schemas[name] = def;
      }
      rename.set(`#/$defs/${local}`, `#/components/schemas/${name}`);
    }
    const rewrite = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(rewrite);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          k === '$ref' && typeof v === 'string' ? (rename.get(v) ?? v) : rewrite(v),
        ]),
      );
    };
    for (const [name, def] of Object.entries(this.schemas)) {
      this.schemas[name] = rewrite(def) as JsonSchema;
    }
    return rewrite(schema) as JsonSchema;
  }
}

let components = new Components();

/** JSON Schema (2020-12, as OpenAPI 3.1 uses) for a Zod schema, inlined except recursive parts. */
export function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const out = z.toJSONSchema(schema, {
    io,
    unrepresentable: 'any',
    reused: 'inline',
  }) as JsonSchema;
  delete out['$schema'];
  return components.hoist(out);
}

const isOptional = (schema: z.ZodType) => schema.safeParse(undefined).success;

function parameters(route: ApiRoute): JsonSchema[] {
  const list: JsonSchema[] = [];
  for (const [where, object] of [
    ['path', route.params],
    ['query', route.query],
  ] as const) {
    if (!object) continue;
    for (const [name, schema] of Object.entries(object.shape as Record<string, z.ZodType>)) {
      list.push({
        name,
        in: where,
        required: where === 'path' || !isOptional(schema),
        schema: jsonSchema(schema, 'input'),
        ...(schema.description && { description: schema.description }),
      });
    }
  }
  return list;
}

function content(spec: ResponseSpec): JsonSchema | undefined {
  if (!spec.schema && !spec.contentType) return undefined;
  const type = spec.contentType ?? 'application/json';
  const schema =
    type === 'text/event-stream'
      ? { type: 'string', description: 'Server-sent events; see the operation description.' }
      : type === 'application/octet-stream'
        ? { type: 'string', format: 'binary' }
        : spec.schema
          ? jsonSchema(spec.schema, 'output')
          : {};
  return { [type]: { schema } };
}

/** The OpenAPI 3.1 document for `routes`, served at `/openapi.json` and shown at `/docs`. */
export function openApiDocument(
  routes: readonly ApiRoute[],
  info: { readonly version: string },
): JsonSchema {
  components = new Components();
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const responses: Record<string, unknown> = {};
    for (const [status, spec] of Object.entries(r.responses)) {
      const body = content(spec);
      responses[status] = { description: spec.description, ...(body && { content: body }) };
    }
    const requestBody = r.body
      ? {
          required: true,
          content:
            r.bodyType === 'multipart'
              ? { 'multipart/form-data': { schema: multipartSchema(r.body) } }
              : { 'application/json': { schema: jsonSchema(r.body, 'input') } },
        }
      : undefined;
    (paths[r.path] ??= {})[r.method] = {
      tags: [r.tag],
      summary: r.summary,
      ...(r.description && { description: r.description }),
      operationId: `${r.method}${r.path.replace(/[{}]/g, '').replace(/[/-](\w)/g, (_, ch: string) => ch.toUpperCase())}`,
      security: r.auth === false ? [] : [{ apiKey: [] }],
      parameters: parameters(r),
      ...(requestBody && { requestBody }),
      responses,
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Research Assistant Agent API',
      version: info.version,
      description:
        'HTTP API for the local agent service (apps/agent). The API talks to the agent over its ' +
        'authenticated loopback protocol; the agent token never reaches the browser. Send the API ' +
        `key in the ${API_KEY_HEADER} header (or as a Bearer token).`,
    },
    servers: [{ url: '/' }],
    components: {
      schemas: components.schemas,
      securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: API_KEY_HEADER } },
    },
    paths,
  };
}

/** Multipart bodies: the file fields as binary strings. */
function multipartSchema(body: z.ZodType): JsonSchema {
  const shape = body instanceof z.ZodObject ? (body.shape as Record<string, z.ZodType>) : {};
  const properties: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(shape)) {
    properties[name] = field.description?.startsWith('file')
      ? { type: 'string', format: 'binary', description: field.description }
      : jsonSchema(field, 'input');
  }
  return { type: 'object', properties, required: Object.keys(shape) };
}
