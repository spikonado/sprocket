import type { ESTree, SourceCode } from '@oxlint/plugins';

import { resolveVariable } from '../../shared/scope.ts';

const equalityOperators = new Set(['==', '===', '!=', '!==']);
const broadEffectCatchMethods = new Set(['catch', 'catchAll', 'catchIf']);

export const isStringLiteral = (
	node: ESTree.Node | null | undefined
): node is ESTree.StringLiteral => node?.type === 'Literal' && typeof node.value === 'string';

export const isTagMember = (
	node: ESTree.Node | null | undefined
): node is ESTree.MemberExpression =>
	node?.type === 'MemberExpression' &&
	((!node.computed && node.property.type === 'Identifier' && node.property.name === '_tag') ||
		(node.computed && isStringLiteral(node.property) && node.property.value === '_tag'));

export const tagMemberFromComparison = (
	node: ESTree.BinaryExpression
): ESTree.MemberExpression | undefined => {
	if (!equalityOperators.has(node.operator)) return undefined;
	if (isTagMember(node.left) && isStringLiteral(node.right)) return node.left;
	if (isTagMember(node.right) && isStringLiteral(node.left)) return node.right;
	return undefined;
};

const isBroadEffectCatchCall = (
	node: ESTree.Node | null | undefined
): node is ESTree.CallExpression =>
	node?.type === 'CallExpression' &&
	node.callee.type === 'MemberExpression' &&
	node.callee.object.type === 'Identifier' &&
	node.callee.object.name === 'Effect' &&
	!node.callee.computed &&
	node.callee.property.type === 'Identifier' &&
	broadEffectCatchMethods.has(node.callee.property.name);

export const isInsideBroadEffectHandler = (
	node: ESTree.MemberExpression,
	sourceCode: SourceCode
): boolean => {
	const subject = isReasonTagMember(node) ? node.object.object : node.object;
	if (subject.type !== 'Identifier') return false;
	const variable = resolveVariable(sourceCode, subject);
	let current: ESTree.Node | null | undefined = node.parent;
	while (current !== null && current !== undefined) {
		if (current.type === 'ArrowFunctionExpression' || current.type === 'FunctionExpression') {
			const handler = current;
			return (
				isBroadEffectCatchCall(current.parent) &&
				current.parent.arguments.includes(current) &&
				current.parent.arguments.indexOf(current) === current.parent.arguments.length - 1 &&
				variable !== null &&
				variable.defs.some(
					(definition) =>
						definition.type === 'Parameter' &&
						definition.node === handler &&
						handler.params[0]?.type === 'Identifier' &&
						definition.name === handler.params[0]
				)
			);
		}
		current = current.parent;
	}
	return false;
};

export const isReasonTagMember = (
	node: ESTree.MemberExpression
): node is ESTree.MemberExpression & { object: ESTree.MemberExpression } =>
	node.object.type === 'MemberExpression' &&
	((!node.object.computed &&
		node.object.property.type === 'Identifier' &&
		node.object.property.name === 'reason') ||
		(node.object.computed &&
			isStringLiteral(node.object.property) &&
			node.object.property.value === 'reason'));

export const propertyName = (property: ESTree.ObjectProperty): string | undefined => {
	if (!property.computed && property.key.type === 'Identifier') {
		return property.key.name;
	}
	if (property.key.type === 'Literal' && typeof property.key.value === 'string') {
		return property.key.value;
	}
	return undefined;
};

export const isMatchPatternObject = (node: ESTree.ObjectExpression): boolean => {
	const call = node.parent;
	if (call?.type !== 'CallExpression' || !call.arguments.includes(node)) {
		return false;
	}
	const callee = call.callee;
	return (
		callee.type === 'MemberExpression' &&
		callee.object.type === 'Identifier' &&
		callee.object.name === 'Match' &&
		!callee.computed &&
		callee.property.type === 'Identifier' &&
		(callee.property.name === 'when' || callee.property.name === 'not')
	);
};
