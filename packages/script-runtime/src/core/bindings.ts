import { parse, type Node } from 'acorn';

/** Diagnostics only: Node still parses and executes the original program. */
export function lexicalBindings(script: string): string[] {
  const names: string[] = [];
  type Syntax = Node & { name?: string; body?: Syntax[]; kind?: string; declarations?: { id: Syntax }[];
    id?: Syntax; properties?: { type: string; value?: Syntax; argument?: Syntax }[];
    elements?: (Syntax | null)[]; left?: Syntax; argument?: Syntax };
  const pattern = (node?: Syntax | null): void => {
    if (!node) return;
    if (node.type === 'Identifier' && node.name) names.push(node.name);
    else if (node.type === 'ObjectPattern') for (const property of node.properties ?? []) pattern(property.type === 'RestElement' ? property.argument : property.value);
    else if (node.type === 'ArrayPattern') for (const element of node.elements ?? []) pattern(element);
    else if (node.type === 'AssignmentPattern') pattern(node.left);
    else if (node.type === 'RestElement') pattern(node.argument);
  };
  try {
    const tree = parse(script, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true }) as Syntax;
    for (const node of tree.body ?? []) {
      if (node.type === 'VariableDeclaration' && node.kind !== 'var') for (const declaration of node.declarations ?? []) pattern(declaration.id);
      else if (node.type === 'ClassDeclaration') pattern(node.id);
    }
  } catch { /* A newer Node syntax or an invalid cell must not change evaluation. */ }
  return names;
}
