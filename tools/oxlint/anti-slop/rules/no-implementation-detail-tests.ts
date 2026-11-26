import { defineRule } from '@oxlint/plugins';

import { resolveVariable } from '../shared/scope.ts';

import type { ESTree, SourceCode, Variable } from '@oxlint/plugins';

const equalityMatchers = new Set(['toBe', 'toEqual', 'toStrictEqual', 'toMatchObject']);
const domDetails = new Set(['className', 'classList']);
const positioningProperties = new Set(['top', 'bottom', 'left', 'right']);

function propertyName(node: ESTree.MemberExpression): string | null {
	if (!node.computed && node.property.type === 'Identifier') return node.property.name;
	return node.property.type === 'Literal' && typeof node.property.value === 'string'
		? node.property.value
		: null;
}

function importedApi(
	sourceCode: SourceCode,
	node: ESTree.CallExpression['callee'],
	modules: readonly string[]
): string | null {
	const identifier = node.type === 'MemberExpression' ? node.object : node;
	if (identifier.type !== 'Identifier') return null;
	for (const definition of resolveVariable(sourceCode, identifier)?.defs ?? []) {
		if (definition.type !== 'ImportBinding' || definition.parent?.type !== 'ImportDeclaration') {
			continue;
		}
		if (!modules.includes(definition.parent.source.value.replace(/^node:/, ''))) continue;
		if (node.type === 'MemberExpression') {
			if (
				definition.node.type === 'ImportNamespaceSpecifier' ||
				definition.node.type === 'ImportDefaultSpecifier'
			) {
				return propertyName(node);
			}
		} else if (definition.node.type === 'ImportSpecifier') {
			return definition.node.imported.type === 'Identifier'
				? definition.node.imported.name
				: definition.node.imported.value;
		}
	}
	return null;
}

function isExpectCall(sourceCode: SourceCode, node: ESTree.Node): boolean {
	if (node.type !== 'CallExpression') return false;
	return (
		importedApi(sourceCode, node.callee, ['vitest', '@jest/globals']) === 'expect' ||
		(node.callee.type === 'Identifier' &&
			node.callee.name === 'expect' &&
			(resolveVariable(sourceCode, node.callee)?.defs.length ?? 0) === 0)
	);
}

function isAssertionMatcher(sourceCode: SourceCode, callee: ESTree.MemberExpression): boolean {
	let root = callee.object;
	while (root.type === 'MemberExpression' || root.type === 'ChainExpression') {
		root = root.type === 'MemberExpression' ? root.object : root.expression;
	}
	return isExpectCall(sourceCode, root);
}

function hasEqualityAssertion(sourceCode: SourceCode, node: ESTree.Node): boolean {
	for (let current: ESTree.Node = node; current.parent; current = current.parent) {
		if (!isExpectCall(sourceCode, current)) continue;
		let assertion: ESTree.Node = current;
		while (
			assertion.parent.type === 'MemberExpression' ||
			assertion.parent.type === 'ChainExpression'
		) {
			assertion = assertion.parent;
		}
		return (
			assertion.type === 'MemberExpression' &&
			assertion.parent.type === 'CallExpression' &&
			equalityMatchers.has(propertyName(assertion) ?? '')
		);
	}
	return false;
}

function resolveConstant(
	sourceCode: SourceCode,
	node: ESTree.Expression,
	visited = new Set<Variable>()
): ESTree.Expression {
	if (node.type !== 'Identifier') return node;
	const variable = resolveVariable(sourceCode, node);
	if (variable === null || visited.has(variable) || variable.defs.length !== 1) return node;
	const definition = variable.defs[0];
	if (
		definition.type !== 'Variable' ||
		definition.node.type !== 'VariableDeclarator' ||
		definition.node.init === null ||
		definition.node.parent.type !== 'VariableDeclaration' ||
		definition.node.parent.kind !== 'const'
	) {
		return node;
	}
	visited.add(variable);
	return resolveConstant(sourceCode, definition.node.init, visited);
}

function staticString(sourceCode: SourceCode, node: ESTree.Expression): string | null {
	node = resolveConstant(sourceCode, node);
	if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
	if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
		return node.quasis[0].value.cooked;
	}
	return null;
}

function staticPath(sourceCode: SourceCode, node: ESTree.Expression): string | null {
	node = resolveConstant(sourceCode, node);
	if (
		node.type === 'NewExpression' &&
		node.callee.type === 'Identifier' &&
		node.callee.name === 'URL'
	) {
		const path = node.arguments[0];
		return path && path.type !== 'SpreadElement' ? staticString(sourceCode, path) : null;
	}
	return staticString(sourceCode, node);
}

function isWholeSchema(
	sourceCode: SourceCode,
	node: ESTree.CallExpression['arguments'][number] | undefined
): boolean {
	if (!node || node.type === 'SpreadElement') return false;
	const resolved = resolveConstant(sourceCode, node);
	if (resolved.type !== 'ObjectExpression') return false;
	const keys = new Set(
		resolved.properties.flatMap((property) => {
			if (property.type !== 'Property') return [];
			if (property.key.type === 'Identifier' && !property.computed) return [property.key.name];
			return property.key.type === 'Literal' ? [property.key.value] : [];
		})
	);
	return keys.has('$schema') && keys.has('properties');
}

function isDomDetail(node: ESTree.MemberExpression): boolean {
	const name = propertyName(node) ?? '';
	return (
		domDetails.has(name) ||
		(positioningProperties.has(name) &&
			node.object.type === 'MemberExpression' &&
			propertyName(node.object) === 'style')
	);
}

function isDomCall(sourceCode: SourceCode, node: ESTree.CallExpression): boolean {
	if (node.callee.type !== 'MemberExpression') return false;
	const method = propertyName(node.callee);
	if (method === 'toHaveClass') return isAssertionMatcher(sourceCode, node.callee);
	const attribute = node.arguments[0];
	return (
		method === 'getAttribute' &&
		attribute?.type === 'Literal' &&
		attribute.value === 'class' &&
		hasEqualityAssertion(sourceCode, node)
	);
}

function isSchemaSnapshot(sourceCode: SourceCode, node: ESTree.CallExpression): boolean {
	const matcher = node.callee.type === 'MemberExpression' ? propertyName(node.callee) : null;
	if (
		(matcher === 'toEqual' || matcher === 'toStrictEqual') &&
		node.callee.type === 'MemberExpression' &&
		isAssertionMatcher(sourceCode, node.callee)
	) {
		return isWholeSchema(sourceCode, node.arguments[0]);
	}
	const assertion = importedApi(sourceCode, node.callee, ['assert', 'assert/strict']);
	return (
		(assertion === 'deepEqual' || assertion === 'deepStrictEqual') &&
		isWholeSchema(sourceCode, node.arguments[1])
	);
}

function isSourceRead(sourceCode: SourceCode, node: ESTree.CallExpression): boolean {
	const reader = importedApi(sourceCode, node.callee, ['fs', 'fs/promises']);
	if (reader !== 'readFile' && reader !== 'readFileSync') return false;
	const argument = node.arguments[0];
	if (!argument || argument.type === 'SpreadElement') return false;
	const path = staticPath(sourceCode, argument);
	return (
		path !== null &&
		/(?:\.(?:rs|[cm]?[jt]sx?)|(?:^|[\\/])SKILL\.md)$/.test(path) &&
		!/(?:^|[\\/])fixtures?[\\/]/.test(path)
	);
}

export const noImplementationDetailTestsRule = defineRule({
	meta: {
		type: 'problem',
		docs: {
			description:
				'Test behavior instead of repository source text, exact DOM styling, or copied whole schemas.'
		},
		messages: {
			sourceRead:
				'Exercise the implementation instead of reading its source text. Read test data from a fixture directory.',
			domEquality:
				'Assert user-visible behavior instead of exact CSS classes or inline positioning values. Verify appearance in the real app.',
			schemaSnapshot:
				'Assert the protocol constraints that matter instead of copying the whole generated schema.'
		}
	},
	createOnce(context) {
		return {
			MemberExpression(node) {
				if (isDomDetail(node) && hasEqualityAssertion(context.sourceCode, node)) {
					context.report({ node, messageId: 'domEquality' });
				}
			},
			CallExpression(node) {
				if (isDomCall(context.sourceCode, node)) {
					context.report({ node, messageId: 'domEquality' });
				}
				if (isSchemaSnapshot(context.sourceCode, node)) {
					context.report({ node, messageId: 'schemaSnapshot' });
				}
				if (isSourceRead(context.sourceCode, node)) {
					context.report({ node, messageId: 'sourceRead' });
				}
			}
		};
	}
});
