import type * as checks from "./checks.js";
import type * as JSONSchema from "./json-schema.js";
import { $ZodRegistry, globalRegistry } from "./registries.js";
import type * as schemas from "./schemas.js";

interface JSONSchemaGeneratorParams {
  /** A registry used to look up metadata for each schema. Any schema with an `id` property will be extracted as a $def.
   *  @default globalRegistry */
  metadata?: $ZodRegistry<Record<string, any>>;
  /** The JSON Schema version to target.
   * - `"draft-2020-12"` — Default. JSON Schema Draft 2020-12
   * - `"draft-7"` — JSON Schema Draft 7 */
  target?: "draft-7" | "draft-2020-12";
  /** How to handle unrepresentable types.
   * - `"throw"` — Default. Unrepresentable types throw an error
   * - `"any"` — Unrepresentable types become `{}` */
  unrepresentable?: "throw" | "any";
  /** Arbitrary custom logic that can be used to modify the generated JSON Schema. */
  override?: (ctx: { zodSchema: schemas.$ZodType; jsonSchema: JSONSchema.BaseSchema }) => void;
  /** Whether to extract the `"input"` or `"output"` type. Relevant to transforms, Error converting schema to JSONz, defaults, coerced primitives, etc.
   * - `"output" — Default. Convert the output schema.
   * - `"input"` — Convert the input schema. */
  io?: "input" | "output";
}

interface ProcessParams {
  schemaPath: schemas.$ZodType[];
  path: (string | number)[];
}

interface EmitParams {
  /** How to handle cycles.
   * - `"ref"` — Default. Cycles will be broken using $defs
   * - `"throw"` — Cycles will throw an error if encountered */
  cycles?: "ref" | "throw";
  /* How to handle reused schemas.
   * - `"inline"` — Default. Reused schemas will be inlined
   * - `"ref"` — Reused schemas will be extracted as $defs */
  reused?: "ref" | "inline";

  external?:
    | {
        /**  */
        registry: $ZodRegistry<{ id?: string | undefined }>;
        uri: (id: string) => string;
        defs: Record<string, JSONSchema.BaseSchema>;
      }
    | undefined;
}

const formatMap: Partial<Record<checks.$ZodStringFormats, string>> = {
  guid: "uuid",
  url: "uri",
  datetime: "date-time",
  json_string: "json-string",
};

interface Seen {
  /** JSON Schema result for this Zod schema */
  schema: JSONSchema.BaseSchema;
  /** A cached version of the schema that doesn't get overwritten during ref resolution */
  def?: JSONSchema.BaseSchema;
  defId?: string | undefined;
  /** Number of times this schema was encountered during traversal */
  count: number;
  /** Cycle path */
  cycle?: (string | number)[] | undefined;
  isParent?: boolean | undefined;
  ref?: schemas.$ZodType | undefined | null;
}

export class JSONSchemaGenerator {
  metadataRegistry: $ZodRegistry<Record<string, any>>;
  target: "draft-7" | "draft-2020-12";
  unrepresentable: "throw" | "any";
  override: (ctx: { zodSchema: schemas.$ZodType; jsonSchema: JSONSchema.BaseSchema }) => void;
  io: "input" | "output";

  counter = 0;
  seen: Map<schemas.$ZodType, Seen>;

  constructor(params?: JSONSchemaGeneratorParams) {
    this.metadataRegistry = params?.metadata ?? globalRegistry;
    this.target = params?.target ?? "draft-2020-12";
    this.unrepresentable = params?.unrepresentable ?? "throw";
    this.override = params?.override ?? (() => {});
    this.io = params?.io ?? "output";

    this.seen = new Map();
  }

  process(schema: schemas.$ZodType, _params: ProcessParams = { path: [], schemaPath: [] }): JSONSchema.BaseSchema {
    const def = (schema as schemas.$ZodTypes)._zod.def;

    // check for schema in seens
    const seen = this.seen.get(schema);

    if (seen) {
      seen.count++;

      // check if cycle
      const isCycle = _params.schemaPath.includes(schema);
      if (isCycle) {
        seen.cycle = _params.path;
      }

      seen.count++;
      // break cycle
      return seen.schema;
    }

    // initialize
    const result: Seen = { schema: {}, count: 1, cycle: undefined };
    this.seen.set(schema, result);

    if (schema._zod.toJSONSchema) {
      // custom method overrides default behavior
      result.schema = schema._zod.toJSONSchema() as any;
    }

    // check if external
    // const ext = this.external?.registry.get(schema)?.id;
    // if (ext) {
    //   result.external = ext;
    // }

    const params = {
      ..._params,
      schemaPath: [..._params.schemaPath, schema],
      path: _params.path,
    };

    const parent = schema._zod.parent;
    // if (parent) {
    //   // schema was cloned from another schema
    //   result.ref = parent;
    //   this.process(parent, params);
    //   this.seen.get(parent)!.isParent = true;
    // }

    if (parent) {
      // schema was cloned from another schema
      result.ref = parent;
      this.process(parent, params);
      this.seen.get(parent)!.isParent = true;
    } else {
      const _json = result.schema;
      switch (def.type) {
        case "string": {
          const json: JSONSchema.StringSchema = _json as any;
          json.type = "string";
          const { minimum, maximum, format, pattern, contentEncoding } = schema._zod.bag as {
            minimum?: number;
            maximum?: number;
            format?: checks.$ZodStringFormats;
            pattern?: RegExp;
            contentEncoding?: string;
          };
          if (typeof minimum === "number") json.minLength = minimum;
          if (typeof maximum === "number") json.maxLength = maximum;
          // custom pattern overrides format
          if (format) {
            json.format = formatMap[format] ?? format;
          }
          if (pattern) {
            json.pattern = pattern.source;
          }
          if (contentEncoding) json.contentEncoding = contentEncoding;

          break;
        }
        case "number": {
          const json: JSONSchema.NumberSchema | JSONSchema.IntegerSchema = _json as any;
          const { minimum, maximum, format, multipleOf, exclusiveMaximum, exclusiveMinimum } = schema._zod.bag;
          if (typeof format === "string" && format.includes("int")) json.type = "integer";
          else json.type = "number";

          if (typeof exclusiveMinimum === "number") json.exclusiveMinimum = exclusiveMinimum;
          if (typeof minimum === "number") {
            json.minimum = minimum;
            if (typeof exclusiveMinimum === "number") {
              if (exclusiveMinimum >= minimum) delete json.minimum;
              else delete json.exclusiveMinimum;
            }
          }

          if (typeof exclusiveMaximum === "number") json.exclusiveMaximum = exclusiveMaximum;
          if (typeof maximum === "number") {
            json.maximum = maximum;
            if (typeof exclusiveMaximum === "number") {
              if (exclusiveMaximum <= maximum) delete json.maximum;
              else delete json.exclusiveMaximum;
            }
          }

          if (typeof multipleOf === "number") json.multipleOf = multipleOf;

          break;
        }
        case "boolean": {
          const json = _json as JSONSchema.BooleanSchema;
          json.type = "boolean";
          break;
        }
        case "bigint": {
          if (this.unrepresentable === "throw") {
            throw new Error("BigInt cannot be represented in JSON Schema");
          }
          break;
        }
        case "symbol": {
          if (this.unrepresentable === "throw") {
            throw new Error("Symbols cannot be represented in JSON Schema");
          }
          break;
        }
        case "undefined": {
          const json = _json as JSONSchema.NullSchema;
          json.type = "null";
          break;
        }
        case "null": {
          _json.type = "null";
          break;
        }
        case "any": {
          break;
        }
        case "unknown": {
          break;
        }
        case "never": {
          _json.not = {};
          break;
        }
        case "void": {
          if (this.unrepresentable === "throw") {
            throw new Error("Void cannot be represented in JSON Schema");
          }
          break;
        }
        case "date": {
          if (this.unrepresentable === "throw") {
            throw new Error("Date cannot be represented in JSON Schema");
          }
          break;
        }
        case "array": {
          const json: JSONSchema.ArraySchema = _json as any;
          const { minimum, maximum } = schema._zod.bag;
          if (typeof minimum === "number") json.minItems = minimum;
          if (typeof maximum === "number") json.maxItems = maximum;

          json.type = "array";
          json.items = this.process(def.element, { ...params, path: [...params.path, "items"] });
          break;
        }
        case "object": {
          const json: JSONSchema.ObjectSchema = _json as any;
          json.type = "object";
          json.properties = {};
          const shape = def.shape; // params.shapeCache.get(schema)!;

          for (const key in shape) {
            json.properties[key] = this.process(shape[key], {
              ...params,
              path: [...params.path, "properties", key],
            });
          }

          // required keys
          const allKeys = new Set(Object.keys(shape));
          // const optionalKeys = new Set(def.optional);
          const requiredKeys = new Set(
            [...allKeys].filter((key) => {
              const v = def.shape[key]._zod;
              if (this.io === "input") {
                return v.optin === undefined;
              } else {
                return v.optout === undefined;
              }
            })
          );
          json.required = Array.from(requiredKeys);

          // catchall
          if (def.catchall?._zod.def.type === "never") {
            json.additionalProperties = false;
          } else if (def.catchall) {
            json.additionalProperties = this.process(def.catchall, {
              ...params,
              path: [...params.path, "additionalProperties"],
            });
          }

          break;
        }
        case "union": {
          const json: JSONSchema.BaseSchema = _json as any;
          json.anyOf = def.options.map((x, i) =>
            this.process(x, {
              ...params,
              path: [...params.path, "anyOf", i],
            })
          );
          break;
        }
        case "intersection": {
          const json: JSONSchema.BaseSchema = _json as any;
          json.allOf = [
            this.process(def.left, {
              ...params,
              path: [...params.path, "allOf", 0],
            }),
            this.process(def.right, {
              ...params,
              path: [...params.path, "allOf", 1],
            }),
          ];
          break;
        }
        case "tuple": {
          const json: JSONSchema.ArraySchema = _json as any;
          json.type = "array";
          const prefixItems = def.items.map((x, i) =>
            this.process(x, { ...params, path: [...params.path, "prefixItems", i] })
          );
          if (this.target === "draft-2020-12") {
            json.prefixItems = prefixItems;
          } else {
            json.items = prefixItems;
          }

          if (def.rest) {
            const rest = this.process(def.rest, {
              ...params,
              path: [...params.path, "items"],
            });
            if (this.target === "draft-2020-12") {
              json.items = rest;
            } else {
              json.additionalItems = rest;
            }
          }

          // additionalItems
          if (def.rest) {
            json.items = this.process(def.rest, {
              ...params,
              path: [...params.path, "items"],
            });
          }

          // length
          const { minimum, maximum } = schema._zod.bag as {
            minimum?: number;
            maximum?: number;
          };
          if (typeof minimum === "number") json.minItems = minimum;
          if (typeof maximum === "number") json.maxItems = maximum;
          break;
        }
        case "record": {
          const json: JSONSchema.ObjectSchema = _json as any;
          json.type = "object";
          json.propertyNames = this.process(def.keyType, { ...params, path: [...params.path, "propertyNames"] });
          json.additionalProperties = this.process(def.valueType, {
            ...params,
            path: [...params.path, "additionalProperties"],
          });
          break;
        }
        case "map": {
          if (this.unrepresentable === "throw") {
            throw new Error("Map cannot be represented in JSON Schema");
          }
          break;
        }
        case "set": {
          if (this.unrepresentable === "throw") {
            throw new Error("Set cannot be represented in JSON Schema");
          }
          break;
        }
        case "enum": {
          const json: JSONSchema.BaseSchema = _json as any;
          json.enum = Object.values(def.entries);
          break;
        }
        case "literal": {
          const json: JSONSchema.BaseSchema = _json as any;
          const vals: (string | number | boolean | null)[] = [];
          for (const val of def.values) {
            if (val === undefined) {
              if (this.unrepresentable === "throw") {
                throw new Error("Literal `undefined` cannot be represented in JSON Schema");
              } else {
                // do not add to vals
              }
            } else if (typeof val === "bigint") {
              if (this.unrepresentable === "throw") {
                throw new Error("BigInt literals cannot be represented in JSON Schema");
              } else {
                vals.push(Number(val));
              }
            } else {
              vals.push(val);
            }
          }
          if (vals.length === 0) {
            // do nothing (an undefined literal was stripped)
          } else if (vals.length === 1) {
            const val = vals[0];
            json.const = val;
          } else {
            json.enum = vals;
          }
          break;
        }
        case "file": {
          if (this.unrepresentable === "throw") {
            throw new Error("File cannot be represented in JSON Schema");
          }
          break;
        }
        case "transform": {
          if (this.unrepresentable === "throw") {
            throw new Error("Transforms cannot be represented in JSON Schema");
          }
          break;
        }

        case "nullable": {
          const inner = this.process(def.innerType, params);
          _json.anyOf = [inner, { type: "null" }];
          break;
        }
        case "nonoptional": {
          this.process(def.innerType, params);
          result.ref = def.innerType;
          break;
        }
        case "success": {
          const json = _json as JSONSchema.BooleanSchema;
          json.type = "boolean";
          break;
        }
        case "default": {
          this.process(def.innerType, params);
          result.ref = def.innerType;
          _json.default = def.defaultValue;
          break;
        }
        case "prefault": {
          this.process(def.innerType, params);
          result.ref = def.innerType;
          if (this.io === "input") _json._prefault = def.defaultValue;

          break;
        }
        case "catch": {
          // use conditionals
          this.process(def.innerType, params);
          result.ref = def.innerType;
          let catchValue: any;
          try {
            catchValue = def.catchValue(undefined as any);
          } catch {
            throw new Error("Dynamic catch values are not supported in JSON Schema");
          }
          _json.default = catchValue;
          break;
        }
        case "nan": {
          if (this.unrepresentable === "throw") {
            throw new Error("NaN cannot be represented in JSON Schema");
          }
          break;
        }
        case "template_literal": {
          const json = _json as JSONSchema.StringSchema;
          const pattern = schema._zod.pattern;
          if (!pattern) throw new Error("Pattern not found in template literal");
          json.type = "string";
          json.pattern = pattern.source;
          break;
        }
        case "pipe": {
          const innerType = this.io === "input" ? def.in : def.out;
          this.process(innerType, params);
          result.ref = innerType;
          break;
        }
        case "readonly": {
          this.process(def.innerType, params);
          result.ref = def.innerType;
          _json.readOnly = true;
          break;
        }
        // passthrough types
        case "promise": {
          this.process(def.innerType, params);
          result.ref = def.innerType;
          break;
        }
        case "optional": {
          this.process(def.innerType, params);
          result.ref = def.innerType;
          break;
        }
        case "lazy": {
          const innerType = (schema as schemas.$ZodLazy)._zod.innerType;
          this.process(innerType, params);
          result.ref = innerType;
          break;
        }
        case "custom": {
          if (this.unrepresentable === "throw") {
            throw new Error("Custom types cannot be represented in JSON Schema");
          }
          break;
        }
        default: {
          def satisfies never;
        }
      }
    }

    // metadata
    const meta = this.metadataRegistry.get(schema);
    if (meta) Object.assign(result.schema, meta);
    if (this.io === "input" && def.type === "pipe") {
      // examples/defaults only apply to output type of pipe
      delete result.schema.examples;
      delete result.schema.default;
      if (result.schema._prefault) result.schema.default = result.schema._prefault;
    }
    if (this.io === "input" && result.schema._prefault) result.schema.default ??= result.schema._prefault;
    delete result.schema._prefault;

    // pulling fresh from this.seen in case it was overwritten
    const _result = this.seen.get(schema)!;

    return _result.schema;
  }

  emit(schema: schemas.$ZodType, _params?: EmitParams): JSONSchema.BaseSchema {
    const params = {
      cycles: _params?.cycles ?? "ref",
      reused: _params?.reused ?? "inline",
      // unrepresentable: _params?.unrepresentable ?? "throw",
      // uri: _params?.uri ?? ((id) => `${id}`),
      external: _params?.external ?? undefined,
    } satisfies EmitParams;

    // iterate over seen map;
    const root = this.seen.get(schema);

    if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");

    // initialize result with root schema fields
    // Object.assign(result, seen.cached);

    const makeURI = (entry: [schemas.$ZodType<unknown, unknown>, Seen]): { ref: string; defId?: string } => {
      // comparing the seen objects because sometimes
      // multiple schemas map to the same seen object.
      // e.g. lazy

      // external is configured
      const defsSegment = this.target === "draft-2020-12" ? "$defs" : "definitions";
      if (params.external) {
        const externalId = params.external.registry.get(entry[0])?.id; // ?? "__shared";// `__schema${this.counter++}`;

        // check if schema is in the external registry
        if (externalId) return { ref: params.external.uri(externalId) };

        // otherwise, add to __shared
        const id = entry[1].defId ?? entry[1].schema.id ?? `schema${this.counter++}`;
        entry[1].defId = id;
        return { defId: id, ref: `${params.external.uri("__shared")}#/${defsSegment}/${id}` };
      }

      if (entry[1] === root) {
        return { ref: "#" };
      }

      // self-contained schema
      const uriPrefix = `#`;
      const defUriPrefix = `${uriPrefix}/${defsSegment}/`;
      const defId = entry[1].schema.id ?? `__schema${this.counter++}`;
      return { defId, ref: defUriPrefix + defId };
    };

    const extractToDef = (entry: [schemas.$ZodType<unknown, unknown>, Seen]): void => {
      if (entry[1].schema.$ref) {
        return;
      }
      const seen = entry[1];
      const { ref, defId } = makeURI(entry);

      seen.def = { ...seen.schema };
      // defId won't be set if the schema is a reference to an external schema
      if (defId) seen.defId = defId;
      // wipe away all properties except $ref
      const schema = seen.schema;
      for (const key in schema) {
        delete schema[key];
        schema.$ref = ref;
      }
    };

    // extract schemas into $defs
    for (const entry of this.seen.entries()) {
      const seen = entry[1];

      // convert root schema to # $ref
      // also prevents root schema from being extracted
      if (schema === entry[0]) {
        // do not copy to defs...this is the root schema
        extractToDef(entry);
        continue;
      }

      // extract schemas that are in the external registry
      if (params.external) {
        const ext = params.external.registry.get(entry[0])?.id;
        if (schema !== entry[0] && ext) {
          extractToDef(entry);
          continue;
        }
      }

      // extract schemas with `id` meta
      const id = this.metadataRegistry.get(entry[0])?.id;
      if (id) {
        extractToDef(entry);

        continue;
      }

      // break cycles
      if (seen.cycle) {
        if (params.cycles === "throw") {
          throw new Error(
            "Cycle detected: " +
              `#/${seen.cycle?.join("/")}/<root>` +
              '\n\nSet the `cycles` parameter to `"ref"` to resolve cyclical schemas with defs.'
          );
        } else if (params.cycles === "ref") {
          extractToDef(entry);
        }
        continue;
      }

      // extract reused schemas
      if (seen.count > 1) {
        if (params.reused === "ref") {
          extractToDef(entry);
          // biome-ignore lint:
          continue;
        }
      }
    }

    // flatten _refs
    const flattenRef = (zodSchema: schemas.$ZodType, params: Pick<ToJSONSchemaParams, "target">) => {
      const seen = this.seen.get(zodSchema)!;
      const schema = seen.def ?? seen.schema;

      const _schema = { ...schema };
      if (seen.ref === null) {
        return;
      }

      const ref = seen.ref;
      seen.ref = null;
      if (ref) {
        flattenRef(ref, params);

        const refSchema = this.seen.get(ref)!.schema;

        if (refSchema.$ref && params.target === "draft-7") {
          schema.allOf = schema.allOf ?? [];
          schema.allOf.push(refSchema);
        } else {
          Object.assign(schema, refSchema);
          Object.assign(schema, _schema); // this is to prevent overwriting any fields in the original schema
        }
      }

      if (!seen.isParent)
        this.override({
          zodSchema,
          jsonSchema: schema,
        });
    };

    for (const entry of [...this.seen.entries()].reverse()) {
      flattenRef(entry[0], { target: this.target });
    }

    const result = { ...root.def };

    const defs: JSONSchema.BaseSchema["$defs"] = params.external?.defs ?? {};
    for (const entry of this.seen.entries()) {
      const seen = entry[1];
      if (seen.def && seen.defId) {
        defs[seen.defId] = seen.def;
      }
    }

    // set definitions in result
    if (!params.external && Object.keys(defs).length > 0) {
      if (this.target === "draft-2020-12") {
        result.$defs = defs;
      } else {
        result.definitions = defs;
      }
    }

    if (this.target === "draft-2020-12") {
      result.$schema = "https://json-schema.org/draft/2020-12/schema";
    } else if (this.target === "draft-7") {
      result.$schema = "http://json-schema.org/draft-07/schema#";
    } else {
      console.warn(`Invalid target: ${this.target}`);
    }

    try {
      // this "finalizes" this schema and ensures all cycles are removed
      // each call to .emit() is functionally independent
      // though the seen map is shared
      return JSON.parse(JSON.stringify(result));
    } catch (_err) {
      throw new Error("Error converting schema to JSON.");
    }
  }
}

interface ToJSONSchemaParams extends Omit<JSONSchemaGeneratorParams & EmitParams, never> {}
interface RegistryToJSONSchemaParams extends Omit<JSONSchemaGeneratorParams & EmitParams, never> {
  uri?: (id: string) => string;
}

export function toJSONSchema(schema: schemas.$ZodType, _params?: ToJSONSchemaParams): JSONSchema.BaseSchema;
export function toJSONSchema(
  registry: $ZodRegistry<{ id?: string | undefined }>,
  _params?: RegistryToJSONSchemaParams
): { schemas: Record<string, JSONSchema.BaseSchema> };
export function toJSONSchema(
  input: schemas.$ZodType | $ZodRegistry<{ id?: string | undefined }>,
  _params?: ToJSONSchemaParams
): any {
  if (input instanceof $ZodRegistry) {
    const gen = new JSONSchemaGenerator(_params);
    const defs: any = {};
    for (const entry of input._idmap.entries()) {
      const [_, schema] = entry;
      gen.process(schema);
    }

    const schemas: Record<string, JSONSchema.BaseSchema> = {};
    const external = {
      registry: input,
      uri: (_params as RegistryToJSONSchemaParams)?.uri || ((id) => id),
      defs,
    };
    for (const entry of input._idmap.entries()) {
      const [key, schema] = entry;
      schemas[key] = gen.emit(schema, {
        ..._params,
        external,
      });
    }

    if (Object.keys(defs).length > 0) {
      const defsSegment = gen.target === "draft-2020-12" ? "$defs" : "definitions";
      schemas.__shared = {
        [defsSegment]: defs,
      };
    }

    return { schemas };
  }

  const gen = new JSONSchemaGenerator(_params);
  gen.process(input);

  return gen.emit(input, _params);
}
