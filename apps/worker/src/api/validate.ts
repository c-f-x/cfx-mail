import { zValidator as honoZValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { core, ZodType } from "zod";

/**
 * The sentence to show a person for a failed validation: the first problem zod
 * found, starting with a capital letter and ending with a full stop. The field
 * path is left out; it names a JSON property, which means nothing to a reader.
 */
export function validationMessage(error: core.$ZodError): string {
  // zod reports at least one issue on every failed parse.
  const message = error.issues[0]!.message.trim();
  const sentence = message.charAt(0).toUpperCase() + message.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/**
 * `@hono/zod-validator` that answers a failure in the app's own error shape,
 * `{ error: "<sentence>" }` with status 400, instead of zod's error object.
 * Every route validates through this.
 */
export function zValidator<Schema extends ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: Schema,
) {
  return honoZValidator(target, schema, (result, c) => {
    if (!result.success) return c.json({ error: validationMessage(result.error) }, 400);
  });
}
