/**
 * The read of `foldkit-remote-server` 0.10.0's memory backend (`memory`'s entity sources,
 * `valueFor` and `pageOf` without `locate`). Since 0.11.0 `RemoteServer.memory(...).server` is
 * served directly (foldkit-plus#140); this copy remains only for the authorization test, because
 * `memory` takes no per-entity `authorize`. Everything else is the published server.
 *
 * MIT License, Copyright (c) 2026 Patrick Glenn (https://github.com/doeixd/foldkit-plus,
 * packages/remote-server/src/index.ts). Permission is hereby granted, free of charge, to any
 * person obtaining a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, subject to the conditions of the
 * MIT License: the above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT
 * WARRANTY OF ANY KIND.
 */
import { Effect, Schema } from "effect";
import { evaluate } from "foldkit-entity";
import type { AnyQuery, Row } from "foldkit-entity";
import { RemoteServerError } from "foldkit-remote-server";

type Boundary =
  | { readonly _tag: "Terminal" }
  | { readonly _tag: "Unknown" }
  | { readonly _tag: "Cursor"; readonly cursor: string };
interface Window {
  readonly first?: number | undefined;
  readonly last?: number | undefined;
  readonly after?: string | undefined;
  readonly before?: string | undefined;
}
interface Position {
  readonly index: number;
  readonly exact: boolean;
}

const pageOf = <Item>(
  items: ReadonlyArray<Item>,
  window: Window,
  idOf: (item: Item) => string,
  locate?: (cursor: string) => Position,
): { readonly items: ReadonlyArray<Item>; readonly start: Boundary; readonly end: Boundary } => {
  if (
    (window.after !== undefined && window.before !== undefined) ||
    (window.first !== undefined && window.last !== undefined)
  ) {
    throw new Error("A query window cannot combine after with before, or first with last");
  }
  const position = (cursor: string): Position => {
    const index = items.findIndex((item) => idOf(item) === cursor);
    if (index >= 0) return { index, exact: true };
    if (locate !== undefined) return locate(cursor);
    throw new Error(`Cursor "${cursor}" names nothing in these results`);
  };
  const cursor = (id: string): Boundary => ({ _tag: "Cursor", cursor: id });
  const terminal: Boundary = { _tag: "Terminal" };
  const unknown: Boundary = { _tag: "Unknown" };
  if (window.last !== undefined || window.before !== undefined) {
    const to = window.before === undefined ? items.length : position(window.before).index;
    const from = window.last === undefined ? 0 : Math.max(0, to - window.last);
    const page = items.slice(from, to);
    const start =
      from === 0
        ? terminal
        : page.length > 0
          ? cursor(idOf(page[0]!))
          : window.before === undefined
            ? unknown
            : cursor(window.before);
    return {
      items: page,
      start,
      end: window.before === undefined ? terminal : cursor(window.before),
    };
  }
  const at = window.after === undefined ? undefined : position(window.after);
  const from = at === undefined ? 0 : at.exact ? at.index + 1 : at.index;
  const to =
    window.first === undefined ? items.length : Math.min(items.length, from + window.first);
  const page = items.slice(from, to);
  const end =
    to >= items.length
      ? terminal
      : page.length > 0
        ? cursor(idOf(page.at(-1)!))
        : window.after === undefined
          ? unknown
          : cursor(window.after);
  return { items: page, start: window.after === undefined ? terminal : cursor(window.after), end };
};

const valueFor = (value: unknown, window: Window | undefined): unknown => {
  if (window === undefined || !Array.isArray(value)) return value;
  const refs = [...new Set(value as ReadonlyArray<string>)];
  const idOf = (ref: string) => ref.slice(ref.indexOf(":") + 1);
  const named = (cursor: string | undefined) =>
    cursor === undefined ? undefined : cursor.includes(":") ? idOf(cursor) : cursor;
  let page: ReturnType<typeof pageOf<string>>;
  try {
    page = pageOf(
      refs,
      { ...window, after: named(window.after), before: named(window.before) },
      idOf,
    );
  } catch {
    return { refs: [], hasNext: false, hasPrevious: false };
  }
  return {
    refs: page.items,
    hasNext: page.end._tag === "Cursor",
    hasPrevious: page.start._tag === "Cursor",
  };
};

/** Tables by entity: rows keyed by ID in insertion order. */
export interface MemoryTables {
  readonly get: (
    entity: string,
  ) => ReadonlyMap<string, Readonly<Record<string, unknown>>> | undefined;
}

/** The memory backend's tables: keyed by `String(row.id)`, rows copied, in insertion order. */
export const memoryTables = (
  rows: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>,
) => {
  const tables = new Map<string, Map<string, Record<string, unknown>>>();
  for (const [entity, list] of Object.entries(rows)) {
    const table = tables.get(entity) ?? new Map<string, Record<string, unknown>>();
    tables.set(entity, table);
    for (const row of list) table.set(String(row.id), { ...row });
  }
  return tables;
};

/** One entity's memory source `read`, as `memory` builds it for `RemoteServer.entity`. */
export const memoryRead =
  (tables: MemoryTables, name: string) =>
  ({
    ids,
    fields,
    windows,
  }: {
    readonly ids: readonly string[];
    readonly fields: readonly string[];
    readonly windows?: Readonly<Record<string, Window>> | undefined;
  }) =>
    Effect.sync(() =>
      ids.flatMap((id) => {
        const row = tables.get(name)?.get(id);
        if (row === undefined) return [];
        const values = Object.fromEntries(
          fields.flatMap((field) =>
            field in row ? [[field, valueFor(row[field], windows?.[field])] as const] : [],
          ),
        );
        return [{ id, values }];
      }),
    );

/**
 * One query's memory source `run`, as `memory` builds it for `RemoteServer.query`: the body runs
 * through the reference `evaluate`, and a cursor row that stopped matching is placed by `locate`.
 */
export const memoryQueryRun =
  (
    tables: MemoryTables,
    query: { readonly Input: Schema.Codec<unknown>; readonly body?: AnyQuery | undefined },
  ) =>
  ({ input, window }: { readonly input: unknown; readonly window: Window }) =>
    Effect.try({
      try: () => {
        const body = query.body!;
        const encoded = Schema.encodeSync(query.Input)(input) as Readonly<Record<string, unknown>>;
        const entity = body.entity.name;
        const rows = [...(tables.get(entity)?.values() ?? [])] as ReadonlyArray<Row>;
        const matched = evaluate(body, encoded, rows);
        const locate = (cursor: string) => {
          const row = rows.find((candidate) => String(candidate.id) === cursor);
          if (row === undefined)
            throw new Error(`Cursor "${cursor}" names a row that no longer exists`);
          const placed = evaluate({ ...body, where: [] }, encoded, [...matched, row]);
          return { index: placed.indexOf(row), exact: false };
        };
        const page = pageOf(matched, window, (row) => String(row.id), locate);
        return {
          edges: page.items.map((row) => {
            const id = String(row.id);
            return { entity, id, key: `${entity}:${id}` };
          }),
          start: page.start,
          end: page.end,
        };
      },
      catch: (error) =>
        new RemoteServerError({ message: error instanceof Error ? error.message : String(error) }),
    });
