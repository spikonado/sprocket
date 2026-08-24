import { v, type Validator } from 'convex/values';

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export type JsonObject = {
	[key: string]: JsonValue;
};

export function isJsonString<T>(value: T): value is Extract<T, string> {
	return Object.prototype.toString.call(value) === '[object String]' && !(value instanceof String);
}

export function isJsonNumber<T>(value: T): value is Extract<T, number> {
	return Object.prototype.toString.call(value) === '[object Number]' && !(value instanceof Number);
}

export function isJsonBoolean<T>(value: T): value is Extract<T, boolean> {
	return (
		Object.prototype.toString.call(value) === '[object Boolean]' && !(value instanceof Boolean)
	);
}

export function isJsonObject<T>(value: T): value is Extract<T, JsonObject> {
	return value !== null && value !== undefined && !Array.isArray(value) && Object(value) === value;
}

/** Expects values produced by JSON.parse. Raw runtime objects (Date, class instances) can pass vacuously and must not be sent through it. */
export function isJsonValue<T>(value: T): value is T & JsonValue {
	if (value === null || isJsonString(value) || isJsonNumber(value) || isJsonBoolean(value)) {
		return true;
	}
	if (Array.isArray(value)) {
		return value.every(isJsonValue);
	}
	if (value === undefined || Array.isArray(value) || Object(value) !== value) {
		return false;
	}
	// SAFETY: Object(value) === value with null/array excluded is a non-null object.
	const candidate = value as object;
	return Object.values(candidate).every(isJsonValue);
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
		// SAFETY: the depth-0 validator only accepts JSON primitives, which are JsonValue members.
		return vJsonPrimitive as Validator<JsonValue, 'required', string>;
	}
	// SAFETY: mirrors JsonValue up to JSON_VALIDATOR_DEPTH; deeper payloads are rejected by design.
	return v.union(
		vJsonPrimitive,
		v.array(jsonValidator(depth - 1)),
		v.record(v.string(), jsonValidator(depth - 1))
	) as Validator<JsonValue, 'required', string>;
}

export const vJsonValue = jsonValidator(JSON_VALIDATOR_DEPTH);
