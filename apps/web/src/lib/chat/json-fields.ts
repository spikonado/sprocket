import { isJsonBoolean, isJsonObject, isJsonString, type JsonValue } from '$convex/lib/json';

export function jsonString(value: JsonValue | undefined): string | undefined {
	return isJsonString(value) ? value : undefined;
}

export function jsonBoolean(value: JsonValue | undefined): boolean | undefined {
	return isJsonBoolean(value) ? value : undefined;
}

export function jsonObjectString(value: JsonValue | undefined, key: string): string | undefined {
	return isJsonObject(value) ? jsonString(value[key]) : undefined;
}
