import { v, type Validator } from 'convex/values';

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export type JsonObject = {
	[key: string]: JsonValue;
};

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return (
		value !== null && value !== undefined && !Array.isArray(value) && typeof value === 'object'
	);
}

const vJsonPrimitive = v.union(v.string(), v.number(), v.boolean(), v.null());

/** Convex validators cannot be recursive, so JSON is unrolled to a fixed depth. */
const JSON_VALIDATOR_DEPTH = 8;

/**
 * Validator for arbitrary JSON values. Payloads nested deeper than
 * JSON_VALIDATOR_DEPTH are rejected at validate time (the former v.any()
 * accepted them); tool inputs/outputs and provider metadata are far shallower.
 */
function jsonValidator(depth: number): Validator<JsonValue, 'required', string> {
	if (depth === 0) {
		// Leaf depth collapses to primitives; cast bridges the unrolled union to JsonValue.
		return vJsonPrimitive as Validator<JsonValue, 'required', string>;
	}
	return v.union(
		vJsonPrimitive,
		v.array(jsonValidator(depth - 1)),
		v.record(v.string(), jsonValidator(depth - 1))
	) as Validator<JsonValue, 'required', string>;
}

export const vJsonValue = jsonValidator(JSON_VALIDATOR_DEPTH);
