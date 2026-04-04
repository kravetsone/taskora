import type { StandardSchemaV1 } from "@standard-schema/spec";
import { ValidationError } from "./errors.js";

function normalizePath(
  path: ReadonlyArray<PropertyKey | StandardSchemaV1.PathSegment>,
): Array<string | number> {
  return path.map((segment) => {
    const key = typeof segment === "object" && "key" in segment ? segment.key : segment;
    return typeof key === "symbol" ? key.toString() : (key as string | number);
  });
}

export async function validateSchema<T>(
  schema: StandardSchemaV1<unknown, T>,
  data: unknown,
): Promise<T> {
  const result = await schema["~standard"].validate(data);

  if (result.issues) {
    const issues = result.issues.map((issue) => ({
      message: issue.message,
      path: issue.path ? normalizePath(issue.path) : undefined,
    }));
    throw new ValidationError("Validation failed", issues);
  }

  return result.value;
}
