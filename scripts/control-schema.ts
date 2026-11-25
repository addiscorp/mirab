#!/usr/bin/env bun
// The control protocol's generated files, from its one definition
// (src/control/protocol.ts):
//
//   protocol/control.v1.json      the JSON Schema
//   crates/mirab/src/protocol.rs  the Rust client's types
//
//   bun scripts/control-schema.ts          writes them
//   bun scripts/control-schema.ts --check  fails if either differs (CI)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  CONTROL_PROTOCOL,
  operations,
  protocolSchema,
} from '../src/control/protocol'

type Schema = Record<string, any>

const RUST_KEYWORDS = new Set(['type', 'ref', 'move', 'match', 'use', 'in'])

const pascal = (s: string) =>
  s
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join('')

const snake = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toLowerCase()

const comment = (text: string | undefined, indent = '') =>
  text
    ? text
        .split('\n')
        .map((l) => `${indent}/// ${l}`.trimEnd())
        .join('\n') + '\n'
    : ''

/** Generates Rust for a JSON Schema: one item per named object or enum. */
export class RustTypes {
  readonly items = new Map<string, string>()
  constructor(private readonly defs: Record<string, Schema>) {}

  /** The Rust type for `schema`; `name` names it if it needs an item. */
  type(schema: Schema, name: string): string {
    if (schema.$ref) {
      const def = String(schema.$ref).replace('#/$defs/', '')
      if (!this.items.has(def)) {
        this.items.set(def, '') // A cycle ends here.
        this.items.set(def, this.item(this.defs[def]!, def))
      }
      return def
    }
    if (schema.anyOf || schema.oneOf) return this.union(schema, name)
    if (schema.enum)
      return this.named(name, () => this.stringEnum(schema, name))
    switch (schema.type) {
      case 'string':
        return 'String'
      case 'boolean':
        return 'bool'
      case 'integer':
        return 'i64'
      case 'number':
        return 'f64'
      case 'array':
        return `Vec<${this.type(schema.items ?? {}, `${name}Item`)}>`
      case 'object':
        if (schema.properties)
          return this.named(name, () => this.struct(schema, name))
        if (this.isOpenMap(schema))
          return `std::collections::BTreeMap<String, ${this.type(schema.additionalProperties, `${name}Value`)}>`
        return 'serde_json::Value'
      default:
        return 'serde_json::Value'
    }
  }

  private isOpenMap = (s: Schema) =>
    s.additionalProperties &&
    typeof s.additionalProperties === 'object' &&
    Object.keys(s.additionalProperties).length > 0

  private named(name: string, make: () => string) {
    if (!this.items.has(name)) {
      this.items.set(name, '')
      this.items.set(name, make())
    }
    return name
  }

  private item(schema: Schema, name: string): string {
    if (schema.oneOf || schema.anyOf) return this.unionBody(schema, name)
    if (schema.enum) return this.stringEnum(schema, name)
    return this.struct(schema, name)
  }

  private struct(schema: Schema, name: string): string {
    const required = new Set<string>(schema.required ?? [])
    const fields = Object.entries<Schema>(schema.properties ?? {}).map(
      ([key, value]) => this.field(key, value, name, required.has(key)),
    )
    return `${comment(schema.description)}#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ${name} {
${fields.join('\n')}
}
`
  }

  private field(key: string, value: Schema, owner: string, required: boolean) {
    const rust = snake(key)
    const ident = RUST_KEYWORDS.has(rust) ? `r#${rust}` : rust
    const inner = this.type(value, `${owner}${pascal(key)}`)
    const attrs: string[] = []
    if (rust !== key) attrs.push(`rename = "${key}"`)
    // A default in the schema means the field is always there once parsed,
    // but a client still reads it leniently.
    if (!required && value.default !== undefined) attrs.push('default')
    const optional = !required && value.default === undefined
    if (optional)
      attrs.push('default', 'skip_serializing_if = "Option::is_none"')
    const line = attrs.length ? `    #[serde(${attrs.join(', ')})]\n` : ''
    return `${comment(value.description, '    ')}${line}    pub ${ident}: ${optional ? `Option<${inner}>` : inner},`
  }

  private stringEnum(schema: Schema, name: string): string {
    const variants = (schema.enum as string[]).map(
      (v) => `    #[serde(rename = "${v}")]\n    ${pascal(v)},`,
    )
    return `${comment(schema.description)}#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ${name} {
${variants.join('\n')}
}
`
  }

  private union(schema: Schema, name: string): string {
    return this.named(name, () => this.unionBody(schema, name))
  }

  private unionBody(schema: Schema, name: string): string {
    const options: Schema[] = schema.oneOf ?? schema.anyOf
    const tag = this.tagOf(options)
    if (tag) return this.taggedEnum(schema, options, tag, name)
    // Scalars or objects told apart by their fields.
    const variants = options.map((option, i) => {
      const label = this.variantLabel(option, i)
      return `    ${label}(${this.type(option, `${name}${label}`)}),`
    })
    return `${comment(schema.description)}#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ${name} {
${variants.join('\n')}
}
`
  }

  private variantLabel(option: Schema, i: number) {
    if (option.type === 'integer') return 'Integer'
    if (option.type === 'string') return 'Text'
    if (option.properties?.command) return 'Command'
    if (option.properties?.file) return 'TypeScript'
    return `Variant${i}`
  }

  private tagOf(options: Schema[]) {
    const first = options[0]?.properties
    if (!first) return undefined
    return Object.keys(first).find((k) =>
      options.every((o) => o.properties?.[k]?.const !== undefined),
    )
  }

  private taggedEnum(
    schema: Schema,
    options: Schema[],
    tag: string,
    name: string,
  ) {
    const variants = options.map((option) => {
      const value = option.properties[tag].const as string
      const variant = pascal(value)
      const required = new Set<string>(option.required ?? [])
      const fields = Object.entries<Schema>(option.properties)
        .filter(([k]) => k !== tag)
        .map(([k, v]) =>
          this.field(k, v, `${name}${variant}`, required.has(k))
            .split('\n')
            .map((l) => `    ${l.replace(/^(\s*)pub /, '$1')}`)
            .join('\n'),
        )
      return `${comment(option.description, '    ')}    #[serde(rename = "${value}")]
    ${variant} {
${fields.join('\n')}
    },`
    })
    return `${comment(schema.description)}#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "${tag}")]
pub enum ${name} {
${variants.join('\n')}
}
`
  }
}

export function rustSource(schema: Schema): string {
  const types = new RustTypes(schema.$defs ?? {})
  const ops = schema.properties.operations.properties as Record<string, Schema>
  const impls: string[] = []
  for (const name of Object.keys(operations)) {
    const base = pascal(name)
    const params = types.type(ops[name]!.properties.params, `${base}Params`)
    const result = types.type(ops[name]!.properties.result, `${base}Result`)
    impls.push(`impl Operation for ${params} {
    const OP: &'static str = "${name}";
    type Result = ${result};
}
`)
  }
  types.type(schema.properties.event, 'Event')
  types.type(schema.properties.error, 'ControlError')
  const items = [...types.items.keys()]
    .sort()
    .map((k) => types.items.get(k)!)
    .join('\n')
  return `// @generated by scripts/control-schema.ts from src/control/protocol.ts.
// Do not edit: run \`bun scripts/control-schema.ts\`. CI fails if this differs.
#![allow(missing_docs)]

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// The control protocol version this crate speaks.
pub const PROTOCOL: i64 = ${CONTROL_PROTOCOL};

/// A request: its operation's name and what it answers.
pub trait Operation: Serialize {
    const OP: &'static str;
    type Result: DeserializeOwned;
}

${items}
${impls.join('\n')}`
}

const root = join(import.meta.dir, '..')
const SCHEMA = join(root, 'protocol/control.v1.json')
const RUST = join(root, 'crates/mirab/src/protocol.rs')

if (import.meta.main) {
  const schema = protocolSchema()
  const files: [string, string][] = [
    [SCHEMA, JSON.stringify(schema, null, 2) + '\n'],
    [RUST, rustSource(schema)],
  ]
  if (process.argv.includes('--check')) {
    let stale = false
    // The crate is released with mirab, under the same version.
    const crate = /^version = "([^"]+)"/m.exec(
      readFileSync(join(root, 'crates/mirab/Cargo.toml'), 'utf8'),
    )?.[1]
    const { version } = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    )
    if (crate !== version) {
      console.error(
        `crates/mirab is ${crate}, package.json is ${version}: they move together`,
      )
      stale = true
    }
    for (const [path, text] of files) {
      const now = (() => {
        try {
          return readFileSync(path, 'utf8')
        } catch {
          return undefined
        }
      })()
      if (now !== text) {
        console.error(`${path} differs from src/control/protocol.ts`)
        stale = true
      }
    }
    if (stale) {
      console.error('run: bun scripts/control-schema.ts, and commit the result')
      process.exit(1)
    }
    console.log('the control protocol files match src/control/protocol.ts')
  } else
    for (const [path, text] of files) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
      console.log(`wrote ${path}`)
    }
}
