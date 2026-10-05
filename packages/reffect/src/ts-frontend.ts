/**
 * The milestone 8B translator's only contact with TypeScript (docs/research/ssr-codemod.md, step
 * 2): the workspace's own TypeScript 7 through its unstable sync API, pinned to 7.0.2. It opens a
 * project and answers what the translator asks of its source: files, where an identifier is
 * declared, and which module an import names. An API change is absorbed here.
 */
import { resolve } from "node:path";
import { API, SymbolFlags } from "typescript/unstable/sync";
import { SyntaxKind } from "typescript/unstable/ast";
import type { Identifier, Node, SourceFile } from "typescript/unstable/ast";

export { SyntaxKind };
export type { Identifier, Node, SourceFile };

/** Where an identifier comes from. */
export type Origin =
  /** A declaration in the project's own source (a local, or an import of a project file). */
  | { readonly _tag: "Source"; readonly declaration: Node }
  /** A binding imported from a package: the module specifier and the name it exports (`*` for a namespace import). */
  | { readonly _tag: "Library"; readonly module: string; readonly name: string }
  /** Nothing the frontend can name (a global, for one). */
  | { readonly _tag: "Unknown" };

export interface Frontend {
  readonly file: (path: string) => SourceFile;
  readonly origin: (identifier: Identifier) => Origin;
  readonly close: () => void;
}

const SOURCE_DECLARATIONS = new Set<SyntaxKind>([
  SyntaxKind.VariableDeclaration,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.Parameter,
  SyntaxKind.BindingElement,
]);

/** Opens `tsconfig` and keeps the project until `close`. */
export const openFrontend = (tsconfig: string): Frontend => {
  const config = resolve(tsconfig);
  const api = new API({ cwd: resolve(config, "..") });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  const project = snapshot.getProjects()[0];
  if (project === undefined) {
    api.close();
    throw new Error(`No project opened from ${config}`);
  }
  const { program, checker } = project;
  const file = (path: string): SourceFile => {
    const found = program.getSourceFile(resolve(path));
    if (found === undefined) throw new Error(`${path} is not in the project`);
    return found;
  };
  // A node handle resolved within this project's program.
  const node = (handle: { resolve(): Node | undefined } | undefined) => handle?.resolve();
  const origin = (identifier: Identifier): Origin => {
    // `{ Flags }` names a property and reads the value in scope; the value is the origin.
    const symbol =
      identifier.parent?.kind === SyntaxKind.ShorthandPropertyAssignment
        ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
        : checker.getSymbolAtLocation(identifier);
    if (symbol === undefined) return { _tag: "Unknown" };
    if ((symbol.flags & SymbolFlags.Alias) !== 0) {
      const specifier = node(symbol.declarations[0]);
      let declaration: Node | undefined = specifier;
      while (declaration !== undefined && declaration.kind !== SyntaxKind.ImportDeclaration)
        declaration = declaration.parent;
      if (specifier === undefined) return { _tag: "Unknown" };
      // A re-export (`export { view } from './index.js'`) is its target's declaration.
      if (declaration === undefined) {
        const target = checker.getAliasedSymbol(symbol);
        const declared = node(target.valueDeclaration ?? target.declarations[0]);
        return declared !== undefined &&
          SOURCE_DECLARATIONS.has(declared.kind) &&
          !program.isSourceFileFromExternalLibrary(declared.getSourceFile())
          ? { _tag: "Source", declaration: declared }
          : { _tag: "Unknown" };
      }
      const module = (
        declaration as unknown as { readonly moduleSpecifier: { readonly text: string } }
      ).moduleSpecifier.text;
      const target = checker.getAliasedSymbol(symbol);
      const declared = node(target.valueDeclaration ?? target.declarations[0]);
      // An import of a project file is that file's declaration; a package's is its name.
      if (
        declared !== undefined &&
        !program.isSourceFileFromExternalLibrary(declared.getSourceFile())
      )
        return SOURCE_DECLARATIONS.has(declared.kind) || declared.kind === SyntaxKind.SourceFile
          ? { _tag: "Source", declaration: declared }
          : { _tag: "Unknown" };
      const named = specifier as unknown as {
        readonly kind: SyntaxKind;
        readonly name: { readonly text: string };
        readonly propertyName?: { readonly text: string };
      };
      const name =
        named.kind === SyntaxKind.NamespaceImport ? "*" : (named.propertyName ?? named.name).text;
      return { _tag: "Library", module, name };
    }
    const declared = node(symbol.valueDeclaration ?? symbol.declarations[0]);
    return declared !== undefined &&
      SOURCE_DECLARATIONS.has(declared.kind) &&
      !program.isSourceFileFromExternalLibrary(declared.getSourceFile())
      ? { _tag: "Source", declaration: declared }
      : { _tag: "Unknown" };
  };
  return { file, origin, close: () => api.close() };
};
