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
